import { loadModelsConfig, MODELS_JSON_PATH } from "../config.ts";
import { applyKnownModelFallback } from "../known-models.ts";
import { buildProviderConfig } from "../model-entry.ts";
import { describeProbeInfo, probeInfoSummary, probeOpenAIModels } from "../probe.ts";
import { gatewayPreset } from "../presets.ts";
import type { GatewayPresetId } from "../presets.ts";
import type { ApiKeyMode, CommandContext, ModelProbeInfo, ModelsConfig, ProviderApi, ProviderStyle } from "../types.ts";
import { pickMany, selectOne } from "../ui/select.ts";
import {
	promptApiKey,
	promptEndpoint,
	promptGatewayPreset,
	promptModelIdsOneByOne,
	promptProviderId,
	promptProviderStyle,
} from "../ui/prompts.ts";
import { buildProbeUrl, dedupe, hasExplicitScheme } from "../url.ts";
import { collectProbedModelInfo, fetchGatewayWideInfo, findProvidersByEndpoint, persistProvider } from "./shared.ts";

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

async function collectModelIds(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
	apiKey: { mode: ApiKeyMode; value?: string },
	normalizedEndpoint: string,
	trimmedEndpointInput: string,
	presetId: GatewayPresetId,
): Promise<{ ids: string[]; infoById?: Map<string, ModelProbeInfo> } | null> {
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

		// Gateway-wide metadata (one call per source) — fetch BEFORE the picker so
		// it shows real detected values instead of local-rule guesses.
		const profile = gatewayPreset(presetId).profile;
		let gatewayWide: Map<string, ModelProbeInfo> | undefined;
		if (profile.modelInfo || profile.publicCatalog || profile.modelGroupInfo) {
			ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
			gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, profile);
			if (gatewayWide.size > 0) {
				for (const [id, info] of gatewayWide) {
					probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
				}
				for (const item of probed.items) {
					item.description = describeProbeInfo(applyKnownModelFallback(item.value, probed.infoById.get(item.value)));
				}
			}
		}

		const picked = await pickMany(ctx, "Select models", probed.items);
		if (!picked || picked.length === 0) return null;

		const infoById = await collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, presetId, gatewayWide);
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

export async function addProviderFlow(ctx: CommandContext) {
	const styleChoice = await promptProviderStyle(ctx);
	if (!styleChoice) return;
	const { style, api } = styleChoice;

	// Gateways like LiteLLM / One API / New API expose several API flavors
	// (completions, responses, anthropic) behind one endpoint, so the preset
	// applies to every style except Ollama, which has its own native probing.
	let presetId: GatewayPresetId = "auto";
	if (style !== "ollama") {
		const preset = await promptGatewayPreset(ctx);
		if (!preset) return;
		presetId = preset;
	}

	const endpoint = await promptEndpoint(ctx, style, api, presetId);
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

	const collected = await collectModelIds(ctx, style, api, apiKey, endpoint.normalized, endpoint.raw, presetId);
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
		`Saved provider "${providerId}" to ${MODELS_JSON_PATH}` + (summary.length > 0 ? ` — context/vision/reasoning: ${summary.join(", ")}` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}
