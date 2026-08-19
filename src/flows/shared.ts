import { loadModelsConfig, MODELS_JSON_PATH, saveModelsConfig } from "../config.ts";
import { applyKnownModelFallback } from "../known-models.ts";
import { buildModelEntry, modelIdOf, modelOptionsFromProbe, readModelOptions } from "../model-entry.ts";
import {
	enrichLiteLLMModelGroupInfo,
	enrichLiteLLMModelInfo,
	enrichOllamaModelDetails,
	enrichOpenAIModelDetails,
	enrichPublicModelInfo,
	probeInfoSummary,
} from "../probe.ts";
import { gatewayPreset } from "../presets.ts";
import type { GatewayPresetId, GatewayProbeProfile } from "../presets.ts";
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

			const details: string[] = [];
			if (model && typeof model === "object") {
				if (model.reasoning === true) {
					const opts = readModelOptions(model);
					details.push(`reasoning:${opts.reasoning}`);
				}
				if (Array.isArray(model.input) && model.input.includes("image")) details.push("vision");
				if (typeof model.contextWindow === "number") details.push(`context ${model.contextWindow}`);
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

export function findProvidersByEndpoint(config: ModelsConfig, endpoint: string): string[] {
	return Object.entries(config.providers ?? {})
		.filter(([, provider]) => normalizeStoredEndpoint(provider) === endpoint)
		.map(([providerId]) => providerId)
		.sort((a, b) => a.localeCompare(b));
}

export async function persistProvider(ctx: CommandContext, providerId: string, providerConfig: any): Promise<boolean> {
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

export async function addModelEntriesToProvider(
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
			// context/vision/reasoning/max-tokens for well-known models from the
			// built-in rules.
			const mergedInfo = applyKnownModelFallback(id, info);
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

// Gateway-wide metadata sources: each answers for EVERY model in a single
// call (LiteLLM /model/info, /model_group/info, the site public catalog).
// Cheap enough to run before the model picker so it can show real values.
// Ollama has no gateway-wide source — its native probing is per-model.
export async function fetchGatewayWideInfo(
	style: ProviderStyle,
	apiKey: { mode: ApiKeyMode; value?: string },
	baseUrl: string,
	profile: GatewayProbeProfile,
): Promise<Map<string, ModelProbeInfo>> {
	const out = new Map<string, ModelProbeInfo>();
	if (style === "ollama") return out;

	if (profile.modelInfo) {
		for (const [id, info] of await enrichLiteLLMModelInfo(baseUrl, apiKey.mode, apiKey.value)) {
			out.set(id, info);
		}
	}
	// USTC-style site catalog /api/models/public (no auth) — authoritative
	// context_window, so its values override what LiteLLM endpoints report.
	if (profile.publicCatalog) {
		for (const [id, info] of await enrichPublicModelInfo(baseUrl)) {
			out.set(id, { ...(out.get(id) ?? {}), ...info });
		}
	}
	// LiteLLM /model_group/info (server root, requires api key) — fills gaps the
	// standard probes missed (e.g. when /model/info needs admin auth).
	if (profile.modelGroupInfo) {
		for (const [id, info] of await enrichLiteLLMModelGroupInfo(baseUrl, apiKey.mode, apiKey.value, [])) {
			const existing = out.get(id);
			if (!existing) {
				out.set(id, info);
				continue;
			}
			const filled = { ...existing };
			if (filled.contextWindow === undefined && info.contextWindow !== undefined) filled.contextWindow = info.contextWindow;
			if (filled.vision === undefined && info.vision !== undefined) filled.vision = info.vision;
			if (filled.reasoning === undefined && info.reasoning !== undefined) filled.reasoning = info.reasoning;
			out.set(id, filled);
		}
	}
	return out;
}

export async function collectProbedModelInfo(
	ctx: CommandContext,
	style: ProviderStyle,
	apiKey: { mode: ApiKeyMode; value?: string },
	baseUrl: string,
	ids: string[],
	listInfo: Map<string, ModelProbeInfo>,
	presetId: GatewayPresetId = "auto",
	gatewayWide?: Map<string, ModelProbeInfo>,
): Promise<Map<string, ModelProbeInfo>> {
	ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
	const profile = gatewayPreset(presetId).profile;

	const merged = new Map(listInfo);
	const gw = gatewayWide ?? (await fetchGatewayWideInfo(style, apiKey, baseUrl, profile));
	for (const [id, info] of gw) {
		merged.set(id, { ...(merged.get(id) ?? {}), ...info });
	}

	// Per-model details for the picked ids. Skipped when a gateway-wide source
	// already answered for everything (LiteLLM's /models/{id} has no metadata).
	let details = new Map<string, ModelProbeInfo>();
	if (style === "ollama") {
		details = await enrichOllamaModelDetails(baseUrl, apiKey.mode, apiKey.value, ids);
	} else if (profile.perModelDetails && gw.size === 0) {
		details = await enrichOpenAIModelDetails(baseUrl, apiKey.mode, apiKey.value, ids);
	}
	for (const [id, info] of details) {
		merged.set(id, { ...(merged.get(id) ?? {}), ...info });
	}
	// Fallback: when a gateway exposes no metadata (stock One API / New API,
	// bare proxies), classify well-known models with the local rules instead of
	// leaving contextWindow/vision/reasoning unset.
	for (const id of ids) {
		const filled = applyKnownModelFallback(id, merged.get(id));
		if (filled) merged.set(id, filled);
	}
	return merged;
}
