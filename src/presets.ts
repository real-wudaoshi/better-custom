// Gateway presets: common OpenAI-compatible gateway projects the wizard can
// adapt its probing to. The preset only tunes WHICH metadata sources are tried
// after fetching /models — it never changes the provider config that gets
// written. "auto" tries everything (previous behavior); the named presets skip
// endpoints that are known to be useless on that gateway, saving 404s and
// timeout waits.
export type GatewayPresetId = "auto" | "litellm" | "oneapi" | "newapi" | "openrouter" | "generic";

export type GatewayProbeProfile = {
	modelInfo: boolean; // LiteLLM GET /model/info (server root, one call covers every model)
	modelGroupInfo: boolean; // LiteLLM GET /model_group/info (server root, needs an api key)
	publicCatalog: boolean; // USTC-style GET {site}/api/models/public (no auth)
	perModelDetails: boolean; // OpenAI GET /models/{id}
	modelsDev: boolean; // models.dev catalog matched by base URL (below local rules, above defaults)
};

export type GatewayPreset = {
	id: GatewayPresetId;
	label: string;
	description: string;
	profile: GatewayProbeProfile;
	// These gateways mount the API under /v1, so a bare host gets "/v1" added.
	// LiteLLM serves the API at the root too, so it is left untouched — its
	// /v1 routes are broken on some deployments (e.g. USTC's /v1/models hangs).
	ensureV1: boolean;
};

const FULL: GatewayProbeProfile = { modelInfo: true, modelGroupInfo: true, publicCatalog: true, perModelDetails: true, modelsDev: true };
const NONE: GatewayProbeProfile = { modelInfo: false, modelGroupInfo: false, publicCatalog: false, perModelDetails: false, modelsDev: false };

export const GATEWAY_PRESETS: GatewayPreset[] = [
	{
		id: "auto",
		label: "Auto-detect",
		description: "Try every known metadata source — slowest, but the most thorough",
		profile: FULL,
		ensureV1: false,
	},
	{
		id: "litellm",
		label: "LiteLLM",
		description: "LiteLLM proxy — one-shot /model/info (+ /model_group/info with a key); per-model endpoints carry no metadata",
		profile: { ...FULL, perModelDetails: false, modelsDev: false },
		ensureV1: false,
	},
	{
		id: "oneapi",
		label: "One API",
		description: "One API gateway — /models returns bare ids; metadata only from meta fields if your fork exposes them",
		profile: NONE,
		ensureV1: true,
	},
	{
		id: "newapi",
		label: "New API",
		description: "New API gateway — like One API; supported_endpoint_types are shown when present",
		profile: NONE,
		ensureV1: true,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		description: "OpenRouter — rich inline /models metadata; models.dev catalog as a supplement",
		profile: { ...NONE, perModelDetails: true, modelsDev: true },
		ensureV1: false,
	},
	{
		id: "generic",
		label: "Generic OpenAI-compatible",
		description: "vLLM, LM Studio, LocalAI, Xinference, SGLang, ... — per-model GET /models/{id}, plus the models.dev catalog",
		profile: { ...NONE, perModelDetails: true, modelsDev: true },
		ensureV1: false,
	},
];

export function gatewayPreset(id: GatewayPresetId): GatewayPreset {
	return GATEWAY_PRESETS.find((preset) => preset.id === id) ?? GATEWAY_PRESETS[0];
}
