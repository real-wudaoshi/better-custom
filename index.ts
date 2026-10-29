import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { addProviderFlow } from "./src/flows/add.ts";
import { deleteProviderFlow } from "./src/flows/delete.ts";
import { editProviderFlow } from "./src/flows/edit.ts";
import { describeSyncResult, syncAllManaged } from "./src/modelsdev-sync.ts";
import { selectOne } from "./src/ui/select.ts";

export default function customProviderWizard(pi: ExtensionAPI) {
	pi.registerCommand("custom-provider", {
		description: "Wizard for adding, editing, or deleting custom providers in ~/.pi/agent/models.json",
		handler: async (_args, ctx) => {
			const action = await selectOne(ctx, "Custom providers", ["Add provider", "Edit provider", "Delete provider"]);
			if (!action) return;
			if (action === "Edit provider") {
				await editProviderFlow(ctx);
				return;
			}
			if (action === "Delete provider") {
				await deleteProviderFlow(ctx);
				return;
			}
			await addProviderFlow(ctx);
		},
	});

	// Providers added from the models.dev catalog can mirror that catalog.
	// Sync them at session start: new models appear, metadata and prices are
	// refreshed, catalog-dropped models go away. Detached and failure-tolerant
	// so startup never waits on models.dev (offline just means "next time").
	pi.on("session_start", (_event, ctx) => {
		void (async () => {
			try {
				const changed = await syncAllManaged(ctx);
				if (changed.length === 0) return;
				const summary = changed.map(({ providerId, result }) => `${providerId}: ${describeSyncResult(result)}`).join("; ");
				ctx.ui.notify(`models.dev auto-update — ${summary}`, "info");
			} catch {
				// Best-effort background work; a silent retry next session is fine.
			}
		})();
	});
}
