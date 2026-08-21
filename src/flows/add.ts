import { probeDeveloperRole, probeInfoSummary, probeModels } from "model-probe";
import { resolveApiKeyForProbe } from "../api-key.ts";
import { loadModelsConfig, MODELS_JSON_PATH } from "../config.ts";
import { buildProviderConfig } from "../model-entry.ts";
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
import { buildProbeUrl, dedupe, ensureV1Path, hasExplicitScheme } from "../url.ts";
import { collectProbedModelInfo, fetchGatewayWideInfo, findProvidersByEndpoint, persistProvider, probePickerItems } from "./shared.ts";

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
): Promise<{ ids: string[]; infoById?: Map<string, ModelProbeInfo>; baseUrl?: string } | null> {
	const modelMode = await selectOne(ctx, "Models", ["Auto probe from /models", "Add manually"]);
	if (!modelMode) return null;
	if (modelMode !== "Auto probe from /models") {
		const ids = await promptModelIdsOneByOne(ctx, style);
		return ids ? { ids } : null;
	}

	// Auto probe: pick the gateway type as part of probing — it tunes which
	// metadata sources are tried and whether a bare host gets /v1. Gateways
	// like LiteLLM / One API / New API expose several API flavors behind one
	// endpoint, so the preset applies to every style except Ollama and Gemini,
	// which have their own native probing.
	let baseUrl = normalizedEndpoint;
	while (true) {
		let presetId: GatewayPresetId = "auto";
		if (style !== "ollama" && style !== "gemini") {
			const preset = await promptGatewayPreset(ctx);
			if (!preset) return null;
			presetId = preset;
		}
		const preset = gatewayPreset(presetId);
		const probeBase = preset.ensureV1 ? ensureV1Path(baseUrl) : baseUrl;

		try {
			ctx.ui.notify(`Probing ${buildProbeUrl(probeBase)} ...`, "info");
			const probed = await probeModels(probeBase, resolveApiKeyForProbe(apiKey.mode, apiKey.value));
			// The variant that actually answered (±/v1 adapted) becomes the
			// provider's baseUrl.
			baseUrl = probed.baseUrl;
			if (probed.ids.length === 0) {
				ctx.ui.notify("Probe succeeded but returned no models. Switching to manual entry.", "warning");
				const ids = await promptModelIdsOneByOne(ctx, style);
				return ids ? { ids, baseUrl } : null;
			}

			// Gateway-wide metadata (one call per source) — fetch BEFORE the picker so
			// it shows real detected values instead of local-rule guesses.
			const profile = preset.profile;
			let gatewayWide: Map<string, ModelProbeInfo> | undefined;
			if (profile.modelInfo || profile.publicCatalog || profile.modelGroupInfo) {
				ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
				gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, profile);
				if (gatewayWide.size > 0) {
					for (const [id, info] of gatewayWide) {
						probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
					}
				}
			}

			const picked = await pickMany(ctx, "Select models", probePickerItems(probed.ids, probed.infoById));
			if (!picked || picked.length === 0) return null;

			const infoById = await collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, presetId, gatewayWide);
			return { ids: picked, infoById, baseUrl };
		} catch (error) {
			const schemeHint = hasExplicitScheme(trimmedEndpointInput) ? "" : " No http:// or https:// was provided.";
			ctx.ui.notify(`Auto probe failed: ${error instanceof Error ? error.message : String(error)}.${schemeHint}`, "warning");
			const action = await selectOne(ctx, "Probe failed — what next?", [
				{
					value: "retry",
					label: "Retry",
					description: style === "ollama" || style === "gemini" ? "Probe again" : "Pick the gateway type again and probe again",
				},
				{ value: "manual", label: "Add models manually", description: "Enter model ids by hand" },
				{ value: "cancel", label: "Cancel", description: "Abort adding this provider" },
			]);
			if (action === "retry") continue;
			if (action === "manual") {
				const ids = await promptModelIdsOneByOne(ctx, style);
				// The chosen preset still tells us the URL shape (e.g. New API needs /v1).
				const manualBase = preset.ensureV1 ? ensureV1Path(baseUrl) : baseUrl;
				return ids ? { ids, baseUrl: manualBase } : null;
			}
			return null;
		}
	}
}

export async function addProviderFlow(ctx: CommandContext) {
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
		// answered; otherwise the endpoint as entered (±/v1 from the preset).
		collected.baseUrl ?? endpoint.normalized,
		apiKey,
		dedupe(collected.ids),
		// The reasoning ceiling for thinking models defaults to xhigh; vision /
		// context / reasoning come from the probe (local rules, then model-probe
		// defaults). Tune per model later via Edit provider → Edit a model.
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
