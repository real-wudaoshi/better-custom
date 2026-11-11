import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { CommandContext, ProbeItem, SelectItem } from "../types.ts";

const MAX_VISIBLE = 12;
// Short menus don't show a search box; it appears as soon as something is typed.
const SEARCH_BOX_FROM = 8;

type BoxState = "on" | "mid" | "off";

// One list component behind every menu and picker, so they all move, search
// and cancel the same way.
type Picker<T> = {
	title: string;
	rows: SelectItem[];
	initialIndex?: number;
	/** Checkbox state of a row (multi-select pickers). Plain menus have none. */
	box?: (row: SelectItem) => BoxState;
	/** Line under the title, e.g. the selection count. */
	status?: (visible: SelectItem[]) => string;
	/** Key hints for the footer. */
	hints: () => string[];
	legend?: string;
	onSpace?: (row: SelectItem) => void;
	onTab?: (visible: SelectItem[]) => void;
	/** The result to close with, or undefined to stay open. */
	onEnter: (row: SelectItem | undefined) => { result: T } | undefined;
};

async function runPicker<T>(ctx: CommandContext, picker: Picker<T>): Promise<T | null> {
	const { rows } = picker;
	return await ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		let cursor = Math.max(0, Math.min(picker.initialIndex ?? 0, rows.length - 1));
		let query = "";
		let cachedLines: string[] | undefined;

		const visibleRows = () => {
			const needle = query.trim().toLowerCase();
			if (!needle) return rows;
			return rows.filter((row) =>
				`${row.label} ${picker.box ? row.value : ""} ${row.suffix ?? ""} ${row.description ?? ""} ${row.searchText ?? ""}`.toLowerCase().includes(needle),
			);
		};
		const refresh = () => {
			const count = visibleRows().length;
			cursor = count === 0 ? 0 : Math.min(cursor, count - 1);
			cachedLines = undefined;
			tui.requestRender();
		};
		const boxText = (state: BoxState) =>
			state === "on" ? theme.fg("success", "[x]") : state === "mid" ? theme.fg("warning", "[-]") : theme.fg("muted", "[ ]");

		return {
			render(width: number) {
				if (cachedLines) return cachedLines;
				const visible = visibleRows();
				const safeWidth = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));
				const border = theme.fg("accent", "─".repeat(safeWidth));

				add(border);
				add(` ${theme.fg("accent", theme.bold(picker.title))}`);
				const status = picker.status?.(visible);
				if (status) add(` ${theme.fg("muted", status)}`);
				if (query || rows.length >= SEARCH_BOX_FROM) add(` ${theme.fg("text", `Search: ${query || "-"}`)}`);
				add();

				if (visible.length === 0) {
					add(theme.fg("warning", " No matches — esc clears the search."));
				} else {
					const start = Math.max(0, Math.min(cursor - Math.floor(MAX_VISIBLE / 2), Math.max(0, visible.length - MAX_VISIBLE)));
					const end = Math.min(visible.length, start + MAX_VISIBLE);
					for (let i = start; i < end; i++) {
						const row = visible[i];
						const active = i === cursor;
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						const label = active ? theme.fg("accent", row.label) : theme.fg("text", row.label);
						const suffix = row.suffix ? theme.fg("dim", row.suffix) : "";
						if (picker.box) {
							// Pickers keep one row per model so a long list stays scannable.
							const description = row.description ? `  ${theme.fg("muted", row.description.replace(/\s*\n\s*/g, " "))}` : "";
							add(`${prefix}${boxText(picker.box(row))} ${label}${suffix}${description}`);
						} else {
							add(`${prefix}${label}${suffix}`);
							for (const line of row.description?.split("\n") ?? []) add(`   ${theme.fg("muted", line)}`);
						}
					}
					if (visible.length > MAX_VISIBLE) {
						add();
						add(theme.fg("dim", ` ${start + 1}-${end} of ${visible.length}`));
					}
				}

				add();
				add(theme.fg("dim", ` ${picker.hints().join(" • ")}`));
				if (picker.legend) add(theme.fg("dim", ` ${picker.legend}`));
				add(border);

				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				const visible = visibleRows();
				const last = visible.length - 1;
				const moveTo = (index: number) => {
					if (visible.length === 0) return;
					cursor = index;
					refresh();
				};
				if (matchesKey(data, Key.up)) return moveTo(cursor === 0 ? last : cursor - 1);
				if (matchesKey(data, Key.down)) return moveTo(cursor === last ? 0 : cursor + 1);
				if (matchesKey(data, Key.pageUp)) return moveTo(Math.max(0, cursor - MAX_VISIBLE));
				if (matchesKey(data, Key.pageDown)) return moveTo(Math.min(last, cursor + MAX_VISIBLE));
				if (matchesKey(data, Key.home)) return moveTo(0);
				if (matchesKey(data, Key.end)) return moveTo(last);
				if (matchesKey(data, Key.enter)) {
					const outcome = picker.onEnter(visible[cursor]);
					if (outcome) done(outcome.result);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					// The first esc only drops the search; with nothing typed it leaves.
					if (query) {
						query = "";
						cursor = 0;
						refresh();
					} else {
						done(null);
					}
					return;
				}
				if (matchesKey(data, Key.backspace) || data === "\u007f" || data === "\b") {
					if (query) {
						query = query.slice(0, -1);
						refresh();
					}
					return;
				}
				if (picker.onTab && (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("a")))) {
					picker.onTab(visible);
					refresh();
					return;
				}
				if (picker.onSpace && data === " ") {
					const row = visible[cursor];
					if (row) {
						picker.onSpace(row);
						refresh();
					}
					return;
				}
				// Every printable character goes to the search. Letters are never
				// hotkeys: "a" and "n" used to be, which made names like
				// "claude-sonnet" impossible to search for.
				if (data >= " " && data !== "\u001b" && data !== "\r" && data !== "\n") {
					query += data;
					cursor = 0;
					refresh();
				}
			},
		};
	});
}

export async function selectOne(
	ctx: CommandContext,
	title: string,
	items: Array<string | SelectItem>,
	options?: { initialIndex?: number },
): Promise<string | null> {
	const rows = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
	if (rows.length === 0) return null;
	return runPicker<string>(ctx, {
		title,
		rows,
		initialIndex: options?.initialIndex,
		hints: () => [...(rows.length >= SEARCH_BOX_FROM ? ["type to search"] : []), "↑↓ move", "enter select", "esc back"],
		onEnter: (row) => (row ? { result: row.value } : undefined),
	});
}

// Tri-state multi-select: each item cycles through its own allowed states on
// space. "[ ]" off, "[-]" mid, "[x]" on — the caller decides what each state
// means per item (e.g. skip/remove, keep-without-update, add/update).
export type TriState = "off" | "mid" | "on";
export type TriItem = {
	value: string;
	label: string;
	description?: string;
	searchText?: string;
	// States this item cycles through, in toggle order.
	states: TriState[];
	initial: TriState;
};

export async function pickTriState(
	ctx: CommandContext,
	title: string,
	items: TriItem[],
	legend = "[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata",
): Promise<Map<string, TriState> | null> {
	if (items.length === 0) return new Map();
	const state = new Map<string, TriState>(items.map((item) => [item.value, item.initial]));
	const byValue = new Map(items.map((item) => [item.value, item]));
	const top = (item: TriItem) => item.states[item.states.length - 1];
	return runPicker<Map<string, TriState>>(ctx, {
		title,
		rows: items,
		legend,
		box: (row) => state.get(row.value) ?? "off",
		status: (visible) => `${items.length} models${visible.length === items.length ? "" : ` • ${visible.length} shown`}`,
		hints: () => ["type to search", "↑↓ move", "space change", "tab all shown", "enter confirm", "esc cancel"],
		onSpace: (row) => {
			const item = byValue.get(row.value);
			if (!item) return;
			const index = item.states.indexOf(state.get(item.value) ?? item.initial);
			state.set(item.value, item.states[(index + 1) % item.states.length]);
		},
		// Tab checks everything shown; a second tab puts those rows back the way
		// they started. Nothing here can mark a whole list for removal by accident.
		onTab: (visible) => {
			const shown = visible.map((row) => byValue.get(row.value)).filter((item): item is TriItem => item !== undefined);
			const allChecked = shown.every((item) => state.get(item.value) === top(item));
			for (const item of shown) state.set(item.value, allChecked ? item.initial : top(item));
		},
		onEnter: () => ({ result: new Map(state) }),
	});
}

export async function pickMany(ctx: CommandContext, title: string, items: ProbeItem[]): Promise<string[] | null> {
	const selected = new Set<string>();
	return runPicker<string[]>(ctx, {
		title,
		rows: items,
		box: (row) => (selected.has(row.value) ? "on" : "off"),
		status: (visible) => `${selected.size} selected • ${visible.length}/${items.length} shown`,
		hints: () => [
			"type to search",
			"↑↓ move",
			"space toggle",
			"tab all shown",
			selected.size > 0 ? "enter confirm" : "enter takes the highlighted row",
			"esc cancel",
		],
		onSpace: (row) => {
			if (!selected.delete(row.value)) selected.add(row.value);
		},
		// Tab takes everything the filter shows, or drops it when it is all taken.
		onTab: (visible) => {
			const allTaken = visible.length > 0 && visible.every((row) => selected.has(row.value));
			for (const row of visible) {
				if (allTaken) selected.delete(row.value);
				else selected.add(row.value);
			}
		},
		// With nothing ticked, enter takes the row under the cursor — the quick
		// way to add a single model.
		onEnter: (row) => (selected.size > 0 ? { result: [...selected] } : row ? { result: [row.value] } : undefined),
	});
}
