import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { importLegacyProviders, normalizeStoreIds, readLegacyProviders } from "./src/config.ts";
import { addProviderFlow } from "./src/flows/add.ts";
import { deleteProviderFlow } from "./src/flows/delete.ts";
import { editProviderFlow } from "./src/flows/edit.ts";
import { migrateLegacyFlow } from "./src/flows/migrate.ts";
import { describeSyncResult, syncAllManaged } from "./src/modelsdev-sync.ts";
import { bindRegistrationApi, refreshRegistrations } from "./src/registration.ts";
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
		handler: async (_args, ctx) => {
			const legacy = readLegacyProviders();
			const actions: Array<{ value: string; label: string; description?: string }> = [
				{ value: "add", label: "Add provider" },
				{ value: "edit", label: "Edit provider" },
				{ value: "delete", label: "Delete provider" },
			];
			if (legacy.length > 0) {
				actions.push({
					value: "migrate",
					label: `Move ${legacy.length} provider${legacy.length === 1 ? "" : "s"} out of models.json`,
					description: "Earlier versions wrote into pi's models.json — import those entries into this extension's own store",
				});
			}
			const action = await selectOne(ctx, "Custom providers", actions);
			if (!action) return;
			if (action === "edit") {
				await editProviderFlow(ctx);
				return;
			}
			if (action === "delete") {
				await deleteProviderFlow(ctx);
				return;
			}
			if (action === "migrate") {
				await migrateLegacyFlow(ctx);
				return;
			}
			await addProviderFlow(ctx);
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
