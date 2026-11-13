import { Key } from "@mariozechner/pi-tui";
import type { CommandContext, ModelProbeInfo, SelectItem } from "../types.ts";
import { editableMetadata, editedModelOptions, editorDefaults, editMetadataValue, priceValidation, type ModelEdits } from "./metadata.ts";
import { showWorkbench, workbenchState, type WorkbenchAction, type WorkbenchState } from "./workbench.ts";

export type ReviewOperation = "keep" | "skip" | "add" | "update" | "remove";
export type ReviewItem = SelectItem & {
	kind: "new" | "changed" | "missing" | "same";
	operations: ReviewOperation[];
	initial: ReviewOperation;
	info?: ModelProbeInfo;
	current?: any;
};
export type ReviewState = { view: WorkbenchState; selected: Set<string>; edits: Map<string, ModelEdits> };
export const reviewState = (items: ReviewItem[] = []): ReviewState => ({
	view: workbenchState(items[0]?.value), selected: new Set(items.filter((row) => row.initial === "add" || row.initial === "update").map((row) => row.value)), edits: new Map(),
});
export type ReviewResult = { action: string; decisions: Map<string, ReviewOperation>; edits: Map<string, ModelEdits> };

// Space toggles, Enter confirms, and Right edits the selected model. This is
// also the model step of the provider wizard, so Back preserves the same draft.
export async function reviewChanges(
	ctx: CommandContext, title: string, items: ReviewItem[],
	options?: { state?: ReviewState; actions?: WorkbenchAction[]; applyLabel?: string; subtitle?: string },
): Promise<ReviewResult | null> {
	const state = options?.state ?? reviewState(items);
	const byId = new Map(items.map((row) => [row.value, row]));
	for (const id of state.selected) if (!byId.has(id)) state.selected.delete(id);
	const defaults = new Map(items.filter((row) => row.info).map((row) => [row.value, editorDefaults(row.info!, row.current)]));
	const custom = (id: string) => Object.keys(state.edits.get(id) ?? {}).length > 0;
	const selectable = (row: ReviewItem) => row.kind === "new" || row.kind === "changed" || (row.info !== undefined && custom(row.value));
	const rows: SelectItem[] = items.map((row) => ({ ...row }));
	const update = (row: SelectItem) => {
		const item = byId.get(row.value)!;
		row.tag = item.kind === "missing" ? "not returned · kept" : selectable(item) ? `${item.kind === "new" ? "add" : "update"}${custom(row.value) ? " · custom" : ""}` : "unchanged";
		if (item.info) row.details = editableMetadata(defaults.get(row.value)!, state.edits.get(row.value) ?? {}, item.current);
	};
	rows.forEach(update);
	const invalid = () => {
		for (const id of state.selected) {
			const base = defaults.get(id);
			if (!base) continue;
			const pricingError = priceValidation(base.options.cost, state.edits.get(id)?.cost);
			if (pricingError) return `${id}: ${pricingError}`;
			const value = editedModelOptions(base, state.edits.get(id) ?? {});
			if (value.contextWindow && value.maxTokens && value.maxTokens > value.contextWindow) return `${id}: max output exceeds context`;
		}
		return "";
	};
	const picked = await showWorkbench(ctx, {
		title, subtitle: options?.subtitle, items: rows, state: state.view, enterAction: "apply",
		mark: (row) => selectable(byId.get(row.value)!) ? state.selected.has(row.value) ? "[x]" : "[ ]" : "—",
		status: (visible) => {
			const hidden = state.selected.size - visible.filter((row) => state.selected.has(row.value)).length;
			return invalid() || `${state.selected.size} selected${hidden ? ` · ${hidden} hidden` : ""}`;
		},
		onToggle: (row) => { if (selectable(byId.get(row.value)!) && !state.selected.delete(row.value)) state.selected.add(row.value); },
		onAll: (visible) => {
			const candidates = visible.filter((row) => selectable(byId.get(row.value)!));
			const all = candidates.length > 0 && candidates.every((row) => state.selected.has(row.value));
			for (const row of candidates) { if (all) state.selected.delete(row.value); else state.selected.add(row.value); }
		},
		onEdit: (row, field, value) => {
			const edits = state.edits.get(row.value) ?? {};
			const error = editMetadataValue(defaults.get(row.value)!, edits, field.action!, value);
			if (error) return error;
			if (Object.keys(edits).length) state.edits.set(row.value, edits); else state.edits.delete(row.value);
			if (selectable(byId.get(row.value)!)) state.selected.add(row.value); else state.selected.delete(row.value);
			update(row);
		},
		actions: () => [
			{ id: "apply", label: `${options?.applyLabel ?? "Apply"} (${state.selected.size})`, key: Key.ctrl("s"), disabled: !state.selected.size || !!invalid() },
			...(options?.actions ?? []),
		],
	});
	if (!picked) return null;
	return {
		action: picked.action,
		decisions: new Map(items.map((row) => [row.value, state.selected.has(row.value) ? row.kind === "new" ? "add" : "update" : row.kind === "new" ? "skip" : "keep"])),
		edits: state.edits,
	};
}
