import { Key } from "@mariozechner/pi-tui";
import {
	chatModelCandidates, fetchModelMetadata, fetchModelsDevProviders, probeDeveloperRole,
	type ModelsDevProvider, type MetadataContext,
} from "model-probe";
import { resolveApiKeyForProbe } from "../api-key.ts";
import { loadModelsConfig, STORE_PATH } from "../config.ts";
import { summarizeOrigins } from "../format.ts";
import { buildProviderConfig } from "../model-entry.ts";
import type { CommandContext, ModelProbeInfo } from "../types.ts";
import { panelConfirm } from "../ui/panel.ts";
import { selectOne } from "../ui/select.ts";
import { promptManualModels, promptProviderConnection, type ProviderConnection } from "../ui/prompts.ts";
import { editedModelOptions, editorDefaults } from "../ui/metadata.ts";
import { reviewChanges, reviewState, type ReviewItem } from "../ui/review.ts";
import { markManaged } from "../modelsdev-sync.ts";
import { findProvidersByEndpoint, persistApiKey, persistProvider } from "./shared.ts";

async function pickCatalogProvider(ctx: CommandContext): Promise<ModelsDevProvider | null> {
	ctx.ui.notify("Fetching the models.dev provider catalog ...", "info");
	try {
		const providers = await fetchModelsDevProviders();
		const picked = await selectOne(ctx, "models.dev providers", [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((provider) => ({
			value: provider.id, label: provider.name, description: provider.baseUrl, searchText: `${provider.id} ${provider.name} ${provider.baseUrl}`,
		})));
		return picked ? providers.get(picked) ?? null : null;
	} catch (error) { ctx.ui.notify(`Could not fetch the catalog: ${String(error)}`, "error"); return null; }
}

async function confirmEndpointReuse(ctx: CommandContext, endpoint: string): Promise<boolean> {
	try {
		const existing = findProvidersByEndpoint(loadModelsConfig(), endpoint);
		return !existing.length || await panelConfirm(ctx, "Endpoint already exists", `Already used by ${existing.join(", ")}. Add another provider at this endpoint?`);
	} catch (error) { ctx.ui.notify(`Could not read ${STORE_PATH}: ${String(error)}`, "error"); return false; }
}

// One draft owns both steps. No provider/auth writes happen until the model
// step is confirmed. Back edits the same connection, rather than restarting.
async function runProviderWizard(ctx: CommandContext, catalogProvider?: ModelsDevProvider): Promise<string | undefined> {
	const preset = catalogProvider ? { endpoint: catalogProvider.baseUrl, suggestion: catalogProvider.id, catalog: catalogProvider.name } : undefined;
	let connection: ProviderConnection | undefined;
	let stage: "connection" | "models" = "connection";
	let fingerprint = "", approvedEndpoint = "", issue: string | undefined;
	let baseUrl = "", context: MetadataContext | undefined;
	let catalogIds: string[] = [];
	let infos = new Map<string, ModelProbeInfo>();
	const manualIds = new Set<string>();
	const modelState = reviewState();
	const metadataOptions = () => ({
		baseUrl: connection!.endpoint.normalized,
		api: connection!.api,
		apiKey: resolveApiKeyForProbe(connection!.apiKey.mode, connection!.apiKey.value),
		ollama: connection!.style === "ollama",
		catalogProviderId: catalogProvider?.id,
	});
	const discover = async () => {
		issue = undefined;
		try {
			const batch = await fetchModelMetadata([], {
				...metadataOptions(), profile: { perModelDetails: false },
			});
			context = batch.context;
			baseUrl = batch.baseUrl ?? metadataOptions().baseUrl;
			catalogIds = catalogProvider ? batch.ids : [];
			const manual = [...manualIds].filter((id) => !batch.infoById.has(id));
			const extra = manual.length ? await fetchModelMetadata(manual, { ...metadataOptions(), context }) : undefined;
			infos = new Map([...batch.infoById, ...(extra?.infoById ?? [])]);
			if (!infos.size) issue = "No models returned. Use Add by ID or Back.";
		} catch (error) {
			issue = "Discovery failed: " + String(error);
		}
	};
	while (true) {
		if (stage === "connection") {
			const next = await promptProviderConnection(ctx, preset, connection);
			if (!next) return;
			connection = next;
			if (approvedEndpoint !== next.endpoint.normalized) {
				if (!(await confirmEndpointReuse(ctx, next.endpoint.normalized))) continue;
				approvedEndpoint = next.endpoint.normalized;
			}
			const signature = JSON.stringify([next.endpoint.normalized, next.api, next.apiKey]);
			if (signature !== fingerprint) {
				fingerprint = signature; baseUrl = next.endpoint.normalized;
				context = undefined; infos = new Map(); catalogIds = [];
				await discover();
			}
			stage = "models";
		}
		const items: ReviewItem[] = [...infos].map(([id, info]) => ({ value: id, label: id, info, kind: "new", operations: ["skip", "add"], initial: "skip" }));
		const result = await reviewChanges(ctx, "Add provider · 2/2 Models", items, {
			state: modelState, applyLabel: "Create provider", subtitle: issue,
			actions: [
				{ id: "discover", label: catalogProvider ? "Reload catalog" : "Discover", key: Key.ctrl("r") },
				{ id: "manual", label: "Add by ID", key: Key.ctrl("n") },
				{ id: "back", label: "Back", key: Key.ctrl("b") },
			],
		});
		if (!result || result.action === "back") { stage = "connection"; continue; }
		if (result.action === "discover") { await discover(); continue; }
		if (result.action === "manual") {
			const manual = await promptManualModels(ctx, connection!.style, { defaults: infos, metadata: { ...metadataOptions(), context } });
			if (manual) {
				for (const id of manual.ids) {
					manualIds.add(id);
					infos.set(id, manual.infoById.get(id)!);
					modelState.edits.set(id, manual.edits.get(id) ?? {}); modelState.selected.add(id);
				}
				// Returning from a child form must not leave focus on "Add by ID":
				// Enter should confirm the new selection, not open that form again.
				Object.assign(modelState.view, { query: "", value: manual.ids[0], focus: "list", bodyFocus: "list", detail: 0, scroll: 0, action: 0 });
				issue = undefined;
			}
			continue;
		}
		if (result.action !== "apply") continue;
		const ids = [...result.decisions].filter(([, action]) => action === "add").map(([id]) => id);
		if (!ids.length) continue;
		const { infoById } = await fetchModelMetadata(ids, { ...metadataOptions(), context });
		const overrides = new Map(ids.map((id) => [id, editedModelOptions(editorDefaults(infoById.get(id) ?? infos.get(id)!), result.edits.get(id) ?? {})]));
		let developerRole: boolean | undefined;
		if (!catalogProvider && (connection!.style === "openai" || connection!.style === "openai-responses")) {
			developerRole = await probeDeveloperRole(baseUrl, resolveApiKeyForProbe(connection!.apiKey.mode, connection!.apiKey.value), chatModelCandidates(ids));
		}
		const provider = buildProviderConfig(connection!.style, connection!.api, baseUrl || connection!.endpoint.normalized, connection!.apiKey, ids,
			{ reasoning: "xhigh", image: false }, undefined, infoById, developerRole, overrides);
		if (!(await persistProvider(ctx, connection!.providerId, provider))) return;
		persistApiKey(ctx, connection!.providerId, connection!.apiKey, connection!.style);
		if (catalogProvider && catalogIds.length) markManaged(connection!.providerId, catalogProvider.id, ids, catalogIds);
		const origins = summarizeOrigins(ids, infoById);
		ctx.ui.notify(`Created "${connection!.providerId}" with ${ids.length} model(s)${origins ? ` · ${origins}` : ""}.`, "info");
		return connection!.providerId;
	}
}

export async function addProviderFlow(ctx: CommandContext): Promise<string | undefined> {
	const source = await selectOne(ctx, "Add provider", [
		{ value: "catalog", label: "From models.dev catalog", description: "Known providers and catalog synchronization" },
		{ value: "custom", label: "Custom endpoint", description: "Configure the connection, then discover or add models" },
	]);
	if (source === "custom") return runProviderWizard(ctx);
	if (source === "catalog") { const provider = await pickCatalogProvider(ctx); if (provider) return runProviderWizard(ctx, provider); }
}
