// Probe profile: which metadata sources are tried after fetching /models.
// The wizard always probes with the full profile — every known source. The
// old per-gateway presets (LiteLLM / One API / New API / ...) only skipped
// endpoints that were known to be useless on that gateway; with models.dev
// and the local rules covering metadata, the saved 404s aren't worth an
// extra picker.
export type GatewayProbeProfile = {
	modelInfo: boolean; // LiteLLM GET /model/info (server root, one call covers every model)
	modelGroupInfo: boolean; // LiteLLM GET /model_group/info (server root, needs an api key)
	publicCatalog: boolean; // USTC-style GET {site}/api/models/public (no auth)
	perModelDetails: boolean; // OpenAI GET /models/{id}
	modelsDev: boolean; // models.dev catalog matched by base URL (above local rules, below detected)
};

export const AUTO_PROBE_PROFILE: GatewayProbeProfile = {
	modelInfo: true,
	modelGroupInfo: true,
	publicCatalog: true,
	perModelDetails: true,
	modelsDev: true,
};
