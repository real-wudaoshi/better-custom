// Injection layer: the extension owns its store, pi owns the model registry.
// Every provider in custom-providers.json is registered through
// pi.registerProvider() at load time (and again after any write), so pi lists
// it in /model like a native provider while the files stay separate.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { API_FALLBACK_LIMITS } from "model-probe";
import { loadModelsConfig, onStoreSaved, storedApiKey } from "./config.ts";

let api: ExtensionAPI | undefined;
const registered = new Set<string>();

export function bindRegistrationApi(extensionApi: ExtensionAPI): void {
	api = extensionApi;
	// Every store/auth write re-pushes the registry, so add/edit/delete/rename and
	// the models.dev sync all take effect without a reload.
	onStoreSaved(() => refreshRegistrations());
}

// pi requires contextWindow/maxTokens/input/cost on every registered model.
// Fill what our entries may not carry: protocol-level limits, then a
// conservative floor, plus a zero-cost block (pi then reports no spend rather
// than a wrong estimate).
const FLOOR_LIMITS = { contextWindow: 128000, maxTokens: 8192 };

function limitsFor(providerApi: string | undefined, model: any): { contextWindow: number; maxTokens: number } {
	const fallback = (providerApi && API_FALLBACK_LIMITS[providerApi]) || FLOOR_LIMITS;
	return {
		contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : fallback.contextWindow,
		maxTokens: typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : fallback.maxTokens,
	};
}

function toModelConfig(provider: any, raw: any) {
	const model = typeof raw === "string" ? { id: raw } : raw ?? {};
	const id = typeof model.id === "string" ? model.id.trim() : "";
	if (!id) return null;
	const providerApi = typeof model.api === "string" ? model.api : typeof provider?.api === "string" ? provider.api : undefined;
	const limits = limitsFor(providerApi, model);
	const config: any = {
		id,
		name: typeof model.name === "string" && model.name ? model.name : id,
		input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"],
		cost:
			model.cost && typeof model.cost === "object"
				? model.cost
				: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: model.reasoning === true,
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
	};
	if (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object") config.thinkingLevelMap = model.thinkingLevelMap;
	// compat is per model in the registration API; our store keeps it at
	// provider scope, like models.json does.
	const compat = model.compat ?? provider?.compat;
	if (compat && typeof compat === "object") config.compat = compat;
	if (typeof model.baseUrl === "string") config.baseUrl = model.baseUrl;
	if (model.headers && typeof model.headers === "object") config.headers = model.headers;
	if (typeof model.api === "string") config.api = model.api;
	return config;
}

function toProviderConfig(providerId: string, provider: any) {
	const models = (Array.isArray(provider?.models) ? provider.models : [])
		.map((model: any) => toModelConfig(provider, model))
		.filter(Boolean);
	if (models.length === 0) return null;

	const apiKey = storedApiKey(providerId, provider);
	const config: any = {
		name: typeof provider?.name === "string" && provider.name ? provider.name : providerId,
		baseUrl: typeof provider?.baseUrl === "string" ? provider.baseUrl : "",
		models,
	};
	if (!config.baseUrl) return null;
	if (typeof provider?.api === "string") config.api = provider.api;
	if (apiKey) config.apiKey = apiKey;
	if (provider?.headers && typeof provider.headers === "object") config.headers = provider.headers;
	if (provider?.authHeader === true) config.authHeader = true;
	return config;
}

// Push the current store into pi: providers that disappeared are unregistered,
// everything else is (re)registered — registerProvider replaces a provider's
// models, so edits and syncs land without a reload.
export function refreshRegistrations(): void {
	if (!api) return;
	let config;
	try {
		config = loadModelsConfig();
	} catch {
		return;
	}
	const providers = config.providers ?? {};

	for (const id of [...registered]) {
		if (providers[id]) continue;
		try {
			api.unregisterProvider(id);
		} catch {
			// Already gone — nothing to undo.
		}
		registered.delete(id);
	}

	for (const [id, provider] of Object.entries(providers)) {
		const providerConfig = toProviderConfig(id, provider);
		if (!providerConfig) continue;
		try {
			api.registerProvider(id, providerConfig);
			registered.add(id);
		} catch {
			// A provider pi rejects stays in the store; the user can fix it and
			// the next write re-registers everything.
		}
	}
}

export function registeredProviderIds(): string[] {
	return [...registered];
}
