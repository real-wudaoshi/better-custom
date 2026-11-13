import { Key } from "@mariozechner/pi-tui";
import type { CommandContext, ProbeItem, SelectItem } from "../types.ts";
import { showWorkbench, workbenchState } from "./workbench.ts";

export async function selectOne(
	ctx: CommandContext,
	title: string,
	items: Array<string | SelectItem>,
	options?: { initialIndex?: number },
): Promise<string | null> {
	const rows = items.map((item) => typeof item === "string" ? { value: item, label: item } : item);
	if (!rows.length) return null;
	const state = workbenchState(rows[options?.initialIndex ?? 0]?.value);
	const picked = await showWorkbench(ctx, { title, items: rows, state, compact: !rows.some((row) => row.details?.length) });
	return picked?.value ?? null;
}

// Selection and inspection are separate. Tab never changes a checkbox;
// Ctrl+A deliberately selects/deselects only the filtered rows.
export async function pickMany(
	ctx: CommandContext,
	title: string,
	items: ProbeItem[],
	options?: { confirmLabel?: string; initial?: string[] },
): Promise<string[] | null> {
	const selected = new Set(options?.initial ?? []);
	const state = workbenchState(items[0]?.value);
	const label = options?.confirmLabel ?? "Add";
	while (true) {
		const picked = await showWorkbench(ctx, {
			title,
			items, state, enterAction: "apply",
			mark: (row) => selected.has(row.value) ? "[x]" : "[ ]",
			status: (visible) => {
				const hidden = selected.size - visible.filter((row) => selected.has(row.value)).length;
				return `${selected.size} selected${hidden ? ` · ${hidden} hidden` : ""}`;
			},
			onToggle: (row) => { if (!selected.delete(row.value)) selected.add(row.value); },
			onAll: (visible) => {
				const all = visible.length > 0 && visible.every((row) => selected.has(row.value));
				for (const row of visible) { if (all) selected.delete(row.value); else selected.add(row.value); }
			},
			actions: () => [{ id: "apply", label: `${label} (${selected.size})`, key: Key.ctrl("s"), disabled: selected.size === 0 }],
		});
		if (!picked) return null;
		if (selected.size > 0) return items.filter((item) => selected.has(item.value)).map((item) => item.value);
	}
}
