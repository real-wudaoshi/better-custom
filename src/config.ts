import * as CodingAgent from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ModelsConfig } from "./types.ts";

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

const AGENT_DIR = CodingAgent.getAgentDir();
const IS_OMP = "logger" in CodingAgent || /(^|[\\/])\.?omp([\\/]|$)/i.test(AGENT_DIR);
// OMP prefers YAML and still accepts legacy JSON; normal Pi uses JSON only.
export const MODELS_JSON_PATH = (IS_OMP ? ["models.yml", "models.yaml", "models.json"] : ["models.json"])
	.map((name) => join(AGENT_DIR, name))
	.find(existsSync) ?? join(AGENT_DIR, IS_OMP ? "models.yml" : "models.json");
const IS_YAML_CONFIG = /\.ya?ml$/i.test(MODELS_JSON_PATH);
export const BUILTIN_PROVIDER_IDS = new Set([
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

// pi's official split: credentials live in auth.json (the file /login writes),
// model declarations in models.json. pi resolves an auth.json entry by provider
// id for ANY provider (built-in or custom), and its key field supports the same
// "$ENV" / "!cmd" syntax as an inline apiKey — so a custom provider declared in
// models.json without an apiKey picks its key up from auth.json automatically.
// OMP's key handling is kept inline (models.yml) since its auth.json semantics
// are not verified.
export const AUTH_JSON_PATH = join(AGENT_DIR, "auth.json");
export const SPLIT_AUTH = !IS_OMP;

type AuthFile = Record<string, any>;

export function loadAuthFile(): AuthFile {
	if (!existsSync(AUTH_JSON_PATH)) return {};
	const raw = readFileSync(AUTH_JSON_PATH, "utf8").trim();
	if (!raw) return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${AUTH_JSON_PATH} must be an object`);
	}
	return parsed;
}

function saveAuthFile(auth: AuthFile) {
	mkdirSync(dirname(AUTH_JSON_PATH), { recursive: true });
	writeFileSync(AUTH_JSON_PATH, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

// The stored key for a provider: auth.json wins (pi gives stored credentials
// priority over everything else), with the legacy inline apiKey as fallback.
export function storedApiKey(providerId: string, provider: any): string | undefined {
	if (SPLIT_AUTH) {
		try {
			const entry = loadAuthFile()[providerId];
			if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key) {
				return entry.key;
			}
		} catch {
			// Unreadable auth.json — fall back to the inline key below.
		}
	}
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey : "";
	return inline || undefined;
}

// Write a provider's api_key entry into auth.json, preserving all other
// entries (other providers, oauth logins). No-op where keys stay inline.
export function saveProviderApiKey(providerId: string, serializedKey: string) {
	if (!SPLIT_AUTH) return;
	const auth = loadAuthFile();
	auth[providerId] = { type: "api_key", key: serializedKey };
	saveAuthFile(auth);
}

// Drop a provider's auth.json entry along with the provider. Only api_key
// entries are touched — an oauth login under the same id is left alone.
export function removeProviderApiKey(providerId: string) {
	if (!SPLIT_AUTH) return;
	let auth: AuthFile;
	try {
		auth = loadAuthFile();
	} catch {
		return;
	}
	if (auth[providerId]?.type !== "api_key") return;
	delete auth[providerId];
	saveAuthFile(auth);
}

// Carry a provider's auth.json entry over to its new id on rename.
export function renameProviderApiKey(oldId: string, newId: string) {
	if (!SPLIT_AUTH) return;
	let auth: AuthFile;
	try {
		auth = loadAuthFile();
	} catch {
		return;
	}
	if (!(oldId in auth)) return;
	if (!(newId in auth)) auth[newId] = auth[oldId];
	delete auth[oldId];
	saveAuthFile(auth);
}

// Move inline apiKeys into auth.json and strip them from the models config, so
// the files end up split the way pi itself writes them. An existing auth.json
// entry always wins over the inline value (pi resolves stored credentials
// first anyway). auth.json is written BEFORE models.json so a failed write
// never strands a key.
function migrateInlineApiKeys(config: ModelsConfig) {
	if (!SPLIT_AUTH) return;
	const providers = config.providers ?? {};
	const inline: Array<[string, string]> = [];
	for (const [id, provider] of Object.entries(providers)) {
		const key = (provider as any)?.apiKey;
		if (typeof key === "string" && key) inline.push([id, key]);
	}
	if (inline.length === 0) return;

	const auth = loadAuthFile();
	for (const [id, key] of inline) {
		if (!(id in auth)) auth[id] = { type: "api_key", key };
	}
	saveAuthFile(auth);
	for (const [id] of inline) {
		delete (providers[id] as any).apiKey;
	}
}

export function loadModelsConfig(): ModelsConfig {
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

export function saveModelsConfig(config: ModelsConfig) {
	ensureConfigDir();
	migrateInlineApiKeys(config);
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
