import { loadModelsConfig, MODELS_JSON_PATH, saveModelsConfig } from "../config.ts";
import type { CommandContext, ModelsConfig } from "../types.ts";
import { selectOne } from "../ui/select.ts";
import { describeProvider, describeProviderInline } from "./shared.ts";

export async function deleteProviderFlow(ctx: CommandContext) {
	let cursor = 0;
	let deletedAny = false;

	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		config.providers ||= {};
		const providerIds = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
		if (providerIds.length === 0) {
			ctx.ui.notify(
				deletedAny ? `No providers left in ${MODELS_JSON_PATH}` : `No providers found in ${MODELS_JSON_PATH}`,
				deletedAny ? "info" : "warning",
			);
			return;
		}

		const choice = await selectOne(
			ctx,
			"Delete provider",
			providerIds.map((providerId) => {
				const inline = describeProviderInline(providerId, config.providers?.[providerId]);
				return {
					value: providerId,
					label: inline.label,
					suffix: inline.suffix,
					searchText: inline.searchText,
				};
			}),
			{ initialIndex: Math.min(cursor, providerIds.length - 1) },
		);
		if (!choice) return;

		const provider = config.providers[choice];
		const confirmed = await ctx.ui.confirm("Delete provider?", describeProvider(choice, provider));
		const selectedIndex = providerIds.indexOf(choice);
		cursor = selectedIndex;
		if (!confirmed) continue;

		cursor = selectedIndex + 1;
		delete config.providers[choice];

		try {
			saveModelsConfig(config);
		} catch (error) {
			ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		deletedAny = true;
		ctx.ui.notify(`Deleted provider "${choice}" from ${MODELS_JSON_PATH}`, "info");
	}
}
