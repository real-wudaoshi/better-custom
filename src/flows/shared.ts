import { probeInfoSummary } from "model-probe";
import { serializeApiKey } from "../api-key.ts";
import { loadModelsConfig, STORE_PATH, removeProviderApiKey, saveModelsConfig, saveProviderApiKey } from "../config.ts";
import { describeInfo, describeStoredModel } from "../format.ts";
import { unmarkManaged } from "../modelsdev-sync.ts";
import { buildModelEntry, modelIdOf, modelOptionsFromProbe } from "../model-entry.ts";
import type {
	ApiKeyMode,
	CommandContext,
	ModelOptions,
	ModelProbeInfo,
	ModelsConfig,
	ProviderApi,
	ProviderStyle,
	SelectItem,
} from "../types.ts";
import { storedDetails } from "../ui/metadata.ts";
import { dedupe, normalizeEndpoint } from "../url.ts";

// Load config, hand the provider to a mutator, and save if it returns true.
export async function mutateProvider(
	ctx: CommandContext,
	providerId: string,
	mutate: (provider: any) => boolean | Promise<boolean>,
): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
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
		ctx.ui.notify(`Could not write ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	return true;
}

// Mutate a single model entry in place and save.
export async function mutateModel(ctx: CommandContext, providerId: string, modelId: string, mutate: (model: any) => void): Promise<boolean> {
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

export function describeProvider(providerId: string, provider: any): string {
	const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl : "(no baseUrl)";
	const api = typeof provider?.api === "string" ? provider.api : "(no api)";
	return `${providerId}\n${api} • ${modelCount} model${modelCount === 1 ? "" : "s"}\n${endpoint}`;
}

export function describeProviderInline(providerId: string, provider: any): { label: string; suffix: string; searchText: string } {
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

export function providerModelItems(provider: any): SelectItem[] {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models
		.map((model: any) => {
			const id = typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
			if (!id) return null;
			const summary = describeStoredModel(model);
			return {
				value: id,
				label: id,
				description: summary,
				searchText: `${id} ${summary}`,
				details: storedDetails(model, provider),
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

export function findProvidersByEndpoint(config: ModelsConfig, endpoint: string): string[] {
	return Object.entries(config.providers ?? {})
		.filter(([, provider]) => normalizeStoredEndpoint(provider) === endpoint)
		.map(([providerId]) => providerId)
		.sort((a, b) => a.localeCompare(b));
}

// Delete a whole provider from the models config.
export async function removeProvider(ctx: CommandContext, providerId: string): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	if (!config.providers?.[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return false;
	}
	delete config.providers[providerId];
	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	// Drop the stored key along with the provider so no orphan key stays
	// behind. Best-effort: a failing auth write must not undo the deletion.
	try {
		removeProviderApiKey(providerId);
	} catch (error) {
		ctx.ui.notify(`Provider deleted, but its stored key could not be removed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
	// Forget any models.dev mirror attached to this provider.
	unmarkManaged(providerId);
	ctx.ui.notify(`Deleted provider "${providerId}" from ${STORE_PATH}`, "info");
	return true;
}

export async function persistProvider(ctx: CommandContext, providerId: string, providerConfig: any): Promise<boolean> {	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
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
		ctx.ui.notify(`Could not write ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	return true;
}

// Write a provider's key into custom-providers-auth.json (this extension's
// own credential file). Call AFTER persistProvider succeeds. No-op when
// nothing was entered.
export function persistApiKey(
	ctx: CommandContext,
	providerId: string,
	apiKey: { mode: ApiKeyMode; value?: string },
	style: ProviderStyle,
): boolean {
	const serialized = serializeApiKey(apiKey.mode, apiKey.value, style);
	if (!serialized) return true;
	try {
		saveProviderApiKey(providerId, serialized);
		return true;
	} catch (error) {
		ctx.ui.notify(
			`Provider saved, but the API key could not be written to custom-providers-auth.json: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return false;
	}
}

export async function addModelEntriesToProvider(
	ctx: CommandContext,
	providerId: string,
	ids: string[],
	infoById?: Map<string, ModelProbeInfo>,
	// Explicit per-model options from the manual metadata prompts; wins over
	// the resolved values (contextWindow falls back to resolved when unset).
	optionOverrides?: Map<string, ModelOptions>,
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
		return [];
	}

	// Added models default to reasoning on (xhigh ceiling); image, context and
	// max-out come from the probe, then models.dev, then the local rules, then
	// the api fallback, then model-probe's defaults (image off, reasoning on).
	// Tune per model later via Edit provider → Edit a model.
	const defaultOpts: ModelOptions = { reasoning: "xhigh", image: true };
	let detectedCount = 0;
	const saved = await mutateProvider(ctx, providerId, (p) => {
		const models = Array.isArray(p.models) ? p.models : [];
		for (const id of fresh) {
			const mergedInfo = infoById?.get(id);
			if (probeInfoSummary(mergedInfo).length > 0) detectedCount++;
			const override = optionOverrides?.get(id);
			const opts = override
				? {
						...override,
						contextWindow: override.contextWindow ?? mergedInfo?.contextWindow,
						maxTokens: override.maxTokens ?? mergedInfo?.maxTokens,
					}
				: modelOptionsFromProbe(mergedInfo, defaultOpts);
			models.push(buildModelEntry(id, opts));
		}
		p.models = models;
		return true;
	});
	if (saved) {
		const detail =
			detectedCount > 0 ? ` — auto-detected metadata for ${detectedCount} model${detectedCount === 1 ? "" : "s"}` : "";
		ctx.ui.notify(`Added ${fresh.length} model${fresh.length === 1 ? "" : "s"} to "${providerId}"${detail}.`, "info");
	}
	return saved ? fresh : [];
}

// The ollama style leaves a compat object with BOTH flags false; every other
// style writes only supportsDeveloperRole. Keying on compat's presence alone
// misreads plain OpenAI-compatible providers as Ollama.
export function providerStyleOf(provider: unknown): ProviderStyle {
	if (!provider || typeof provider !== "object") return "openai";
	if ("api" in provider) {
		const api = provider.api;
		if (api === "anthropic-messages") return "anthropic";
		if (api === "google-generative-ai") return "gemini";
	}
	if ("compat" in provider && provider.compat && typeof provider.compat === "object") {
		const compat = provider.compat;
		if ("supportsDeveloperRole" in compat && "supportsReasoningEffort" in compat) {
			const developerRole = compat.supportsDeveloperRole;
			const reasoningEffort = compat.supportsReasoningEffort;
			if (developerRole === false && reasoningEffort === false) return "ollama";
		}
	}
	return "openai";
}
