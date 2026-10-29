// One-time import of providers that still live in pi's models.json. The store
// is the extension's own now; this moves picked entries (and their keys) over
// and takes them out of pi's files.
import { importLegacyProviders, readLegacyProviders } from "../config.ts";
import type { CommandContext } from "../types.ts";
import { pickMany } from "../ui/select.ts";

export async function migrateLegacyFlow(ctx: CommandContext): Promise<void> {
	const legacy = readLegacyProviders();
	if (legacy.length === 0) {
		ctx.ui.notify("Nothing to import — models.json has no providers.", "info");
		return;
	}

	const picked = await pickMany(
		ctx,
		"Move providers out of models.json",
		legacy.map((entry) => {
			const models = Array.isArray(entry.provider?.models) ? entry.provider.models.length : 0;
			const endpoint = typeof entry.provider?.baseUrl === "string" ? entry.provider.baseUrl : "(no baseUrl)";
			return {
				value: entry.id,
				label: entry.id,
				description: `${endpoint} • ${models} model${models === 1 ? "" : "s"}${entry.apiKey ? " • has key" : ""}`,
			};
		}),
	);
	if (!picked || picked.length === 0) return;

	const target = (id: string) => (id.startsWith("custom-") ? id : `custom-${id}`);
	const confirmed = await ctx.ui.confirm(
		"Move providers?",
		`Move ${picked.length} provider${picked.length === 1 ? "" : "s"} into this extension's own store:\n` +
			`${picked.map((id) => `- ${id} → ${target(id)}`).join("\n")}\n\n` +
			"They are removed from models.json (and their keys from auth.json) afterwards. " +
			"Your other models.json entries are untouched.",
	);
	if (!confirmed) return;

	let result: { imported: string[]; skipped: string[] };
	try {
		result = importLegacyProviders(picked);
	} catch (error) {
		ctx.ui.notify(`Import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	if (result.imported.length > 0) {
		ctx.ui.notify(`Imported ${result.imported.length} provider${result.imported.length === 1 ? "" : "s"}: ${result.imported.join(", ")}`, "info");
	}
	if (result.skipped.length > 0) {
		ctx.ui.notify(`Skipped (already in the store): ${result.skipped.join(", ")}`, "warning");
	}
}
