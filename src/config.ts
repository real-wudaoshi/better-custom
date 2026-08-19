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
