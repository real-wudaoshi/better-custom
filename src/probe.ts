import { resolveApiKeyForProbe } from "./api-key.ts";
import { applyKnownModelFallback } from "./known-models.ts";
import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS } from "./types.ts";
import type { ApiKeyMode, ModelProbeInfo, ProbeResult } from "./types.ts";
import { buildProbeUrl, dedupe, firstFiniteNumber } from "./url.ts";

// Retryable probe failure (timeout, network error, 404) — the caller retries
// with the other base variant. Auth/client errors are not wrapped and abort
// the probe immediately.
class ProbeRetryable extends Error {}

// Some gateways are quirky about where /models lives: USTC's LiteLLM hangs on
// /v1/models while serving /models at the root; stock LiteLLM and many proxies
// serve both; One API / New API only mount /v1. Try the base as given, then
// the variant with a trailing /v1 added or removed.
function probeBaseVariants(baseUrl: string): string[] {
	const trimmed = baseUrl.replace(/\/+$/, "");
	try {
		const url = new URL(trimmed);
		if (url.pathname.endsWith("/v1")) {
			url.pathname = url.pathname.slice(0, -3) || "/";
			return [trimmed, url.toString().replace(/\/+$/, "")];
		}
		if (url.pathname === "" || url.pathname === "/") {
			url.pathname = "/v1";
			return [trimmed, url.toString().replace(/\/+$/, "")];
		}
	} catch {
		// not a URL — probe as given
	}
	return [trimmed];
}

async function fetchModelsList(baseUrl: string, headers: Record<string, string>): Promise<any> {
	const probeUrl = buildProbeUrl(baseUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(probeUrl, { headers, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new ProbeRetryable(`Probe timed out after ${PROBE_TIMEOUT_MS / 1000}s: ${probeUrl}`);
		}
		throw new ProbeRetryable(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
	}
	if (response.status === 404) {
		throw new ProbeRetryable(`Probe failed (404 Not Found): ${probeUrl}`);
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Probe failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 200)}` : ""}`);
	}
	// A 200 that isn't JSON means we hit a web UI, not the API (e.g. New API
	// serving its console HTML at /models) — retry with the other base variant.
	try {
		return await response.json();
	} catch {
		throw new ProbeRetryable(`Probe got a non-JSON response (a web page, not an API): ${probeUrl}`);
	}
}

export async function probeOpenAIModels(baseUrl: string, apiKeyMode: ApiKeyMode, apiKeyValue?: string): Promise<ProbeResult> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"accept-encoding": "identity",
	};
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (resolvedKey) {
		headers.authorization = `Bearer ${resolvedKey}`;
	}

	const variants = probeBaseVariants(baseUrl);
	let json: any;
	let resolvedBaseUrl = variants[0];
	for (let i = 0; i < variants.length; i++) {
		try {
			json = await fetchModelsList(variants[i], headers);
			resolvedBaseUrl = variants[i];
			break;
		} catch (error) {
			// Retryable failures (timeout, network, 404) fall through to the other
			// base variant; auth/client errors abort immediately.
			if (!(error instanceof ProbeRetryable) || i === variants.length - 1) throw error;
		}
	}

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

	// Show detected metadata in the picker, merged with the built-in rule
	// presets for anything the gateway didn't say. Inferred (preset) fields are
	// tagged [local rules] individually so gateway-provided values stay clean.
	const items = ids.map((id) => {
		const info = applyKnownModelFallback(id, infoById.get(id));
		return { value: id, label: id, description: describeProbeInfo(info) };
	});

	return {
		items,
		infoById,
		baseUrl: resolvedBaseUrl,
	};
}

// Human-readable list of the metadata fields actually present in a probe result.
export function probeInfoSummary(info: ModelProbeInfo | undefined): string[] {
	if (!info) return [];
	const parts: string[] = [];
	if (info.contextWindow !== undefined) parts.push("context");
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

export function describeProbeInfo(info: ModelProbeInfo | undefined): string | undefined {
	if (!info) return undefined;
	const inferred = new Set(info.inferredFields ?? []);
	const tag = (field: "contextWindow" | "vision" | "reasoning") => (inferred.has(field) ? " [local rules]" : "");
	const parts: string[] = [];
	if (info.contextWindow !== undefined) parts.push(`ctx ${info.contextWindow}${tag("contextWindow")}`);
	if (info.vision !== undefined) parts.push(`${info.vision ? "vision" : "text-only"}${tag("vision")}`);
	if (info.reasoning === true) parts.push(`${info.alwaysThinking ? "reasoning (always on)" : "reasoning"}${tag("reasoning")}`);
	else if (info.reasoning === false) parts.push(`no reasoning${tag("reasoning")}`);
	if (info.endpointTypes && info.endpointTypes.length > 0) parts.push(info.endpointTypes.join("/"));
	return parts.length > 0 ? parts.join(" • ") : undefined;
}

// One API / New API gateways (and their forks) attach extra model metadata
// under "meta": { context_window, capabilities: { vision, reasoning, ... },
// supports_vision, supports_reasoning }. Fills only fields that are still
// unknown, so OpenRouter/OpenAI-style data wins when both exist.
function parseGatewayMetaFields(source: any, info: ModelProbeInfo): void {
	const meta = source?.meta;
	if (!meta || typeof meta !== "object") return;
	if (info.contextWindow === undefined) {
		const contextWindow = firstFiniteNumber(meta, "context_window", "max_input_tokens");
		if (contextWindow !== undefined) info.contextWindow = contextWindow;
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

// Metadata from a LiteLLM proxy's GET /model_group/info — like /model/info
// but mounted at the server root (/v1/model_group/info is 404), keyed by
// model_group, with per-group capability fields.
function parseModelGroupInfo(json: any, out: Map<string, ModelProbeInfo>): boolean {
	if (!json || typeof json !== "object") return false;
	const entries = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
	if (entries.length === 0) return false;
	let found = false;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.model_group === "string" ? entry.model_group.trim() : "";
		if (!name) continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(entry, "max_input_tokens", "context_window");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		if (typeof entry.supports_vision === "boolean") parsed.vision = entry.supports_vision;
		if (typeof entry.supports_reasoning === "boolean") parsed.reasoning = entry.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			out.set(name, parsed);
			found = true;
		}
	}
	return found;
}

// Fetch LiteLLM /model_group/info (requires an api key). The endpoint lives at
// the server root, so we try the baseUrl's origin first, then the baseUrl.
export async function enrichLiteLLMModelGroupInfo(
	baseUrl: string,
	apiKeyMode: ApiKeyMode,
	apiKeyValue: string | undefined,
	ids: string[],
): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (!resolvedKey) return out;
	const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${resolvedKey}` };

	let roots: string[];
	try {
		roots = [new URL(baseUrl).origin, baseUrl];
	} catch {
		roots = [baseUrl];
	}
	for (const root of roots) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			const response = await fetch(`${root.replace(/\/+$/, "")}/model_group/info`, {
				headers,
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (!response.ok) continue;
			const json = await response.json().catch(() => null);
			if (parseModelGroupInfo(json, out)) return out;
		} catch {
			// try the next root
		}
	}
	return out;
}

// USTC-style site model catalog: GET {site}/api/models/public (no auth needed)
// returns authoritative context_window for every published model — more
// reliable than LiteLLM's /model/info (which often has max_input_tokens null).
function parsePublicModelList(json: any, out: Map<string, ModelProbeInfo>): boolean {
	if (!Array.isArray(json)) return false;
	let found = false;
	for (const entry of json) {
		if (!entry || typeof entry !== "object") continue;
		const name =
			typeof entry.litellm_model_name === "string"
				? entry.litellm_model_name.trim()
				: typeof entry.model_name === "string"
					? entry.model_name.trim()
					: typeof entry.id === "string"
						? entry.id.trim()
						: "";
		if (!name) continue;
		if (entry.status === "draft" || entry.status === "archived" || entry.is_visible === false) continue;
		const parsed: ModelProbeInfo = {};
		const contextWindow = firstFiniteNumber(entry, "context_window", "contextWindow", "max_input_tokens");
		if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
		// Best effort: some catalogs also publish capability flags.
		if (typeof entry.supports_vision === "boolean") parsed.vision = entry.supports_vision;
		if (typeof entry.supports_reasoning === "boolean") parsed.reasoning = entry.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			out.set(name, parsed);
			found = true;
		}
	}
	return found;
}

// Fetch the site's public model catalog. The catalog lives on the site root,
// not the api host — for api.llm.example.edu.cn we also try llm.example.edu.cn.
export async function enrichPublicModelInfo(baseUrl: string): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	const roots = new Set<string>();
	try {
		const url = new URL(baseUrl);
		roots.add(url.origin);
		// api.llm.example.edu.cn -> llm.example.edu.cn (same domain, site root)
		roots.add(`https://${url.hostname.replace(/^api\./i, "")}`);
	} catch {
		roots.add(baseUrl);
	}
	for (const root of roots) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			const response = await fetch(`${root.replace(/\/+$/, "")}/api/models/public`, {
				headers: { accept: "application/json" },
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (!response.ok) continue;
			const json = await response.json().catch(() => null);
			if (parsePublicModelList(json, out)) return out;
		} catch {
			// try the next candidate root
		}
	}
	return out;
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
		if (typeof info.supports_vision === "boolean") parsed.vision = info.supports_vision;
		if (typeof info.supports_reasoning === "boolean") parsed.reasoning = info.supports_reasoning;
		if (probeInfoSummary(parsed).length > 0) {
			out.set(name, parsed);
			found = true;
		}
	}
	return found;
}

// LiteLLM proxy: GET /model/info returns metadata for every model in one
// call, which is far cheaper than per-model fetches (and LiteLLM's
// /models/{id} has no metadata at all). The endpoint is mounted at the
// server root (/v1/model/info is 404 on LiteLLM), so try the baseUrl's
// origin first, then the baseUrl itself.
export async function enrichLiteLLMModelInfo(
	baseUrl: string,
	apiKeyMode: ApiKeyMode,
	apiKeyValue: string | undefined,
): Promise<Map<string, ModelProbeInfo>> {
	const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity" };
	const resolvedKey = resolveApiKeyForProbe(apiKeyMode, apiKeyValue);
	if (resolvedKey) headers.authorization = `Bearer ${resolvedKey}`;

	const out = new Map<string, ModelProbeInfo>();
	let roots: string[];
	try {
		const origin = new URL(baseUrl).origin;
		const trimmedBase = baseUrl.replace(/\/+$/, "");
		roots = origin === trimmedBase ? [trimmedBase] : [origin, trimmedBase];
	} catch {
		roots = [baseUrl.replace(/\/+$/, "")];
	}
	for (const root of roots) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		let response: Response | undefined;
		try {
			response = await fetch(`${root}/model/info`, { headers, signal: controller.signal });
		} catch {
			// network error — try the next root
		} finally {
			clearTimeout(timer);
		}
		if (response?.ok) {
			const json = await response.json().catch(() => null);
			if (parseLiteLLMModelInfo(json, out)) return out;
		}
	}
	return out;
}

// Fetch GET /models/{id} for each picked model to learn context_window,
// max_output_tokens, and capabilities. Best effort: servers that don't expose
// per-model details simply leave those fields unset.
export async function enrichOpenAIModelDetails(
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
export async function enrichOllamaModelDetails(
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
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		const response = await fetch(`${root}/api/tags`, { headers, signal: controller.signal });
		clearTimeout(timer);
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
