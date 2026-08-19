import * as CodingAgent from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type YamlModule = {
	parse(text: string): any;
	stringify(value: any, options?: { lineWidth?: number }): string;
};

// `yaml` is only needed to read/write OMP's models.yml. When the package is
// installed via `pi install`, pi runs npm install so the dependency is present.
// But when this folder is copied manually into ~/.pi/agent/extensions/ the
// dependency may be missing — and a static `import ... from "yaml"` would crash
// the whole extension at load time. Load it lazily so the extension always
// starts; YAML configs then degrade to JSON, which is a valid YAML subset.
const requireFromHere = (() => {
	try {
		return createRequire(import.meta.url);
	} catch {
		return createRequire(join(process.cwd(), "index.ts"));
	}
})();
let yamlModule: YamlModule | undefined;
try {
	yamlModule = requireFromHere("yaml") as YamlModule;
} catch {
	yamlModule = undefined;
}

type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
type ProviderStyle = "openai" | "openai-responses" | "anthropic" | "ollama";
type ApiKeyMode = "env" | "literal" | "shell" | "none";
// pi's reasoning ceilings. "off" means no reasoning; the rest are the levels a
// model is allowed to use. See pi-ai getSupportedThinkingLevels.
type ReasoningCeiling = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_LEVELS: ReasoningCeiling[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Per-model knobs the wizard can write. apiKey lives at provider scope, not here.
type ModelOptions = {
	reasoning: ReasoningCeiling;
	vision: boolean;
	contextWindow?: number;
	maxTokens?: number;
	// When set, written verbatim instead of deriving a map from the ceiling. Used
	// when a probe learned the provider's exact thinking levels (effort options).
	thinkingLevelMap?: Record<string, string | null>;
};

// Best-effort model metadata detected while probing /models.
type ModelProbeInfo = {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
	alwaysThinking?: boolean; // reasoning exists but cannot be turned off
	effortOptions?: string[]; // provider reasoning-effort names (none/minimal/low/.../max)
	endpointTypes?: string[]; // New API / One API: supported_endpoint_types (chat, embeddings, ...)
	inferred?: boolean; // filled from the built-in model table, not the gateway
};

type ProbeResult = {
	items: ProbeItem[];
	infoById: Map<string, ModelProbeInfo>;
};

type ModelsConfig = {
	providers?: Record<string, any>;
};

type ProbeItem = {
	value: string;
	label: string;
	description?: string;
};

type SelectItem = {
	value: string;
	label: string;
	suffix?: string;
	description?: string;
	searchText?: string;
};

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

const AGENT_DIR = CodingAgent.getAgentDir();
const IS_OMP = "logger" in CodingAgent || /(^|[\\/])\.?omp([\\/]|$)/i.test(AGENT_DIR);
// OMP prefers YAML and still accepts legacy JSON; normal Pi uses JSON only.
const MODELS_JSON_PATH = (IS_OMP ? ["models.yml", "models.yaml", "models.json"] : ["models.json"])
	.map((name) => join(AGENT_DIR, name))
	.find(existsSync) ?? join(AGENT_DIR, IS_OMP ? "models.yml" : "models.json");
const IS_YAML_CONFIG = /\.ya?ml$/i.test(MODELS_JSON_PATH);
const BUILTIN_PROVIDER_IDS = new Set([
	"anthropic",
	"openai",
	"azure-openai",
	"google",
	"vertex",
	"bedrock",
	"mistral",
	"groq",
	"cerebras",
	"xai",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"huggingface",
	"kimi-for-coding",
	"minimax",
	"ollama",
]);

function ensureConfigDir() {
	mkdirSync(dirname(MODELS_JSON_PATH), { recursive: true });
}

function loadModelsConfig(): ModelsConfig {
	ensureConfigDir();
	if (!existsSync(MODELS_JSON_PATH)) {
		return { providers: {} };
	}

	const raw = readFileSync(MODELS_JSON_PATH, "utf8").trim();
	if (!raw) return { providers: {} };

	const parsed = (IS_YAML_CONFIG ? parseYamlConfig(raw) : JSON.parse(raw)) as ModelsConfig;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("models config must be an object");
	}
	if (!parsed.providers || typeof parsed.providers !== "object") {
		parsed.providers = {};
	}
	return parsed;
}

// Parse a models.yml. Prefers the yaml package; when it is missing (folder
// copied into ~/.pi/agent/extensions/ without npm install) JSON is accepted,
// because JSON is a valid YAML subset. Genuine YAML gets a clear error instead
// of corrupting the file.
function parseYamlConfig(raw: string): any {
	if (yamlModule) return yamlModule.parse(raw);
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(
			`${MODELS_JSON_PATH} is YAML, but the "yaml" package is not installed. ` +
				'Run "npm install" in the better-custom folder, or reinstall the extension with "pi install", to edit YAML configs.',
		);
	}
}

function saveModelsConfig(config: ModelsConfig) {
	ensureConfigDir();
	let content: string;
	if (IS_YAML_CONFIG) {
		content = yamlModule
			? yamlModule.stringify(config, { lineWidth: 0 })
			: // JSON is valid YAML — writing it keeps OMP/pi able to load the config
				// even when the yaml package is unavailable.
				JSON.stringify(config, null, 2);
	} else {
		content = JSON.stringify(config, null, 2);
	}
	writeFileSync(MODELS_JSON_PATH, `${content.trimEnd()}\n`, "utf8");
}

function hasExplicitScheme(input: string): boolean {
	return /^[a-z]+:\/\//i.test(input.trim());
}

function addDefaultScheme(input: string): string {
	if (hasExplicitScheme(input)) return input;
	const lower = input.toLowerCase();
	const isLocal =
		lower.startsWith("localhost") ||
		lower.startsWith("127.") ||
		lower.startsWith("0.0.0.0") ||
		lower.startsWith("10.") ||
		lower.startsWith("192.168.") ||
		lower.startsWith("172.16.") ||
		lower.startsWith("172.17.") ||
		lower.startsWith("172.18.") ||
		lower.startsWith("172.19.") ||
		lower.startsWith("172.20.") ||
		lower.startsWith("172.21.") ||
		lower.startsWith("172.22.") ||
		lower.startsWith("172.23.") ||
		lower.startsWith("172.24.") ||
		lower.startsWith("172.25.") ||
		lower.startsWith("172.26.") ||
		lower.startsWith("172.27.") ||
		lower.startsWith("172.28.") ||
		lower.startsWith("172.29.") ||
		lower.startsWith("172.30.") ||
		lower.startsWith("172.31.") ||
		lower.startsWith("[");
	return `${isLocal ? "http" : "https"}://${input}`;
}

function stripSuffix(pathname: string, suffix: string): string {
	return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) || "/" : pathname;
}

function normalizeEndpoint(input: string, api: ProviderApi): string {
	const url = new URL(addDefaultScheme(input.trim()));
	let pathname = url.pathname.replace(/\/+$/, "") || "/";

	if (api === "openai-completions" || api === "openai-responses") {
		pathname = stripSuffix(pathname, "/chat/completions");
		pathname = stripSuffix(pathname, "/responses");
		pathname = stripSuffix(pathname, "/completions");
		pathname = stripSuffix(pathname, "/models");
	} else {
		pathname = stripSuffix(pathname, "/messages");
	}

	pathname = pathname === "/" ? "" : pathname;
	const port = url.port ? `:${url.port}` : "";
	return `${url.protocol}//${url.hostname}${port}${pathname}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-");
}

function suggestProviderId(endpoint: string): string {
	const url = new URL(addDefaultScheme(endpoint));
	const host = url.hostname.replace(/^www\./, "").replace(/^api\./, "");
	const hostSlug = slugify(`${host}${url.port ? `-${url.port}` : ""}`) || "provider";
	return `custom-${hostSlug}`;
}

function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

function buildProbeUrl(baseUrl: string): string {
	const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL("models", withSlash).toString();
}

const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 4000;

function resolveApiKeyForProbe(mode: ApiKeyMode, storedValue?: string): string | undefined {
	if (!storedValue || mode === "none") return undefined;
	if (mode === "literal") return storedValue;
	if (mode === "env") return process.env[storedValue]?.trim() || undefined;
	if (mode === "shell") {
		try {
			return execSync(storedValue, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function serializeApiKey(mode: ApiKeyMode, value?: string, style?: ProviderStyle): string | undefined {
	if (mode === "none") return style === "ollama" ? "ollama" : "dummy";
	if (!value) return undefined;
	// pi resolves an apiKey by prefix: "!cmd" runs a shell command, "$VAR" reads an
	// env var, anything else is a literal. See pi-ai resolve-config-value.
	if (mode === "shell") return value.startsWith("!") ? value : `!${value}`;
	if (mode === "env") return value.startsWith("$") ? value : `$${value}`;
	return value;
}

async function probeOpenAIModels(baseUrl: string, apiKeyMode: ApiKeyMode, apiKeyValue?: string): Promise<ProbeResult> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"accept-encoding": "identity",
	};
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (resolvedKey) {
		headers.authorization = `Bearer ${resolvedKey}`;
	}

	const response = await fetch(buildProbeUrl(baseUrl), { headers });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Probe failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 200)}` : ""}`);
	}

	const json = (await response.json()) as any;
	const rawModels = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
	const infoById = new Map<string, ModelProbeInfo>();
	const ids = dedupe(
		rawModels
			.map((item: any) => {
				if (typeof item?.id !== "string" || !item.id.trim()) return "";
				const id = item.id.trim();
				// Some /models lists carry metadata inline (OpenRouter, OpenModels,
				// Epithre, ...). Capture it so the picker can show details without an
				// extra round-trip per model.
				const info = parseModelListItem(item);
				if (info) infoById.set(id, info);
				return id;
			})
			.filter(Boolean),
	).sort((a, b) => a.localeCompare(b));

	return {
		items: ids.map((id) => ({ value: id, label: id, description: describeProbeInfo(infoById.get(id)) })),
		infoById,
	};
}

function getPath(obj: any, path: string): any {
	let current = obj;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = current[key];
	}
	return current;
}

function firstFiniteNumber(obj: any, ...paths: string[]): number | undefined {
	for (const path of paths) {
		const value = getPath(obj, path);
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

// Human-readable list of the metadata fields actually present in a probe result.
function probeInfoSummary(info: ModelProbeInfo | undefined): string[] {
	if (!info) return [];
	const parts: string[] = [];
	if (info.contextWindow !== undefined) parts.push("context");
	if (info.maxTokens !== undefined) parts.push("max tokens");
	if (info.reasoning !== undefined) parts.push("reasoning");
	if (info.vision !== undefined) parts.push("vision");
	return parts;
}

// Whether a probe result carries anything worth surfacing (including gateway
// endpoint types, which don't count as "detected metadata" for the summary).
function hasProbeInfo(info: ModelProbeInfo | undefined): boolean {
	if (!info) return false;
	return probeInfoSummary(info).length > 0 || (info.endpointTypes !== undefined && info.endpointTypes.length > 0);
}

function describeProbeInfo(info: ModelProbeInfo | undefined): string | undefined {
	if (!info) return undefined;
	const parts: string[] = [];
	if (info.contextWindow !== undefined) parts.push(`ctx ${info.contextWindow}`);
	if (info.maxTokens !== undefined) parts.push(`max ${info.maxTokens}`);
	if (info.vision !== undefined) parts.push(info.vision ? "vision" : "text-only");
	if (info.reasoning === true) parts.push(info.alwaysThinking ? "reasoning (always on)" : "reasoning");
	else if (info.reasoning === false) parts.push("no reasoning");
	if (info.endpointTypes && info.endpointTypes.length > 0) parts.push(info.endpointTypes.join("/"));
	return parts.length > 0 ? parts.join(" • ") : undefined;
}

// One API / New API gateways (and their forks) attach extra model metadata
// under "meta": { context_window, max_tokens, capabilities: { vision,
// reasoning, ... }, supports_vision, supports_reasoning }. Fills only fields
// that are still unknown, so OpenRouter/OpenAI-style data wins when both exist.
function parseGatewayMetaFields(source: any, info: ModelProbeInfo): void {
	const meta = source?.meta;
	if (!meta || typeof meta !== "object") return;
	if (info.contextWindow === undefined) {
		const contextWindow = firstFiniteNumber(meta, "context_window", "max_input_tokens");
		if (contextWindow !== undefined) info.contextWindow = contextWindow;
	}
	if (info.maxTokens === undefined) {
		const maxTokens = firstFiniteNumber(meta, "max_output_tokens", "max_tokens");
		if (maxTokens !== undefined) info.maxTokens = maxTokens;
	}
	const capabilities = meta.capabilities;
	if (capabilities && typeof capabilities === "object") {
		if (info.vision === undefined && typeof capabilities.vision === "boolean") info.vision = capabilities.vision;
		if (info.reasoning === undefined && typeof capabilities.reasoning === "boolean") info.reasoning = capabilities.reasoning;
		if (info.reasoning === undefined && typeof capabilities.thinking === "boolean") info.reasoning = capabilities.thinking;
	}
	if (info.vision === undefined && typeof meta.supports_vision === "boolean") info.vision = meta.supports_vision;
	if (info.reasoning === undefined && typeof meta.supports_reasoning === "boolean") info.reasoning = meta.supports_reasoning;
}

// Inline metadata carried by some /models list entries (OpenRouter, OpenModels,
// Epithre, One API / New API, ...). Returns undefined when the entry is bare.
function parseModelListItem(item: any): ModelProbeInfo | undefined {
	if (!item || typeof item !== "object") return undefined;
	const info: ModelProbeInfo = {};

	const contextWindow = firstFiniteNumber(item, "context_length", "context_window", "max_input_tokens");
	if (contextWindow !== undefined) info.contextWindow = contextWindow;
	const maxTokens = firstFiniteNumber(item, "max_output_tokens", "max_tokens", "top_provider.max_completion_tokens");
	if (maxTokens !== undefined) info.maxTokens = maxTokens;
	if (typeof item.reasoning === "boolean") info.reasoning = item.reasoning;

	const modalities = Array.isArray(item.architecture?.input_modalities)
		? item.architecture.input_modalities
		: Array.isArray(item.modalities)
			? item.modalities
			: undefined;
	if (modalities) info.vision = modalities.includes("image");

	if (Array.isArray(item.capabilities)) {
		if (info.reasoning === undefined) info.reasoning = item.capabilities.includes("thinking") || item.capabilities.includes("reasoning");
		if (info.vision === undefined) info.vision = item.capabilities.includes("vision");
	}

	// New API's /v1/models entries carry supported_endpoint_types
	// (e.g. ["chat"] or ["chat", "embeddings"]).
	if (Array.isArray(item.supported_endpoint_types)) {
		const types = item.supported_endpoint_types.filter((t: unknown): t is string => typeof t === "string");
		if (types.length > 0) info.endpointTypes = types;
	}

	parseGatewayMetaFields(item, info);

	return hasProbeInfo(info) ? info : undefined;
}

// Metadata from GET /models/{id} (OpenAI and compatible servers).
function parseOpenAIModelDetail(json: any): ModelProbeInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const info: ModelProbeInfo = {};

	const contextWindow = firstFiniteNumber(json, "context_window");
	if (contextWindow !== undefined) info.contextWindow = contextWindow;
	const maxTokens = firstFiniteNumber(json, "max_output_tokens");
	if (maxTokens !== undefined) info.maxTokens = maxTokens;

	const capabilities = json.capabilities;
	if (capabilities && typeof capabilities === "object") {
		if (
			capabilities.vision &&
			typeof capabilities.vision === "object" &&
			typeof capabilities.vision.supported === "boolean"
		) {
			info.vision = capabilities.vision.supported;
		}
		const reasoning = capabilities.reasoning;
		if (reasoning && typeof reasoning === "object") {
			const type = typeof reasoning.type === "string" ? reasoning.type : "";
			if (type === "none") {
				info.reasoning = false;
			} else if (type === "minimal") {
				// Thinking exists but cannot be turned off.
				info.reasoning = true;
				info.alwaysThinking = true;
			} else if (type === "effort") {
				info.reasoning = true;
				if (Array.isArray(reasoning.effort_options)) {
					info.effortOptions = reasoning.effort_options.filter((option: unknown): option is string => typeof option === "string");
				}
			}
		}
	}

	// One API / New API gateways may also carry the extra "meta" object on
	// GET /models/{id} responses.
	parseGatewayMetaFields(json, info);

	return probeInfoSummary(info).length > 0 ? info : undefined;
}

// Metadata from a LiteLLM proxy's GET /model/info — one call returns
// model_info for every configured model (context_window, max_tokens,
// supports_vision, supports_reasoning, ...). Returns true when the response
// looked like a LiteLLM /model/info payload and filled at least one entry.
function parseLiteLLMModelInfo(json: any, out: Map<string, ModelProbeInfo>): boolean {
	if (!json || typeof json !== "object") return false;
	// /model/info returns { data: [...] }; tolerate a nested { data: { data: [...] } }
	const entries = Array.isArray(json.data)
		? json.data
		: Array.isArray(json?.data?.data)
			? json.data.data
			: [];
	if (entries.length === 0) return false;
	let found = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.model_name === "string" ? entry.model_name.trim() : "";
		const info = entry.model_info;
		if (!name || !info || typeof info !== "object") continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(info, "context_window", "max_input_tokens");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		const maxTokens = firstFiniteNumber(info, "max_output_tokens", "max_tokens");
		if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
		if (typeof info.supports_vision === "boolean") parsed.vision = info.supports_vision;
		if (typeof info.supports_reasoning === "boolean") parsed.reasoning = info.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			out.set(name, parsed);
			found = true;
		}
	}
	return found;
}

// Fetch GET /models/{id} for each picked model to learn context_window,
// max_output_tokens, and capabilities. Best effort: servers that don't expose
// per-model details simply leave those fields unset.
async function enrichOpenAIModelDetails(
	baseUrl: string,
	apiKeyMode: ApiKeyMode,
	apiKeyValue: string | undefined,
	ids: string[],
): Promise<Map<string, ModelProbeInfo>> {
	const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity" };
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (resolvedKey) headers.authorization = `Bearer ${resolvedKey}`;

	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const out = new Map<string, ModelProbeInfo>();

	// LiteLLM proxy: GET /model/info returns metadata for every model in one
	// call, which is far cheaper than per-model fetches (and LiteLLM's
	// /models/{id} has no metadata at all). Fall back to per-model fetches when
	// the server doesn't expose it.
	{
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		let response: Response | undefined;
		try {
			response = await fetch(new URL("model/info", base).toString(), { headers, signal: controller.signal });
		} catch {
			// network error — treat as not-a-LiteLLM and fall through
		} finally {
			clearTimeout(timer);
		}
		if (response?.ok) {
			const json = await response.json().catch(() => null);
			if (parseLiteLLMModelInfo(json, out)) return out;
		}
	}

	let cursor = 0;
	async function worker() {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
				const response = await fetch(new URL(`models/${encodeURIComponent(id)}`, base).toString(), {
					headers,
					signal: controller.signal,
				});
				clearTimeout(timer);
				if (!response.ok) continue;
				const json = await response.json().catch(() => null);
				const info = parseOpenAIModelDetail(json);
				if (info) out.set(id, info);
			} catch {
				// Best effort — skip models the server can't describe.
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, ids.length)) }, worker));
	return out;
}

// Derive the native Ollama API root from an OpenAI-compatible baseUrl
// (http://host:11434/v1 -> http://host:11434).
function ollamaNativeRoot(baseUrl: string): string | null {
	try {
		const url = new URL(baseUrl);
		const pathname = url.pathname.replace(/\/+$/, "");
		if (pathname.endsWith("/v1")) url.pathname = pathname.slice(0, -3) || "/";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

// Ollama exposes native metadata: GET /api/tags (capabilities) and
// POST /api/show (context_length via model_info).
async function enrichOllamaModelDetails(
	baseUrl: string,
	apiKeyMode: ApiKeyMode,
	apiKeyValue: string | undefined,
	ids: string[],
): Promise<Map<string, ModelProbeInfo>> {
	const root = ollamaNativeRoot(baseUrl);
	if (!root) return new Map();
	const out = new Map<string, ModelProbeInfo>();

	const headers: Record<string, string> = { accept: "application/json" };
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (resolvedKey) headers.authorization = `Bearer ${resolvedKey}`;

	try {
		const response = await fetch(`${root}/api/tags`, { headers });
		if (response.ok) {
			const json = await response.json().catch(() => null);
			for (const model of Array.isArray(json?.models) ? json.models : []) {
				const name = typeof model?.name === "string" ? model.name.trim() : "";
				if (!name) continue;
				const info: ModelProbeInfo = {};
				if (Array.isArray(model.capabilities)) info.vision = model.capabilities.includes("vision");
				if (Object.keys(info).length > 0) out.set(name, info);
			}
		}
	} catch {
		// Not an Ollama server; skip native probing entirely.
	}

	let cursor = 0;
	async function worker() {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
				const response = await fetch(`${root}/api/show`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({ name: id }),
					signal: controller.signal,
				});
				clearTimeout(timer);
				if (!response.ok) continue;
				const json = await response.json().catch(() => null);
				const info: ModelProbeInfo = { ...(out.get(id) ?? {}) };
				const modelInfo = json?.model_info;
				if (modelInfo && typeof modelInfo === "object") {
					for (const [key, value] of Object.entries(modelInfo)) {
						if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
							info.contextWindow = value;
						}
					}
				}
				if (Array.isArray(json?.capabilities)) info.vision = json.capabilities.includes("vision");
				out.set(id, info);
			} catch {
				// Best effort.
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, ids.length)) }, worker));
	return out;
}

function normalizeSelectItems(items: Array<string | SelectItem>): SelectItem[] {
	return items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
}

async function selectOne(
	ctx: CommandContext,
	title: string,
	items: Array<string | SelectItem>,
	options?: { initialIndex?: number },
): Promise<string | null> {
	const normalizedItems = normalizeSelectItems(items);
	if (normalizedItems.length === 0) return null;

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let cursor = Math.max(0, Math.min(options?.initialIndex ?? 0, normalizedItems.length - 1));
		let query = "";
		let cachedLines: string[] | undefined;
		const maxVisible = 12;

		function getVisibleItems() {
			const lowerQuery = query.trim().toLowerCase();
			if (!lowerQuery) return normalizedItems;
			return normalizedItems.filter((item) => {
				const haystack = `${item.label} ${item.suffix ?? ""} ${item.description ?? ""} ${item.searchText ?? ""}`.toLowerCase();
				return haystack.includes(lowerQuery);
			});
		}

		function refresh() {
			const visibleItems = getVisibleItems();
			if (visibleItems.length === 0) cursor = 0;
			else if (cursor >= visibleItems.length) cursor = visibleItems.length - 1;
			cachedLines = undefined;
			tui.requestRender();
		}

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;

				const visibleItems = getVisibleItems();
				const safeWidth = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));
				const border = theme.fg("accent", "─".repeat(safeWidth));

				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add(` ${theme.fg("text", `Search: ${query || "-"}`)}`);
				add();

				if (visibleItems.length === 0) {
					add(theme.fg("warning", " No matches."));
				} else {
					const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, visibleItems.length - maxVisible)));
					const end = Math.min(visibleItems.length, start + maxVisible);

					for (let i = start; i < end; i++) {
						const item = visibleItems[i];
						const active = i === cursor;
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						const label = active ? theme.fg("accent", item.label) : theme.fg("text", item.label);
						const suffix = item.suffix ? theme.fg("dim", item.suffix) : "";
						add(`${prefix}${label}${suffix}`);
						if (item.description) {
							for (const line of item.description.split("\n")) {
								add(`   ${theme.fg("muted", line)}`);
							}
						}
					}

					if (visibleItems.length > maxVisible) {
						add();
						add(theme.fg("dim", ` ${start + 1}-${end} of ${visibleItems.length}`));
					}
				}

				add();
				add(theme.fg("dim", " Type to search • ↑↓ move (wraps) • enter confirm • backspace delete • esc cancel"));
				add(border);

				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				const visibleItems = getVisibleItems();
				if (matchesKey(data, Key.up)) {
					if (visibleItems.length === 0) return;
					cursor = cursor === 0 ? visibleItems.length - 1 : cursor - 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (visibleItems.length === 0) return;
					cursor = cursor === visibleItems.length - 1 ? 0 : cursor + 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const item = visibleItems[cursor];
					done(item?.value ?? null);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (data === "\u007f" || data === "\b") {
					if (query.length > 0) {
						query = query.slice(0, -1);
						refresh();
					}
					return;
				}
				if (data >= " " && data !== "\u001b" && data !== "\r" && data !== "\n") {
					query += data;
					cursor = 0;
					refresh();
				}
			},
		};
	});
}

async function pickMany(
	ctx: CommandContext,
	title: string,
	items: ProbeItem[],
): Promise<string[] | null> {
	return await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		let query = "";
		const selected = new Set<string>();
		let cachedLines: string[] | undefined;
		const maxVisible = 12;

		function getVisibleItems() {
			const lowerQuery = query.trim().toLowerCase();
			if (!lowerQuery) return items;
			return items.filter((item) => {
				const haystack = `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase();
				return haystack.includes(lowerQuery);
			});
		}

		function refresh() {
			const visibleItems = getVisibleItems();
			if (visibleItems.length === 0) cursor = 0;
			else if (cursor >= visibleItems.length) cursor = visibleItems.length - 1;
			cachedLines = undefined;
			tui.requestRender();
		}

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;

				const visibleItems = getVisibleItems();
				const safeWidth = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));
				const border = theme.fg("accent", "─".repeat(safeWidth));

				add(border);
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add(` ${theme.fg("text", `Search: ${query || "-"}`)}`);
				add(` ${theme.fg("muted", `${selected.size} selected • ${visibleItems.length}/${items.length} shown`)}`);
				add();

				if (visibleItems.length === 0) {
					add(theme.fg("warning", " No matching models."));
				} else {
					const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, visibleItems.length - maxVisible)));
					const end = Math.min(visibleItems.length, start + maxVisible);

					for (let i = start; i < end; i++) {
						const item = visibleItems[i];
						const active = i === cursor;
						const checked = selected.has(item.value);
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						const box = checked ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
						const label = active ? theme.fg("accent", item.label) : theme.fg("text", item.label);
						const desc = item.description ? ` ${theme.fg("muted", item.description.replace(/\s*\n\s*/g, " "))}` : "";
						add(`${prefix}${box} ${label}${desc}`);
					}

					if (visibleItems.length > maxVisible) {
						add();
						add(theme.fg("dim", ` ${start + 1}-${end} of ${visibleItems.length}`));
					}
				}

				add();
				add(theme.fg("dim", " Type to search • ↑↓ move (wraps) • space toggle • enter confirm • backspace delete • esc cancel"));
				if (selected.size === 0) {
					add(theme.fg("warning", " Select at least one model before confirming."));
				}
				add(border);

				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				const visibleItems = getVisibleItems();
				if (matchesKey(data, Key.up)) {
					if (visibleItems.length === 0) return;
					cursor = cursor === 0 ? visibleItems.length - 1 : cursor - 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (visibleItems.length === 0) return;
					cursor = cursor === visibleItems.length - 1 ? 0 : cursor + 1;
					refresh();
					return;
				}
				if (data === " ") {
					const value = visibleItems[cursor]?.value;
					if (!value) return;
					if (selected.has(value)) selected.delete(value);
					else selected.add(value);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (selected.size > 0) done(Array.from(selected));
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (data === "\u007f" || data === "\b") {
					if (query.length > 0) {
						query = query.slice(0, -1);
						refresh();
					}
					return;
				}
				if (data >= " " && data !== "\u001b" && data !== "\r" && data !== "\n") {
					query += data;
					cursor = 0;
					refresh();
				}
			},
		};
	});
}

async function promptApiKey(
	ctx: CommandContext,
): Promise<{ mode: ApiKeyMode; value?: string } | null> {
	const choice = await selectOne(ctx, "API key", [
		{ value: "literal", label: "API key", description: "Stored verbatim in the active models config" },
		{ value: "none", label: "None", description: "No key; a placeholder is written so the provider still loads" },
	]);
	if (!choice) return null;
	if (choice === "none") return { mode: "none" };

	const value = await ctx.ui.input("API key", "saved directly in the active models config");
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return { mode: "none" };
	return { mode: "literal", value: trimmed };
}

function reasoningLabel(level: ReasoningCeiling): string {
	if (level === "off") return "Off - no reasoning";
	if (level === "xhigh") return "xhigh - maximum (only if the model supports it)";
	if (level === "max") return "max - maximum (only if the model supports it)";
	return `${level} - cap reasoning at ${level}`;
}

// Prompts for a reasoning ceiling. Returns null if cancelled.
async function promptReasoning(ctx: CommandContext, current?: ReasoningCeiling): Promise<ReasoningCeiling | null> {
	const items: SelectItem[] = REASONING_LEVELS.map((level) => ({
		value: level,
		label: reasoningLabel(level),
	}));
	const initialIndex = current ? REASONING_LEVELS.indexOf(current) : 0;
	const choice = await selectOne(ctx, "Reasoning", items, { initialIndex: Math.max(0, initialIndex) });
	return (choice as ReasoningCeiling | null) ?? null;
}

// When a model is capped at xhigh or max, some providers name that level
// differently (e.g. "max"). Offer an optional override for the provider-facing string.
async function promptCeilingProviderString(ctx: CommandContext, level: "xhigh" | "max", current?: string): Promise<string | undefined> {
	const value = await ctx.ui.input(
		`${level} provider value (blank = ${level})`,
		current && current !== level ? `current: ${current}` : `e.g. max (leave blank to send "${level}")`,
	);
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

async function promptVision(ctx: CommandContext, current?: boolean): Promise<boolean | null> {
	const choice = await selectOne(ctx, "Image input (vision)", [
		{ value: "yes", label: "Yes - send text + images", description: "Sets input: [text, image]" },
		{ value: "no", label: "No - text only", description: "Sets input: [text]" },
	], { initialIndex: current === false ? 1 : 0 });
	if (!choice) return null;
	return choice === "yes";
}

// Prompts for a context window size in tokens. Returns:
//   number  -> set/replace contextWindow
//   0       -> clear contextWindow (user typed 0)
//   null    -> cancelled, leave unchanged
async function promptContextWindow(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Context window (tokens)",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 128000 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed.replace(/[_,]/g, ""), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// Prompts for max output tokens. Same return contract as promptContextWindow:
// number to set, 0 to clear, null to leave unchanged.
async function promptMaxTokens(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Max output tokens",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 8192 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed.replace(/[_,]/g, ""), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// Read the reasoning ceiling + vision flags already stored on a model entry,
// mirroring pi's getSupportedThinkingLevels so edit defaults match reality.
function readModelOptions(model: any): ModelOptions {
	const vision = Array.isArray(model?.input) ? model.input.includes("image") : true;
	const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
	const maxTokens = typeof model?.maxTokens === "number" ? model.maxTokens : undefined;
	if (!model || model.reasoning !== true) return { reasoning: "off", vision, contextWindow, maxTokens };

	const map = model.thinkingLevelMap;
	let ceiling: ReasoningCeiling = "high";
	if (map && typeof map === "object") {
		if (map.max !== undefined && map.max !== null) {
			ceiling = "max";
		} else if (map.xhigh !== undefined && map.xhigh !== null) {
			ceiling = "xhigh";
		} else {
			for (let i = REASONING_LEVELS.length - 1; i >= 1; i--) {
				const level = REASONING_LEVELS[i];
				if (level === "xhigh" || level === "max") continue;
				if (map[level] === null) continue;
				ceiling = level;
				break;
			}
		}
	}
	return { reasoning: ceiling, vision, contextWindow, maxTokens };
}

function readCeilingString(model: any, level: "xhigh" | "max"): string | undefined {
	const v = model?.thinkingLevelMap?.[level];
	return typeof v === "string" ? v : undefined;
}

async function promptModelIdsOneByOne(
	ctx: CommandContext,
	style: ProviderStyle,
): Promise<string[] | null> {
	const modelIds: string[] = [];
	const firstPlaceholder =
		style === "anthropic"
			? "e.g. claude-sonnet-4-5 (blank to finish)"
			: style === "ollama"
				? "e.g. llama3.1:8b or qwen2.5-coder:7b (blank to finish)"
				: "e.g. gpt-4o-mini or qwen/qwen3-coder (blank to finish)";
	const nextPlaceholder =
		style === "anthropic"
			? "another Anthropic-style model id (blank to finish)"
			: style === "ollama"
				? "another Ollama model id (blank to finish)"
				: "another OpenAI-style model id (blank to finish)";

	while (true) {
		const value = await ctx.ui.input(modelIds.length === 0 ? "Model id" : "Add another model id", modelIds.length === 0 ? firstPlaceholder : nextPlaceholder);
		if (value === undefined) return null;
		const trimmed = value.trim();
		if (!trimmed) {
			if (modelIds.length === 0) {
				ctx.ui.notify("Add at least one model.", "warning");
				continue;
			}
			return modelIds;
		}
		if (modelIds.includes(trimmed)) {
			ctx.ui.notify(`Model already added: ${trimmed}`, "warning");
			continue;
		}
		modelIds.push(trimmed);
	}
}

// Provider reasoning-effort option names mapped onto pi thinking levels.
const EFFORT_ALIASES: Record<string, string> = {
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	extended: "xhigh",
};

// Map provider reasoning-effort options onto pi thinking levels. Levels the
// provider doesn't name are hidden with null.
function buildThinkingMapFromEffortOptions(options: string[]): Record<string, string | null> {
	const supported = new Map<string, string>();
	for (const raw of options) {
		const option = raw.trim();
		const level = EFFORT_ALIASES[option.toLowerCase()];
		if (level && !supported.has(level)) supported.set(level, option);
	}
	const map: Record<string, string | null> = {};
	for (const level of PI_THINKING_LEVELS) {
		map[level] = supported.get(level) ?? null;
	}
	return map;
}

function ceilingFromThinkingMap(map: Record<string, string | null>): ReasoningCeiling {
	for (let i = PI_THINKING_LEVELS.length - 1; i >= 1; i--) {
		const level = PI_THINKING_LEVELS[i];
		if (map[level] !== undefined && map[level] !== null) return level as ReasoningCeiling;
	}
	return "off";
}

// Turn probe metadata into model knobs. Fields the probe couldn't determine fall
// back to the wizard's defaults (reasoning on at the xhigh ceiling, text+image).
function modelOptionsFromProbe(info: ModelProbeInfo | undefined, fallback: ModelOptions): ModelOptions {
	if (!info) return fallback;
	const opts: ModelOptions = {
		reasoning: fallback.reasoning,
		vision: info.vision ?? fallback.vision,
		contextWindow: info.contextWindow ?? fallback.contextWindow,
		maxTokens: info.maxTokens,
	};

	if (info.reasoning === false) {
		opts.reasoning = "off";
	} else if (info.reasoning === true) {
		if (info.alwaysThinking) {
			// Thinking exists but cannot be disabled — hide "off" from the UI.
			opts.reasoning = "minimal";
			opts.thinkingLevelMap = { off: null };
		} else if (info.effortOptions && info.effortOptions.length > 0) {
			const map = buildThinkingMapFromEffortOptions(info.effortOptions);
			opts.reasoning = ceilingFromThinkingMap(map);
			opts.thinkingLevelMap = map;
		}
		// reasoning === true with no level info: keep the wizard's default ceiling.
	}
	return opts;
}

// Apply a reasoning ceiling to an entry in place, preserving other fields.
// Mirrors pi's getSupportedThinkingLevels: off/minimal/low/medium/high are on
// by default when reasoning is true; xhigh/max are available ONLY if explicitly
// mapped; any level set to null is removed. So we only need a map to (a) unlock
// xhigh/max, or (b) cap below high by nulling the higher levels.
function applyReasoning(entry: any, ceiling: ReasoningCeiling, ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>) {
	if (ceiling === "off") {
		delete entry.reasoning;
		delete entry.thinkingLevelMap;
		return;
	}
	entry.reasoning = true;
	const ceilingIndex = REASONING_LEVELS.indexOf(ceiling);
	const map: Record<string, string | null> = {};
	for (const level of REASONING_LEVELS) {
		if (level === "off") continue;
		const index = REASONING_LEVELS.indexOf(level);
		if (level === "xhigh" || level === "max") {
			// Opt-in levels: only appear when the ceiling reaches them.
			if (ceilingIndex >= index) map[level] = ceilingOverrides?.[level]?.trim() || level;
		} else if (index > ceilingIndex) {
			map[level] = null;
		}
	}
	if (Object.keys(map).length > 0) entry.thinkingLevelMap = map;
	else delete entry.thinkingLevelMap;
}

function buildModelEntry(
	id: string,
	opts: ModelOptions,
	ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>,
): any {
	const entry: any = {
		id,
		// Default to text+image so pi forwards images upstream. Without this,
		// custom models default to text-only and images are silently dropped.
		input: opts.vision ? ["text", "image"] : ["text"],
	};

	if (typeof opts.contextWindow === "number" && opts.contextWindow > 0) {
		entry.contextWindow = opts.contextWindow;
	}
	if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) {
		entry.maxTokens = opts.maxTokens;
	}

	if (opts.thinkingLevelMap) {
		// The probe knew the provider's exact thinking levels (e.g. OpenAI
		// effort_options) — write that map verbatim instead of deriving one.
		entry.reasoning = true;
		entry.thinkingLevelMap = opts.thinkingLevelMap;
	} else {
		applyReasoning(entry, opts.reasoning, ceilingOverrides);
	}
	return entry;
}

function buildProviderConfig(
	style: ProviderStyle,
	api: ProviderApi,
	baseUrl: string,
	apiKey: { mode: ApiKeyMode; value?: string },
	modelIds: string[],
	opts: ModelOptions,
	ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>,
	infoById?: Map<string, ModelProbeInfo>,
) {
	const serializedApiKey = serializeApiKey(apiKey.mode, apiKey.value, style);
	const config: any = {
		baseUrl,
		api,
		...(serializedApiKey ? { apiKey: serializedApiKey } : {}),
		models: modelIds.map((id) =>
			buildModelEntry(id, modelOptionsFromProbe(infoById?.get(id), opts), ceilingOverrides),
		),
	};

	if (style === "ollama") {
		if (!config.apiKey) config.apiKey = "ollama";
		config.compat = {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}

	return config;
}

function describeProvider(providerId: string, provider: any): string {
	const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl : "(no baseUrl)";
	const api = typeof provider?.api === "string" ? provider.api : "(no api)";
	return `${providerId}\n${api} • ${modelCount} model${modelCount === 1 ? "" : "s"}\n${endpoint}`;
}

function describeProviderInline(providerId: string, provider: any): { label: string; suffix: string; searchText: string } {
	const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl : "(no baseUrl)";
	const api = typeof provider?.api === "string" ? provider.api : "(no api)";
	const suffix = ` • ${api} • ${endpoint} • ${modelCount} model${modelCount === 1 ? "" : "s"}`;
	return {
		label: providerId,
		suffix,
		searchText: `${providerId} ${api} ${endpoint} ${modelCount}`,
	};
}

function providerModelItems(provider: any): SelectItem[] {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models
		.map((model: any) => {
			const id = typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
			if (!id) return null;

			const details: string[] = [];
			if (model && typeof model === "object") {
				if (model.reasoning === true) {
					const opts = readModelOptions(model);
					details.push(`reasoning:${opts.reasoning}`);
				}
				if (Array.isArray(model.input) && model.input.includes("image")) details.push("vision");
				if (typeof model.contextWindow === "number") details.push(`context ${model.contextWindow}`);
				if (typeof model.maxTokens === "number") details.push(`max ${model.maxTokens}`);
			}

			return {
				value: id,
				label: id,
				suffix: details.length > 0 ? ` • ${details.join(" • ")}` : "",
				searchText: `${id} ${details.join(" ")}`,
			};
		})
		.filter((item: any): item is SelectItem => item !== null);
}

function normalizeStoredEndpoint(provider: any): string {
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl.trim() : "";
	if (!endpoint) return "";
	const stored = provider?.api;
	const api: ProviderApi =
		stored === "anthropic-messages" || stored === "openai-responses" ? stored : "openai-completions";
	try {
		return normalizeEndpoint(endpoint, api);
	} catch {
		return endpoint.replace(/\/+$/, "");
	}
}

function findProvidersByEndpoint(config: ModelsConfig, endpoint: string): string[] {
	return Object.entries(config.providers ?? {})
		.filter(([, provider]) => normalizeStoredEndpoint(provider) === endpoint)
		.map(([providerId]) => providerId)
		.sort((a, b) => a.localeCompare(b));
}

async function editProviderFlow(ctx: CommandContext) {
	let cursor = 0;

	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		config.providers ||= {};
		const providerIds = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
		if (providerIds.length === 0) {
			ctx.ui.notify(`No providers found in ${MODELS_JSON_PATH}`, "warning");
			return;
		}

		const choice = await selectOne(
			ctx,
			"Edit provider",
			providerIds.map((providerId) => {
				const inline = describeProviderInline(providerId, config.providers?.[providerId]);
				return {
					value: providerId,
					label: inline.label,
					suffix: inline.suffix,
					searchText: inline.searchText,
				};
			}),
			{ initialIndex: Math.min(cursor, providerIds.length - 1) },
		);
		if (!choice) return;

		cursor = providerIds.indexOf(choice);
		await editSingleProvider(ctx, choice);
	}
}

// Per-provider action menu. Returns when the user backs out to the provider list.
async function editSingleProvider(ctx: CommandContext, providerId: string) {
	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const provider = config.providers?.[providerId];
		if (!provider) {
			ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
			return;
		}

		const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
		const action = await selectOne(ctx, `Edit ${providerId}`, [
			{ value: "probe", label: "Re-probe for new models", description: "Query /models again and add ones not already configured" },
			{ value: "context", label: "Set context window (all models)", description: `Apply one contextWindow to all ${modelCount} model${modelCount === 1 ? "" : "s"}` },
			{ value: "models", label: "Edit per model", description: `${modelCount} model${modelCount === 1 ? "" : "s"} — reasoning, vision, context, max tokens, headers, delete` },
			{ value: "add", label: "Add models manually", description: "Type model ids to add" },
			{ value: "api", label: "API flavor", suffix: ` • ${typeof provider.api === "string" ? provider.api : "unset"}`, description: "Switch between Chat Completions, Responses, and Anthropic Messages" },
			{ value: "rename", label: "Rename provider", description: "Change the provider name in the models config" },
			{ value: "back", label: "Back", description: "Return to the provider list" },
		]);
		if (!action || action === "back") return;

		if (action === "models") {
			await editProviderModels(ctx, providerId);
		} else if (action === "probe") {
			await reprobeProvider(ctx, providerId);
		} else if (action === "context") {
			await setProviderContextWindow(ctx, providerId);
		} else if (action === "add") {
			await addModelsToProvider(ctx, providerId);
		} else if (action === "api") {
			await changeProviderApi(ctx, providerId);
		} else if (action === "rename") {
			// Reassign so the menu keeps editing the same provider under its new name.
			const renamed = await renameProvider(ctx, providerId);
			if (renamed) providerId = renamed;
		}
	}
}

const API_OPTIONS: Array<{ value: ProviderApi; label: string; description: string }> = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
	{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
	{ value: "anthropic-messages", label: "Anthropic Messages", description: 'api: "anthropic-messages" — requires an Anthropic-style endpoint' },
];

// Switch a provider's api flavor in the models config, keeping everything else.
async function changeProviderApi(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.api === "string" ? (provider.api as ProviderApi) : undefined;
	const options = API_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label,
		description: option.description,
		suffix: option.value === current ? " • current" : undefined,
	})).sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : 0));

	const choice = await selectOne(ctx, `API flavor for ${providerId}`, options);
	if (!choice || choice === current) return;

	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.api = choice;
		return true;
	});
	if (saved) ctx.ui.notify(`Changed "${providerId}" to ${choice}.`, "info");
}

// Rename a provider's key in the models config, preserving its config and original
// position in the file. Returns the new id on success, or null if cancelled,
// unchanged, or rejected. Only touches the models config — a currently-selected model
// pinned to the old provider id must be reselected via /model afterwards.
async function renameProvider(ctx: CommandContext, providerId: string): Promise<string | null> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	config.providers ||= {};
	if (!config.providers[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return null;
	}

	const input = await ctx.ui.input("Rename provider", `current: ${providerId}`);
	if (input === undefined) return null;
	// Slugify so names stay consistent with the Add flow.
	const newId = slugify(input.trim());
	if (!newId || newId === providerId) return null;

	if (config.providers[newId]) {
		ctx.ui.notify(`Provider "${newId}" already exists. Choose a different name.`, "warning");
		return null;
	}

	if (BUILTIN_PROVIDER_IDS.has(newId)) {
		const ok = await ctx.ui.confirm(
			"Override built-in provider?",
			`"${newId}" matches a built-in provider id. Saving this will override that provider in the active models config. Continue?`,
		);
		if (!ok) return null;
	}

	// Rebuild key-by-key so the renamed entry keeps its position rather than
	// jumping to the bottom (a naive delete + reassign would reorder it).
	const rebuilt: Record<string, any> = {};
	for (const [key, value] of Object.entries(config.providers)) {
		rebuilt[key === providerId ? newId : key] = value;
	}
	config.providers = rebuilt;

	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}

	ctx.ui.notify(`Renamed "${providerId}" → "${newId}".`, "info");
	return newId;
}

// Apply a single contextWindow value to every model in the provider, preserving
// each model's reasoning/vision config. A value of 0 clears it from all models.
async function setProviderContextWindow(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const models = Array.isArray(provider?.models) ? provider.models : [];
	if (models.length === 0) {
		ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
		return;
	}

	// Prefill with the shared value if every model already agrees, else blank.
	const windows = models.map((m: any) => (typeof m?.contextWindow === "number" ? m.contextWindow : undefined));
	const shared = windows.every((w: number | undefined) => w === windows[0]) ? windows[0] : undefined;

	const result = await promptContextWindow(ctx, shared);
	if (result === null) return;

	const saved = await mutateProvider(ctx, providerId, (p) => {
		const list = Array.isArray(p.models) ? p.models : [];
		for (const m of list) {
			const opts = readModelOptions(m);
			opts.contextWindow = result === 0 ? undefined : result;
			const ceilingOverrides: Partial<Record<"xhigh" | "max", string>> = {};
			for (const level of ["xhigh", "max"] as const) {
				const value = readCeilingString(m, level);
				if (value) ceilingOverrides[level] = value;
			}
			const rebuilt = buildModelEntry(
				modelIdOf(m),
				opts,
				Object.keys(ceilingOverrides).length > 0 ? ceilingOverrides : undefined,
			);
			Object.assign(m, rebuilt);
			if (result === 0) delete m.contextWindow;
		}
		return true;
	});
	if (saved) {
		ctx.ui.notify(
			result === 0
				? `Cleared context window on all ${models.length} model${models.length === 1 ? "" : "s"}.`
				: `Set context window ${result} on all ${models.length} model${models.length === 1 ? "" : "s"}.`,
			"info",
		);
	}
}

// Load config, hand the provider to a mutator, and save if it returns true.
async function mutateProvider(
	ctx: CommandContext,
	providerId: string,
	mutate: (provider: any) => boolean | Promise<boolean>,
): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	const provider = config.providers?.[providerId];
	if (!provider) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return false;
	}

	const changed = await mutate(provider);
	if (!changed) return false;

	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	return true;
}

// Pick a model, then a field to edit. Each edit mutates one field in place so
// other fields (headers, overrides, cost) are preserved.
async function editProviderModels(ctx: CommandContext, providerId: string) {
	let cursor = 0;
	while (true) {
		let provider: any;
		try {
			provider = loadModelsConfig().providers?.[providerId];
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const modelItems = providerModelItems(provider);
		if (modelItems.length === 0) {
			ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
			return;
		}

		const choice = await selectOne(ctx, `Edit model in ${providerId}`, modelItems, {
			initialIndex: Math.min(cursor, modelItems.length - 1),
		});
		if (!choice) return;
		cursor = modelItems.findIndex((item) => item.value === choice);

		const deleted = await editSingleModel(ctx, providerId, choice);
		if (deleted) cursor = Math.max(0, cursor - 1);
	}
}

// Field-picker for one model. Returns true if the model was deleted (so the
// caller can adjust its cursor).
async function editSingleModel(ctx: CommandContext, providerId: string, modelId: string): Promise<boolean> {
	while (true) {
		let model: any;
		try {
			model = findModel(loadModelsConfig().providers?.[providerId], modelId);
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		if (!model) {
			ctx.ui.notify(`Model "${modelId}" no longer exists.`, "warning");
			return false;
		}

		const opts = readModelOptions(model);
		const ctxWin = typeof model.contextWindow === "number" ? model.contextWindow : "unset";
		const maxTok = typeof model.maxTokens === "number" ? model.maxTokens : "unset";
		const hasHeaders = model.headers && Object.keys(model.headers).length > 0;
		const override = model.baseUrl || model.api ? "set" : "unset";

		const field = await selectOne(ctx, `Edit ${modelId}`, [
			{ value: "reasoning", label: "Reasoning", suffix: ` • ${opts.reasoning}`, description: "Set the reasoning ceiling (off → xhigh)" },
			{ value: "vision", label: "Vision", suffix: ` • ${opts.vision ? "on" : "off"}`, description: "Toggle image input (text+image vs text-only)" },
			{ value: "context", label: "Context window", suffix: ` • ${ctxWin}`, description: "Max context tokens for this model" },
			{ value: "maxtokens", label: "Max output tokens", suffix: ` • ${maxTok}`, description: "Max tokens this model may generate" },
			{ value: "override", label: "Headers / endpoint override", suffix: ` • ${hasHeaders ? "headers" : override}`, description: "Per-model HTTP headers and api/baseUrl override" },
			{ value: "delete", label: "Delete this model", description: "Remove this model from the provider" },
			{ value: "back", label: "Back", description: "Return to the model list" },
		]);
		if (!field || field === "back") return false;

		if (field === "reasoning") {
			const reasoning = await promptReasoning(ctx, opts.reasoning);
			if (reasoning === null) continue;
			let ceilingOverrides: Partial<Record<"xhigh" | "max", string>> | undefined;
			if (reasoning === "xhigh" || reasoning === "max") {
				const value = await promptCeilingProviderString(ctx, reasoning, readCeilingString(model, reasoning));
				if (value) {
					ceilingOverrides = {};
					ceilingOverrides[reasoning] = value;
				}
			}
			await mutateModel(ctx, providerId, modelId, (m) => applyReasoning(m, reasoning, ceilingOverrides));
		} else if (field === "vision") {
			const vision = await promptVision(ctx, opts.vision);
			if (vision === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { m.input = vision ? ["text", "image"] : ["text"]; });
		} else if (field === "context") {
			const result = await promptContextWindow(ctx, typeof model.contextWindow === "number" ? model.contextWindow : undefined);
			if (result === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { if (result === 0) delete m.contextWindow; else m.contextWindow = result; });
		} else if (field === "maxtokens") {
			const result = await promptMaxTokens(ctx, typeof model.maxTokens === "number" ? model.maxTokens : undefined);
			if (result === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { if (result === 0) delete m.maxTokens; else m.maxTokens = result; });
		} else if (field === "override") {
			await editModelOverride(ctx, providerId, modelId);
		} else if (field === "delete") {
			const ok = await ctx.ui.confirm("Delete model?", `Remove "${modelId}" from "${providerId}"?`);
			if (!ok) continue;
			const saved = await mutateProvider(ctx, providerId, (p) => {
				const models = Array.isArray(p.models) ? p.models : [];
				const index = models.findIndex((m: any) => modelIdOf(m) === modelId);
				if (index === -1) return false;
				models.splice(index, 1);
				return true;
			});
			if (saved) ctx.ui.notify(`Deleted "${modelId}".`, "info");
			return true;
		}
	}
}

// Mutate a single model entry in place and save.
async function mutateModel(ctx: CommandContext, providerId: string, modelId: string, mutate: (model: any) => void): Promise<boolean> {
	return mutateProvider(ctx, providerId, (p) => {
		const models = Array.isArray(p.models) ? p.models : [];
		const index = models.findIndex((m: any) => modelIdOf(m) === modelId);
		if (index === -1) return false;
		// Strings become objects so per-field knobs have somewhere to live.
		if (typeof models[index] === "string") models[index] = { id: modelId, input: ["text", "image"] };
		mutate(models[index]);
		return true;
	}).then((saved) => {
		if (saved) ctx.ui.notify(`Updated "${modelId}".`, "info");
		return saved;
	});
}

// Edit per-model HTTP headers and api/baseUrl endpoint override.
async function editModelOverride(ctx: CommandContext, providerId: string, modelId: string) {
	let model: any;
	try {
		model = findModel(loadModelsConfig().providers?.[providerId], modelId);
	} catch {
		model = undefined;
	}
	const currentBase = typeof model?.baseUrl === "string" ? model.baseUrl : "";
	const currentHeaders = model?.headers && typeof model.headers === "object" ? JSON.stringify(model.headers) : "";

	const base = await ctx.ui.input("baseUrl override (blank = use provider, \"-\" to clear)", currentBase || "e.g. https://api.example.com/v1");
	if (base === undefined) return;
	const headers = await ctx.ui.input("Headers as JSON (blank = keep, \"-\" to clear)", currentHeaders || 'e.g. {"x-api-version":"2024-01"}');
	if (headers === undefined) return;

	let parsedHeaders: Record<string, string> | null | undefined;
	const trimmedHeaders = headers.trim();
	if (trimmedHeaders === "-") parsedHeaders = null;
	else if (trimmedHeaders) {
		try {
			const obj = JSON.parse(trimmedHeaders);
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
			parsedHeaders = obj;
		} catch (error) {
			ctx.ui.notify(`Invalid headers JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
	}

	await mutateModel(ctx, providerId, modelId, (m) => {
		const trimmedBase = base.trim();
		if (trimmedBase === "-") delete m.baseUrl;
		else if (trimmedBase) m.baseUrl = trimmedBase;
		if (parsedHeaders === null) delete m.headers;
		else if (parsedHeaders) m.headers = parsedHeaders;
	});
}

function modelIdOf(model: any): string {
	return typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
}

function findModel(provider: any, id: string): any {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models.find((m: any) => modelIdOf(m) === id);
}

// Resolve a stored provider's apiKey reference back into mode+value so we can
// reuse it for probing. Anything other than $VAR or !cmd is treated as literal.
function apiKeyFromProvider(provider: any): { mode: ApiKeyMode; value?: string } {
	const raw = typeof provider?.apiKey === "string" ? provider.apiKey : "";
	if (!raw || raw === "dummy" || raw === "ollama") return { mode: "none" };
	if (raw.startsWith("!")) return { mode: "shell", value: raw.slice(1) };
	if (raw.startsWith("$")) return { mode: "env", value: raw.slice(1) };
	return { mode: "literal", value: raw };
}

async function addModelEntriesToProvider(
	ctx: CommandContext,
	providerId: string,
	ids: string[],
	infoById?: Map<string, ModelProbeInfo>,
) {
	const existing = new Set<string>();
	try {
		const provider = loadModelsConfig().providers?.[providerId];
		for (const m of Array.isArray(provider?.models) ? provider.models : []) existing.add(modelIdOf(m));
	} catch {
		// fall through; mutateProvider re-reads and reports errors
	}
	const fresh = dedupe(ids).filter((id) => id && !existing.has(id));
	if (fresh.length === 0) {
		ctx.ui.notify("Nothing to add — all selected models already exist.", "info");
		return;
	}

	// Added models default to reasoning on (xhigh ceiling) + text+image. When the
	// probe detected metadata (context window, vision, reasoning levels) it is
	// applied instead. Tune per model later via Edit provider → Edit a model.
	const defaultOpts: ModelOptions = { reasoning: "xhigh", vision: true };
	let detectedCount = 0;
	const saved = await mutateProvider(ctx, providerId, (p) => {
		const models = Array.isArray(p.models) ? p.models : [];
		for (const id of fresh) {
			const info = infoById?.get(id);
			// Manual entries (and gateways that expose no metadata) still get
			// context/vision/reasoning for well-known models from the built-in table.
			const known = info?.contextWindow === undefined ? lookupKnownModelContext(id) : undefined;
			const mergedInfo = known ? { ...(info ?? {}), ...known, inferred: true } : info;
			if (mergedInfo && probeInfoSummary(mergedInfo).length > 0) detectedCount++;
			models.push(buildModelEntry(id, modelOptionsFromProbe(mergedInfo, defaultOpts)));
		}
		p.models = models;
		return true;
	});
	if (saved) {
		const detail =
			detectedCount > 0 ? ` — auto-detected metadata for ${detectedCount} model${detectedCount === 1 ? "" : "s"}` : "";
		ctx.ui.notify(`Added ${fresh.length} model${fresh.length === 1 ? "" : "s"} to "${providerId}"${detail}.`, "info");
	}
}

async function reprobeProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";
	if (api !== "openai-completions" && api !== "openai-responses") {
		ctx.ui.notify("This provider's API doesn't expose /models. Use 'Add models manually'.", "warning");
		return;
	}
	const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	if (!baseUrl) {
		ctx.ui.notify(`Provider "${providerId}" has no baseUrl to probe.`, "error");
		return;
	}

	const apiKey = apiKeyFromProvider(provider);
	let probed: ProbeResult;
	try {
		ctx.ui.notify(`Probing ${buildProbeUrl(baseUrl)} ...`, "info");
		probed = await probeOpenAIModels(baseUrl, apiKey.mode, apiKey.value);
	} catch (error) {
		ctx.ui.notify(`Probe failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const existing = new Set((Array.isArray(provider.models) ? provider.models : []).map(modelIdOf));
	const novel = probed.items.filter((item) => !existing.has(item.value));
	if (novel.length === 0) {
		ctx.ui.notify("No new models — everything the endpoint returned is already configured.", "info");
		return;
	}

	const picked = await pickMany(ctx, `New models for ${providerId}`, novel);
	if (!picked || picked.length === 0) return;

	const style: ProviderStyle = provider?.compat ? "ollama" : "openai";
	const infoById = await collectProbedModelInfo(ctx, style, api, apiKey, baseUrl, picked, probed.infoById);
	await addModelEntriesToProvider(ctx, providerId, picked, infoById);
}

async function addModelsToProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const style: ProviderStyle =
		provider?.api === "anthropic-messages" ? "anthropic" : provider?.compat ? "ollama" : "openai";
	const ids = await promptModelIdsOneByOne(ctx, style);
	if (!ids || ids.length === 0) return;
	await addModelEntriesToProvider(ctx, providerId, ids);
}

async function deleteProviderFlow(ctx: CommandContext) {
	let cursor = 0;
	let deletedAny = false;

	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		config.providers ||= {};
		const providerIds = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
		if (providerIds.length === 0) {
			ctx.ui.notify(
				deletedAny ? `No providers left in ${MODELS_JSON_PATH}` : `No providers found in ${MODELS_JSON_PATH}`,
				deletedAny ? "info" : "warning",
			);
			return;
		}

		const choice = await selectOne(
			ctx,
			"Delete provider",
			providerIds.map((providerId) => {
				const inline = describeProviderInline(providerId, config.providers?.[providerId]);
				return {
					value: providerId,
					label: inline.label,
					suffix: inline.suffix,
					searchText: inline.searchText,
				};
			}),
			{ initialIndex: Math.min(cursor, providerIds.length - 1) },
		);
		if (!choice) return;

		const provider = config.providers[choice];
		const confirmed = await ctx.ui.confirm("Delete provider?", describeProvider(choice, provider));
		const selectedIndex = providerIds.indexOf(choice);
		cursor = selectedIndex;
		if (!confirmed) continue;

		cursor = selectedIndex + 1;
		delete config.providers[choice];

		try {
			saveModelsConfig(config);
		} catch (error) {
			ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		deletedAny = true;
		ctx.ui.notify(`Deleted provider \"${choice}\" from ${MODELS_JSON_PATH}`, "info");
	}
}

async function promptProviderStyle(
	ctx: CommandContext,
): Promise<{ style: ProviderStyle; api: ProviderApi } | null> {
	const choice = await selectOne(ctx, "Provider style", [
		{ value: "openai", label: "OpenAI-compatible (Chat Completions)", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
		{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
		{ value: "anthropic", label: "Anthropic-compatible", description: 'api: "anthropic-messages"' },
		{ value: "ollama", label: "Ollama-compatible", description: 'api: "openai-completions" with Ollama-specific compat defaults' },
	]);
	if (!choice) return null;

	const style = choice as ProviderStyle;
	const api: ProviderApi =
		style === "anthropic"
			? "anthropic-messages"
			: style === "openai-responses"
				? "openai-responses"
				: "openai-completions";
	return { style, api };
}

async function promptEndpoint(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
): Promise<{ normalized: string; raw: string } | null> {
	const endpointInput = await ctx.ui.input(
		"Endpoint",
		style === "anthropic"
			? "e.g. https://api.anthropic-proxy.com/v1"
			: style === "ollama"
				? "e.g. http://localhost:11434/v1"
				: style === "openai-responses"
					? "e.g. https://api.openai.com/v1"
					: "e.g. https://api.example.com/v1 or http://localhost:11434/v1",
	);
	if (endpointInput === undefined) return null;
	const raw = endpointInput.trim();
	if (!raw) {
		ctx.ui.notify("Endpoint is required.", "error");
		return null;
	}

	try {
		return { normalized: normalizeEndpoint(raw, api), raw };
	} catch (error) {
		ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}

async function confirmEndpointReuse(ctx: CommandContext, normalizedEndpoint: string): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}

	const providersWithSameEndpoint = findProvidersByEndpoint(config, normalizedEndpoint);
	if (providersWithSameEndpoint.length === 0) return true;

	return ctx.ui.confirm(
		"Endpoint already exists",
		`This endpoint is already used by:\n${providersWithSameEndpoint.map((id) => `- ${id}`).join("\n")}\n\nAdd another provider with the same endpoint?`,
	);
}

async function promptProviderId(ctx: CommandContext, normalizedEndpoint: string): Promise<string | null> {
	let existingIds = new Set<string>();
	try {
		existingIds = new Set(Object.keys(loadModelsConfig().providers ?? {}));
	} catch {
		// If config can't be read, persistProvider surfaces the error later.
	}

	const providerIdSuggestion = suggestProviderId(normalizedEndpoint);
	const suggestionTaken = existingIds.has(providerIdSuggestion);

	while (true) {
		const providerNameInput = await ctx.ui.input(
			suggestionTaken ? "Provider name (must be unique)" : `Provider name (blank = ${providerIdSuggestion})`,
			"e.g. custom-example-com",
		);
		if (providerNameInput === undefined) return null;
		const providerId = slugify(providerNameInput.trim() || providerIdSuggestion);
		if (!providerId) {
			ctx.ui.notify("Provider name is required.", "error");
			continue;
		}

		// Provider names must be unique — never silently overwrite an existing one.
		if (existingIds.has(providerId)) {
			ctx.ui.notify(`Provider "${providerId}" already exists. Choose a different name.`, "warning");
			continue;
		}

		if (BUILTIN_PROVIDER_IDS.has(providerId)) {
			const ok = await ctx.ui.confirm(
				"Override built-in provider?",
				`"${providerId}" matches a built-in provider id. Saving this will override that provider in the active models config. Continue?`,
			);
			if (!ok) continue;
		}
		return providerId;
	}
}

async function persistProvider(ctx: CommandContext, providerId: string, providerConfig: any): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}

	config.providers ||= {};
	if (config.providers[providerId]) {
		// Names are validated unique at prompt time; this only triggers if the
		// config changed underneath us. Refuse rather than overwrite.
		ctx.ui.notify(`Provider "${providerId}" already exists. Not overwriting.`, "error");
		return false;
	}

	config.providers[providerId] = providerConfig;
	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	return true;
}

async function addProviderFlow(ctx: CommandContext) {
	const styleChoice = await promptProviderStyle(ctx);
	if (!styleChoice) return;
	const { style, api } = styleChoice;

	const endpoint = await promptEndpoint(ctx, style, api);
	if (!endpoint) return;
	if (!(await confirmEndpointReuse(ctx, endpoint.normalized))) return;

	const providerId = await promptProviderId(ctx, endpoint.normalized);
	if (!providerId) return;

	const apiKey = await promptApiKey(ctx);
	if (!apiKey) return;
	if (apiKey.mode === "none") {
		ctx.ui.notify(
			style === "ollama"
				? 'No API key selected. Using "ollama" automatically in the models config.'
				: 'No API key selected. Using "dummy" automatically in the models config.',
			"info",
		);
	}

	const collected = await collectModelIds(ctx, style, api, apiKey, endpoint.normalized, endpoint.raw);
	if (!collected || collected.ids.length === 0) return;

	const providerConfig = buildProviderConfig(
		style,
		api,
		endpoint.normalized,
		apiKey,
		dedupe(collected.ids),
		// New providers default to text+image, reasoning on (xhigh ceiling). Tune
		// per model later via Edit provider → Edit a model.
		{ reasoning: "xhigh", vision: true },
		undefined,
		collected.infoById,
	);
	if (!(await persistProvider(ctx, providerId, providerConfig))) return;

	const infoById = collected.infoById;
	const probedCount = infoById
		? collected.ids.filter((id) => {
				const info = infoById.get(id);
				return info && !info.inferred && probeInfoSummary(info).length > 0;
			}).length
		: 0;
	const inferredCount = infoById ? collected.ids.filter((id) => infoById.get(id)?.inferred).length : 0;
	const unsetCount = collected.ids.length - probedCount - inferredCount;
	const summary: string[] = [];
	if (probedCount > 0) summary.push(`detected ${probedCount}`);
	if (inferredCount > 0) summary.push(`inferred from known models ${inferredCount}`);
	if (unsetCount > 0) summary.push(`unset ${unsetCount}`);
	ctx.ui.notify(
		`Saved provider \"${providerId}\" to ${MODELS_JSON_PATH}` + (summary.length > 0 ? ` — context/vision/reasoning: ${summary.join(", ")}` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}

async function collectModelIds(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
	apiKey: { mode: ApiKeyMode; value?: string },
	normalizedEndpoint: string,
	trimmedEndpointInput: string,
): Promise<{ ids: string[]; infoById?: Map<string, ModelProbeInfo> } | null> {
	if (api !== "openai-completions" && api !== "openai-responses") {
		const ids = await promptModelIdsOneByOne(ctx, style);
		return ids ? { ids } : null;
	}

	const modelMode = await selectOne(ctx, "Models", ["Auto probe from /models", "Add manually"]);
	if (!modelMode) return null;
	if (modelMode !== "Auto probe from /models") {
		const ids = await promptModelIdsOneByOne(ctx, style);
		return ids ? { ids } : null;
	}

	try {
		ctx.ui.notify(`Probing ${buildProbeUrl(normalizedEndpoint)} ...`, "info");
		const probed = await probeOpenAIModels(normalizedEndpoint, apiKey.mode, apiKey.value);
		if (probed.items.length === 0) {
			ctx.ui.notify("Probe succeeded but returned no models. Switching to manual entry.", "warning");
			const ids = await promptModelIdsOneByOne(ctx, style);
			return ids ? { ids } : null;
		}
		const picked = await pickMany(ctx, "Select models", probed.items);
		if (!picked || picked.length === 0) return null;

		const infoById = await collectProbedModelInfo(ctx, style, api, apiKey, normalizedEndpoint, picked, probed.infoById);
		return { ids: picked, infoById };
	} catch (error) {
		const schemeHint = hasExplicitScheme(trimmedEndpointInput) ? "" : "\n\nNo http:// or https:// was provided.";
		ctx.ui.notify(
			`Auto probe failed: ${error instanceof Error ? error.message : String(error)}.${schemeHint}\n\nSwitching to manual entry.`,
			"warning",
		);
		const ids = await promptModelIdsOneByOne(ctx, style);
		return ids ? { ids } : null;
	}
}

// Merge list-level metadata with per-model detail fetches. Best effort — when a
// server exposes nothing, the wizard falls back to its defaults per model.
// Conservative context-window fallback for well-known model ids. Used when a
// gateway exposes no metadata at all (stock One API / New API, bare proxies)
// so the wizard can still write a sensible contextWindow. Only stable values
// are listed; unknown models are left unset. Entry order matters — more
// specific patterns (e.g. claude-sonnet-4-5) must come before their prefix
// (claude-sonnet-4).
const KNOWN_MODEL_CONTEXTS: Array<{
	pattern: RegExp;
	contextWindow: number;
	vision?: boolean;
	reasoning?: boolean;
}> = [
	// OpenAI
	{ pattern: /^gpt-5/i, contextWindow: 272000, vision: true, reasoning: true },
	{ pattern: /^gpt-4o-mini/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4o/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4-turbo/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4-32k/i, contextWindow: 32768 },
	{ pattern: /^gpt-4/i, contextWindow: 8192 },
	{ pattern: /^gpt-3\.5-turbo/i, contextWindow: 16385 },
	{ pattern: /^o[134]-mini/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^o[134]/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^gpt-oss/i, contextWindow: 128000, vision: true, reasoning: true },
	// Anthropic
	{ pattern: /^claude-(opus|sonnet|haiku)-4-5/i, contextWindow: 1000000, vision: true, reasoning: true },
	{ pattern: /^claude-(opus|sonnet|haiku)-4/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^claude-3/i, contextWindow: 200000, vision: true },
	// DeepSeek
	{ pattern: /^deepseek-v4/i, contextWindow: 1000000, reasoning: true },
	{ pattern: /^deepseek-(chat|reasoner|v3|r1)/i, contextWindow: 128000, reasoning: true },
	// Google
	{ pattern: /^gemini-(1\.5|2\.0|2\.5|3)/i, contextWindow: 1000000, vision: true },
	// Zhipu / Alibaba / Meta / Mistral / Moonshot
	{ pattern: /^glm-4/i, contextWindow: 128000 },
	{ pattern: /^qwen2\.5/i, contextWindow: 131072 },
	{ pattern: /^qwen3-coder/i, contextWindow: 131072 },
	{ pattern: /^llama(3|4)/i, contextWindow: 131072 },
	{ pattern: /^mistral-(large|small|medium)/i, contextWindow: 128000 },
	{ pattern: /^kimi-k2/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^moonshotai\/kimi-k2/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^moonshot-v1/i, contextWindow: 128000 },
];

// Look up well-known model metadata by id (best-effort fallback).
function lookupKnownModelContext(modelId: string): ModelProbeInfo | undefined {
	for (const entry of KNOWN_MODEL_CONTEXTS) {
		if (entry.pattern.test(modelId)) {
			const info: ModelProbeInfo = { contextWindow: entry.contextWindow };
			if (entry.vision !== undefined) info.vision = entry.vision;
			if (entry.reasoning !== undefined) info.reasoning = entry.reasoning;
			return info;
		}
	}
	return undefined;
}

async function collectProbedModelInfo(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
	apiKey: { mode: ApiKeyMode; value?: string },
	baseUrl: string,
	ids: string[],
	listInfo: Map<string, ModelProbeInfo>,
): Promise<Map<string, ModelProbeInfo>> {
	ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
	let details: Map<string, ModelProbeInfo>;
	if (style === "ollama") {
		details = await enrichOllamaModelDetails(baseUrl, apiKey.mode, apiKey.value, ids);
	} else if (api === "openai-completions" || api === "openai-responses") {
		details = await enrichOpenAIModelDetails(baseUrl, apiKey.mode, apiKey.value, ids);
	} else {
		details = new Map();
	}
	const merged = new Map(listInfo);
	for (const [id, info] of details) {
		merged.set(id, { ...(merged.get(id) ?? {}), ...info });
	}
	// Fallback: when a gateway exposes no metadata (stock One API / New API,
	// bare proxies), infer well-known models from the built-in table instead of
	// leaving contextWindow unset.
	for (const id of ids) {
		const info = merged.get(id);
		if (info?.contextWindow !== undefined) continue;
		const known = lookupKnownModelContext(id);
		if (known) merged.set(id, { ...(info ?? {}), ...known, inferred: true });
	}
	return merged;
}

export default function betterCustomWizard(pi: ExtensionAPI) {
	pi.registerCommand("better-custom", {
		description: "Wizard for adding, editing, or deleting custom providers in ~/.pi/agent/models.json",
		handler: async (_args, ctx) => {
			const action = await selectOne(ctx, "Better custom", ["Add provider", "Edit provider", "Delete provider"]);
			if (!action) return;
			if (action === "Edit provider") {
				await editProviderFlow(ctx);
				return;
			}
			if (action === "Delete provider") {
				await deleteProviderFlow(ctx);
				return;
			}
			await addProviderFlow(ctx);
		},
	});
}
