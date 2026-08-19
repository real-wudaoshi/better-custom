import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { addProviderFlow } from "./src/flows/add.ts";
import { deleteProviderFlow } from "./src/flows/delete.ts";
import { editProviderFlow } from "./src/flows/edit.ts";
import { selectOne } from "./src/ui/select.ts";

export default function betterCustomWizard(pi: ExtensionAPI) {
	pi.registerCommand("better-custom", {
		description: "Wizard for adding, editing, or deleting custom providers in ~/.pi/agent/models.json",
		handler: async (_args, ctx) => {
			const action = await selectOne(ctx, "Better custom", ["Add provider", "Edit provider", "Delete provider"]);
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
}
