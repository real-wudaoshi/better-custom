import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { loadModelsConfig, normalizeStoreIds, readLegacyProviders, STORE_PATH } from "./src/config.ts";
import { addProviderFlow } from "./src/flows/add.ts";
import { editSingleProvider, editProviderConnection, providerConnectionDetails } from "./src/flows/edit.ts";
import { migrateLegacyFlow } from "./src/flows/migrate.ts";
import { managedProvider, describeSyncResult, syncAllManaged } from "./src/modelsdev-sync.ts";
import { bindRegistrationApi, refreshRegistrations } from "./src/registration.ts";
import { showWorkbench, workbenchState } from "./src/ui/workbench.ts";

export default function customProviderWizard(pi: ExtensionAPI) {
	bindRegistrationApi(pi);
	normalizeStoreIds();
	refreshRegistrations();

	pi.registerCommand("custom-provider", {
		description: "Browse custom providers, inspect model metadata, and review configuration changes",
		handler: async (_args, ctx) => {
			const state = workbenchState();
			while (true) {
				let providers: Record<string, any>;
				try { providers = loadModelsConfig().providers ?? {}; }
				catch (error) { ctx.ui.notify(`Could not read ${STORE_PATH}: ${String(error)}`, "error"); return; }
				const legacy = readLegacyProviders();
				const items = Object.keys(providers).sort((a, b) => a.localeCompare(b)).map((id) => {
					const provider = providers[id];
					const count = Array.isArray(provider.models) ? provider.models.length : 0;
					const managed = managedProvider(id);
					return {
						value: id, label: id, description: `${count} models · ${provider.api ?? "API not set"}`, tag: managed ? "catalog sync" : "static",
						searchText: `${id} ${provider.baseUrl ?? ""} ${provider.api ?? ""}`,
						details: [
							...providerConnectionDetails(id, provider),
							...(managed ? [{ title: "Catalog sync", lines: [`models.dev/${managed.modelsDevProviderId} · at session start`] }] : []),
						],
					};
				});
				const choice = await showWorkbench(ctx, {
					title: "Custom providers",
					items, state,
					onEdit: (row, field, value) => {
						const error = editProviderConnection(row.value, field.action!, value, providers[row.value]);
						if (error) return error;
						const updated = loadModelsConfig().providers?.[row.value];
						if (!updated) return "Provider no longer exists.";
						const managed = managedProvider(row.value);
						row.details = [
							...providerConnectionDetails(row.value, updated, providers[row.value]),
							...(managed ? [{ title: "Catalog sync", lines: [`models.dev/${managed.modelsDevProviderId} · at session start`] }] : []),
						];
						row.searchText = `${row.value} ${updated.baseUrl ?? ""} ${updated.api ?? ""}`;
					},
					empty: "No providers yet. Ctrl+N or Tab → Add provider to get started.",
					actions: [
						{ id: "add", label: "+ Add provider", key: Key.ctrl("n") },
						...(legacy.length ? [{ id: "migrate", label: `Import legacy (${legacy.length})` }] : []),
					],
				});
				if (!choice || choice.action === "close") return;
				try {
					if (choice.action === "add") {
						const id = await addProviderFlow(ctx);
						if (id) { state.query = ""; state.value = id; await editSingleProvider(ctx, id); }
					} else if (choice.action === "migrate") await migrateLegacyFlow(ctx);
					else if (choice.value) await editSingleProvider(ctx, choice.value);
				} catch (error) { ctx.ui.notify(`Could not complete this action: ${String(error)}`, "error"); }
			}
		},
	});

	// Background catalog synchronization remains independent of the UI.
	pi.on("session_start", (_event, ctx) => {
		void (async () => {
			try {
				const changed = await syncAllManaged();
				refreshRegistrations();
				if (!changed.length) return;
				const summary = changed.map(({ providerId, result }) => `${providerId}: ${describeSyncResult(result)}`).join("; ");
				ctx.ui.notify(`models.dev sync — ${summary}`, "info");
			} catch { /* Best-effort, never block session startup. */ }
		})();
	});
}
