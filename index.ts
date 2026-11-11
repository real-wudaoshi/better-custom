import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadModelsConfig, normalizeStoreIds, readLegacyProviders, STORE_PATH } from "./src/config.ts";
import { addProviderFlow } from "./src/flows/add.ts";
import { editSingleProvider } from "./src/flows/edit.ts";
import { migrateLegacyFlow } from "./src/flows/migrate.ts";
import { describeProviderInline } from "./src/flows/shared.ts";
import { describeSyncResult, syncAllManaged } from "./src/modelsdev-sync.ts";
import { bindRegistrationApi, refreshRegistrations } from "./src/registration.ts";
import type { SelectItem } from "./src/types.ts";
import { selectOne } from "./src/ui/select.ts";

export default function customProviderWizard(pi: ExtensionAPI) {
	// The extension owns its providers in custom-providers.json; pi only sees
	// them because we register them. Bind first, then inject what is stored,
	// then keep the registry in step with every later write.
	bindRegistrationApi(pi);
	// Ids written before the marker changed (custom-foo) are rewritten to the
	// current spelling (custom.foo) before anything is registered.
	normalizeStoreIds();
	refreshRegistrations();

	pi.registerCommand("custom-provider", {
		description: "Manage custom providers stored in ~/.pi/agent/custom-providers.json",
		// One screen: "Add provider" on top, then every provider. Picking a
		// provider opens its menu (models, key, endpoint, rename, delete), and
		// backing out of that menu lands here again.
		handler: async (_args, ctx) => {
			let cursor = 0;
			while (true) {
				let providers: Record<string, any>;
				try {
					providers = loadModelsConfig().providers ?? {};
				} catch (error) {
					ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				const legacy = readLegacyProviders();
				const items: SelectItem[] = [
					{ value: "+add", label: "+ Add provider", description: "From the models.dev catalog, or any compatible endpoint" },
					...Object.keys(providers)
						.sort((a, b) => a.localeCompare(b))
						.map((providerId) => {
							const inline = describeProviderInline(providerId, providers[providerId]);
							return { value: providerId, label: inline.label, suffix: inline.suffix, searchText: inline.searchText };
						}),
				];
				if (legacy.length > 0) {
					items.push({
						value: "+migrate",
						label: `Move ${legacy.length} provider${legacy.length === 1 ? "" : "s"} out of models.json`,
						description: "Earlier versions wrote into pi's models.json — import those entries into this extension's own store",
					});
				}

				const choice = await selectOne(ctx, "Custom providers", items, { initialIndex: Math.min(cursor, items.length - 1) });
				if (!choice) return;
				cursor = items.findIndex((item) => item.value === choice);
				if (choice === "+add") {
					// Adding is its own task: done (or cancelled) means done.
					await addProviderFlow(ctx);
					return;
				}
				if (choice === "+migrate") await migrateLegacyFlow(ctx);
				else await editSingleProvider(ctx, choice);
			}
		},
	});

	// Catalog providers mirror models.dev. Sync at session start: new models
	// appear, metadata and prices are refreshed, catalog-dropped models go away.
	// Detached and failure-tolerant so startup never waits on the network.
	pi.on("session_start", (_event, ctx) => {
		void (async () => {
			try {
				const changed = await syncAllManaged();
				refreshRegistrations();
				if (changed.length === 0) return;
				const summary = changed.map(({ providerId, result }) => `${providerId}: ${describeSyncResult(result)}`).join("; ");
				ctx.ui.notify(`models.dev sync — ${summary}`, "info");
			} catch {
				// Best-effort background work; a silent retry next session is fine.
			}
		})();
	});
}
