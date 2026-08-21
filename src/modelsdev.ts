// Provider catalog from models.dev: which API sites exist, their base URL and
// the env var they expect. Only provider-level data is used — model metadata
// comes from probing the endpoint itself afterwards.
//
// models.dev is unreachable on some networks (DNS poisoning / TLS resets), so
// there are two sources, tried in order:
//   1. https://models.dev/api.json — the generated catalog, one request
//   2. GitHub mirror — list providers via the GitHub API (api.github.com),
//      then fetch each providers/<id>/provider.toml from jsDelivr
import { PROBE_TIMEOUT_MS } from "model-probe";

export type ModelsDevProvider = {
	id: string;
	name: string;
	baseUrl: string;
	env: string[];
	doc?: string;
};

const API_JSON_URL = "https://models.dev/api.json";
const GITHUB_LIST_URL = "https://api.github.com/repos/sst/models.dev/contents/providers?ref=dev";
const PROVIDER_TOML_URL = (id: string) => `https://cdn.jsdelivr.net/gh/sst/models.dev@dev/providers/${id}/provider.toml`;
const MIRROR_CONCURRENCY = 8;

// Providers whose api field is implicit (their ai-sdk package hardcodes the
// endpoint, so provider.toml omits it). These mirror the SDK defaults; the
// api.json source usually carries them explicitly. Providers that need
// account-specific URLs (Azure, Bedrock, Cloudflare AI Gateway, ...) or aren't
// OpenAI-compatible (Anthropic, Google) stay out — the catalog is for
// OpenAI-style endpoints.
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	groq: "https://api.groq.com/openai/v1",
	mistral: "https://api.mistral.ai/v1",
	xai: "https://api.x.ai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	togetherai: "https://api.together.xyz/v1",
	deepinfra: "https://api.deepinfra.com/v1/openai",
	perplexity: "https://api.perplexity.ai",
	venice: "https://api.venice.ai/api/v1",
	aihubmix: "https://aihubmix.com/v1",
};

let cache: Map<string, ModelsDevProvider> | null = null;

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json", "user-agent": "better-custom-provider" },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers: { "user-agent": "better-custom-provider" }, signal: controller.signal });
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

// Pull the flat keys we need out of a provider.toml. The files are simple
// (name/env/api/doc plus comments), so a full TOML parser is overkill.
function parseProviderToml(text: string): { name?: string; api?: string; doc?: string; env: string[] } {
	const grab = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
	const envMatch = /^env\s*=\s*\[([^\]]*)\]/m.exec(text);
	const env = envMatch ? [...envMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
	return { name: grab("name"), api: grab("api"), doc: grab("doc"), env };
}

function toEntry(id: string, raw: { name?: string; api?: string; doc?: string; env?: string[] }): ModelsDevProvider | null {
	const baseUrl = raw.api?.trim() || DEFAULT_BASE_URLS[id];
	if (!baseUrl) return null; // no known endpoint for this provider — skip
	return {
		id,
		name: raw.name?.trim() || id,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		env: Array.isArray(raw.env) ? raw.env.filter((v): v is string => typeof v === "string") : [],
		doc: raw.doc,
	};
}

// Primary source: the generated api.json — one request, everything inline.
async function fetchFromApiJson(): Promise<Map<string, ModelsDevProvider>> {
	const json = await fetchJson(API_JSON_URL, PROBE_TIMEOUT_MS * 2);
	const out = new Map<string, ModelsDevProvider>();
	if (!json || typeof json !== "object") return out;
	for (const [id, raw] of Object.entries<any>(json)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = toEntry(typeof raw.id === "string" ? raw.id : id, raw);
		if (entry) out.set(entry.id, entry);
	}
	if (out.size === 0) throw new Error("api.json contained no usable providers");
	return out;
}

// Fallback: GitHub repo mirror. List providers/<id>/ via the GitHub API, then
// fetch each provider.toml from jsDelivr (both reachable where models.dev is
// not). Providers without an api field and no known default are skipped.
async function fetchFromGitHubMirror(): Promise<Map<string, ModelsDevProvider>> {
	const listing = await fetchJson(GITHUB_LIST_URL, PROBE_TIMEOUT_MS * 2);
	const ids: string[] = Array.isArray(listing)
		? listing.filter((e: any) => e?.type === "dir" && typeof e?.name === "string").map((e: any) => e.name)
		: [];
	if (ids.length === 0) throw new Error("GitHub mirror listing was empty");

	const out = new Map<string, ModelsDevProvider>();
	let cursor = 0;
	async function worker() {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try {
				const toml = await fetchText(PROVIDER_TOML_URL(id), PROBE_TIMEOUT_MS);
				const entry = toEntry(id, parseProviderToml(toml));
				if (entry) out.set(id, entry);
			} catch {
				// A single unreadable provider doesn't sink the catalog.
			}
		}
	}
	await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, worker));
	if (out.size === 0) throw new Error("GitHub mirror returned no usable providers");
	return out;
}

// Fetch the provider catalog, trying models.dev first and the GitHub/jsDelivr
// mirror second. Cached for the session. Throws when both sources fail.
export async function fetchModelsDevProviders(): Promise<Map<string, ModelsDevProvider>> {
	if (cache) return cache;
	try {
		cache = await fetchFromApiJson();
	} catch {
		cache = await fetchFromGitHubMirror();
	}
	return cache;
}
