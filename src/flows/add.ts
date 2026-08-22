import {
	fetchModelsDevInfoForBaseUrl,
	fetchModelsDevModels,
	fetchModelsDevProviders,
	finalizeModelInfo,
	probeDeveloperRole,
	probeInfoSummary,
	probeModels,
	type ModelsDevProvider,
} from "model-probe";
import { resolveApiKeyForProbe } from "../api-key.ts";
import { loadModelsConfig, MODELS_JSON_PATH } from "../config.ts";
import { buildProviderConfig } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import type { ApiKeyMode, CommandContext, ModelProbeInfo, ModelsConfig, ProviderApi, ProviderStyle } from "../types.ts";
import { pickMany, selectOne } from "../ui/select.ts";
import { promptApiKey, promptEndpoint, promptModelIdsOneByOne, promptProviderId, promptProviderStyle } from "../ui/prompts.ts";
import { buildProbeUrl, dedupe, hasExplicitScheme, normalizeEndpoint } from "../url.ts";
import { collectProbedModelInfo, fetchGatewayWideInfo, findProvidersByEndpoint, persistProvider, probePickerItems } from "./shared.ts";

// Pick a known API provider from the models.dev catalog.
async function pickCatalogProvider(ctx: CommandContext): Promise<ModelsDevProvider | null> {
	ctx.ui.notify("Fetching the models.dev provider catalog ...", "info");
	let providers: Map<string, ModelsDevProvider>;
	try {
		providers = await fetchModelsDevProviders();
	} catch (error) {
		ctx.ui.notify(`Could not fetch the models.dev catalog: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}

	const items = [...providers.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((p) => ({
			value: p.id,
			label: p.name,
			suffix: ` • ${p.baseUrl}`,
			description: p.env.length > 0 ? `env: ${p.env.join(" / ")}` : undefined,
			searchText: `${p.id} ${p.name} ${p.baseUrl}`,
		}));
	const choice = await selectOne(ctx, "models.dev providers", items);
	if (!choice) return null;
	return providers.get(choice) ?? null;
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

// Catalog path: the provider is known to models.dev, so the model list and
// its metadata come from the catalog — no probing of the gateway at all.
async function addFromCatalog(ctx: CommandContext) {
	const provider = await pickCatalogProvider(ctx);
	if (!provider) return;

	// Catalog providers are OpenAI-compatible by construction (they carry a
	// baseUrl); chat completions is the flavor every one of them supports.
	const style: ProviderStyle = "openai";
	const api: ProviderApi = "openai-completions";

	let endpoint: string;
	try {
		endpoint = normalizeEndpoint(provider.baseUrl, api);
	} catch (error) {
		ctx.ui.notify(`Invalid catalog endpoint "${provider.baseUrl}": ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (!(await confirmEndpointReuse(ctx, endpoint))) return;

	if (provider.env.length > 0) {
		ctx.ui.notify(`${provider.name} expects the ${provider.env.join(" / ")} env var.`, "info");
	}
	const providerId = await promptProviderId(ctx, endpoint, provider.id);
	if (!providerId) return;

	const apiKey = await promptApiKey(ctx);
	if (!apiKey) return;
	if (apiKey.mode === "none") {
		ctx.ui.notify('No API key selected. Using "dummy" automatically in the models config.', "info");
	}

	ctx.ui.notify(`Fetching the model list for ${provider.name} from models.dev ...`, "info");
	const catalog = await fetchModelsDevModels(provider.id);
	let ids: string[];
	let infoById: Map<string, ModelProbeInfo> | undefined;
	if (catalog.size > 0) {
		const picked = await pickMany(ctx, "Select models", probePickerItems([...catalog.keys()], new Map(), catalog));
		if (!picked || picked.length === 0) return;
		ids = picked;
		infoById = finalizeModelInfo(picked, [], { modelsDev: catalog });
	} else {
		ctx.ui.notify(`models.dev lists no models for ${provider.name} — enter ids by hand.`, "warning");
		const manual = await promptModelIdsOneByOne(ctx, style);
		if (!manual) return;
		ids = manual;
	}

	// No gateway calls on this path — developer-role support stays at the safe
	// default (off). Flip it later via Edit provider if the endpoint supports it.
	const providerConfig = buildProviderConfig(
		style,
		api,
		endpoint,
		apiKey,
		dedupe(ids),
		// The reasoning ceiling for thinking models defaults to xhigh; vision /
		// context / reasoning come from the catalog. Tune per model later via
		// Edit provider → Edit a model.
		{ reasoning: "xhigh", vision: true },
		undefined,
		infoById,
		undefined,
	);
	if (!(await persistProvider(ctx, providerId, providerConfig))) return;

	const withMeta = infoById ? ids.filter((id) => probeInfoSummary(infoById.get(id) ?? {}).length > 0).length : 0;
	ctx.ui.notify(
		`Saved provider "${providerId}" to ${MODELS_JSON_PATH} — models and metadata from models.dev` +
			(withMeta > 0 ? ` (${withMeta} model${withMeta === 1 ? "" : "s"} with metadata)` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}

// Model collection for a custom endpoint: auto-detect probes the gateway,
// manual entry skips all network calls.
async function collectModelIds(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
	apiKey: { mode: ApiKeyMode; value?: string },
	normalizedEndpoint: string,
	trimmedEndpointInput: string,
): Promise<{ ids: string[]; infoById?: Map<string, ModelProbeInfo>; baseUrl?: string } | null> {
	const modelMode = await selectOne(ctx, "Models", ["Auto-detect from the endpoint", "Add manually"]);
	if (!modelMode) return null;
	if (modelMode !== "Auto-detect from the endpoint") {
		const ids = await promptModelIdsOneByOne(ctx, style);
		return ids ? { ids } : null;
	}

	let baseUrl = normalizedEndpoint;
	while (true) {
		try {
			ctx.ui.notify(`Probing ${buildProbeUrl(baseUrl)} ...`, "info");
			const probed = await probeModels(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value));
			// The variant that actually answered (±/v1 adapted) becomes the
			// provider's baseUrl.
			baseUrl = probed.baseUrl;
			if (probed.ids.length === 0) {
				ctx.ui.notify("Probe succeeded but returned no models. Switching to manual entry.", "warning");
				const ids = await promptModelIdsOneByOne(ctx, style);
				return ids ? { ids, baseUrl } : null;
			}

			// Gateway-wide metadata (one call per source) — fetch BEFORE the picker so
			// it shows real detected values instead of catalog/rule guesses.
			let gatewayWide: Map<string, ModelProbeInfo> | undefined;
			if (AUTO_PROBE_PROFILE.modelInfo || AUTO_PROBE_PROFILE.publicCatalog || AUTO_PROBE_PROFILE.modelGroupInfo) {
				ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
				gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, AUTO_PROBE_PROFILE);
				if (gatewayWide.size > 0) {
					for (const [id, info] of gatewayWide) {
						probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
					}
				}
			}

			// models.dev catalog tier — above the local rules, below detected values.
			const modelsDev = style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(probed.baseUrl) : undefined;

			const picked = await pickMany(ctx, "Select models", probePickerItems(probed.ids, probed.infoById, modelsDev));
			if (!picked || picked.length === 0) return null;

			const infoById = await collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, gatewayWide, modelsDev);
			return { ids: picked, infoById, baseUrl };
		} catch (error) {
			const schemeHint = hasExplicitScheme(trimmedEndpointInput) ? "" : " No http:// or https:// was provided.";
			ctx.ui.notify(`Auto probe failed: ${error instanceof Error ? error.message : String(error)}.${schemeHint}`, "warning");
			const action = await selectOne(ctx, "Probe failed — what next?", [
				{ value: "retry", label: "Retry", description: "Probe again" },
				{ value: "manual", label: "Add models manually", description: "Enter model ids by hand" },
				{ value: "cancel", label: "Cancel", description: "Abort adding this provider" },
			]);
			if (action === "retry") continue;
			if (action === "manual") {
				const ids = await promptModelIdsOneByOne(ctx, style);
				return ids ? { ids, baseUrl } : null;
			}
			return null;
		}
	}
}

async function addCustom(ctx: CommandContext) {
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

	// pi sends system messages with the "developer" role for reasoning models
	// when the endpoint supports it; gateways that don't (e.g. Kimi's
	// subscription endpoint) answer 400. Probe it once with a tiny completion.
	let developerRole: boolean | undefined;
	if (style === "openai" || style === "openai-responses") {
		const probeBase = collected.baseUrl ?? endpoint.normalized;
		developerRole = await probeDeveloperRole(probeBase, resolveApiKeyForProbe(apiKey.mode, apiKey.value), collected.ids[0]);
		if (developerRole === false) {
			ctx.ui.notify("This endpoint rejects the developer role — it will be disabled in the provider config.", "info");
		} else if (developerRole === undefined) {
			ctx.ui.notify("Could not probe developer-role support — defaulting to off (safe for every endpoint).", "info");
		}
	}

	const providerConfig = buildProviderConfig(
		style,
		api,
		// After a successful probe this is the base variant that actually
		// answered; otherwise the endpoint as entered.
		collected.baseUrl ?? endpoint.normalized,
		apiKey,
		dedupe(collected.ids),
		// The reasoning ceiling for thinking models defaults to xhigh; vision /
		// context / reasoning come from the probe (models.dev, local rules,
		// then model-probe defaults). Tune per model later via Edit provider →
		// Edit a model.
		{ reasoning: "xhigh", vision: true },
		undefined,
		collected.infoById,
		developerRole,
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
	const defaultedCount = collected.ids.length - probedCount - inferredCount;
	const summary: string[] = [];
	if (probedCount > 0) summary.push(`detected ${probedCount}`);
	if (inferredCount > 0) summary.push(`inferred from known models ${inferredCount}`);
	if (defaultedCount > 0) summary.push(`defaults ${defaultedCount}`);
	ctx.ui.notify(
		`Saved provider "${providerId}" to ${MODELS_JSON_PATH}` + (summary.length > 0 ? ` — context/vision/reasoning: ${summary.join(", ")}` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}

export async function addProviderFlow(ctx: CommandContext) {
	const source = await selectOne(ctx, "Add provider", [
		{
			value: "catalog",
			label: "From models.dev catalog",
			description: "Known API providers (OpenRouter, DeepSeek, ...) — model list and metadata from models.dev, no probing",
		},
		{ value: "custom", label: "Custom endpoint", description: "Any compatible endpoint — auto-detect models, or add them by hand" },
	]);
	if (source === "catalog") return addFromCatalog(ctx);
	if (source === "custom") return addCustom(ctx);
}
