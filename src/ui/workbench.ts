import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId } from "@mariozechner/pi-tui";
import type { CommandContext, DetailField, SelectItem } from "../types.ts";
import { panelHeight } from "./panel.ts";

export type WorkbenchState = {
	query: string;
	value?: string;
	focus: "list" | "details" | "actions";
	detail: number;
	scroll: number;
	action: number;
	bodyFocus?: "list" | "details";
};
export const workbenchState = (value?: string): WorkbenchState => ({ query: "", value, focus: "list", detail: 0, scroll: 0, action: 0 });
export type WorkbenchAction = { id: string; label: string; key?: KeyId; hint?: string; disabled?: boolean };
export type WorkbenchResult = { action: string; value?: string };
type Options = {
	title: string;
	subtitle?: string;
	items: SelectItem[];
	state?: WorkbenchState;
	actions?: WorkbenchAction[] | (() => WorkbenchAction[]);
	inspectOnEnter?: boolean;
	form?: boolean;
	startEditing?: boolean;
	compact?: boolean;
	mark?: (item: SelectItem) => string;
	status?: (visible: SelectItem[]) => string;
	warning?: () => string;
	onToggle?: (item: SelectItem) => void;
	onAll?: (visible: SelectItem[]) => void;
	/** Synchronous draft update. Return a validation message to keep editing. */
	onEdit?: (item: SelectItem, field: DetailField, value: string) => string | undefined | Promise<string | undefined>;
	enterAction?: string;
	enterHint?: () => string;
	empty?: string;
};
type Editing = { row: SelectItem; field: DetailField; input?: Input; choice: number; replace: boolean; error?: string };

export const uiText = (text: string): string => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width));
const pad = (text: string, width: number) => {
	const clipped = fit(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

// The browser, inspector and inline editor share one component. Editing a
// common field never closes/reopens the workspace or creates another modal.
export async function showWorkbench(ctx: CommandContext, options: Options): Promise<WorkbenchResult | null> {
	const state = options.state ?? workbenchState();
	if (options.form && state.focus === "list") state.focus = "details";
	if (options.compact && state.focus === "details") state.focus = "list";
	state.bodyFocus ??= options.form || state.focus === "details" ? "details" : "list";
	const getActions = () => typeof options.actions === "function" ? options.actions() : options.actions ?? [];
	const listRowHeight = options.compact && options.items.some((row) => row.description || row.suffix) ? 2 : 1;
	const searchable = (row: SelectItem) => `${row.label} ${row.value} ${row.suffix ?? ""} ${row.description ?? ""} ${row.searchText ?? ""} ${row.tag ?? ""}`.toLowerCase();
	const search = new Map(options.items.map((row) => [row.value, searchable(row)]));
	return ctx.ui.custom<WorkbenchResult | null>((tui, theme, _kb, done) => {
		let pageSize = 8, detailPage = 8;
		let renderedFields: Array<{ field: DetailField; line: number }> = [];
		let ensureFieldVisible = true;
		let detailScrollMax = 0;
		let actionPositions: Array<{ index: number; row: number; column: number }> = [];
		let editing: Editing | undefined;
		const visible = () => {
			const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
			return terms.length ? options.items.filter((item) => terms.every((term) => search.get(item.value)?.includes(term))) : options.items;
		};
		const current = () => {
			const rows = visible();
			return rows.find((row) => row.value === state.value) ?? rows[0];
		};
		const refresh = () => tui.requestRender();
		const emit = (action: string) => done({ action, value: current()?.value });
		const runAction = (action: WorkbenchAction | undefined) => { if (action && !action.disabled) emit(action.id); };
		const fields = () => current()?.details?.flatMap((section) => section.fields ?? []) ?? [];
		const setCurrent = (row: SelectItem | undefined) => {
			state.value = row?.value; state.detail = 0; state.scroll = 0; ensureFieldVisible = true;
		};
		const enterDetails = () => {
			if (options.compact || !current()) return;
			state.focus = "details"; ensureFieldVisible = true; refresh();
		};
		const enterActions = (): boolean => {
			if (!getActions().length) return false;
			if (state.focus !== "actions") state.bodyFocus = state.focus;
			state.focus = "actions"; refresh(); return true;
		};
		const leaveActions = () => {
			state.focus = state.bodyFocus ?? (options.form ? "details" : "list");
			ensureFieldVisible = true; refresh();
		};
		const cycleFocus = (direction = 1) => {
			const order = [...(options.form ? [] : ["list"]), ...(options.compact ? [] : ["details"]), ...(getActions().length ? ["actions"] : [])] as WorkbenchState["focus"][];
			const next = order[(Math.max(0, order.indexOf(state.focus)) + direction + order.length) % order.length];
			if (next === "actions") { enterActions(); return; }
			state.focus = next;
			ensureFieldVisible = true; refresh();
		};
		const beginEdit = (row: SelectItem, field: DetailField) => {
			const editor = field.editor;
			if (!editor || !options.onEdit) return;
			editing = { row, field, choice: editor.kind === "choice" ? Math.max(0, editor.choices.findIndex((choice) => choice.value === editor.value)) : 0, replace: true };
			if (editor.kind === "text") {
				editing.input = new Input({ prompt: "", placeholder: editor.placeholder, placeholderStyle: (text) => theme.fg("muted", text) });
				editing.input.setValue(editor.value);
				editing.input.handleInput("\x1b[F");
				editing.input.focused = true;
			}
			ensureFieldVisible = true; refresh();
		};
		let pending = false;
		const commitEdit = (after?: () => void): void => {
			if (!editing) { after?.(); return; }
			const draft = editing;
			const editor = draft.field.editor!;
			const value = editor.kind === "text" ? draft.input!.getValue() : editor.choices[draft.choice].value;
			const finish = (error?: string) => {
				pending = false;
				if (error) { draft.error = error; refresh(); return; }
				search.set(draft.row.value, searchable(draft.row));
				editing = undefined;
				ensureFieldVisible = true;
				refresh();
				after?.();
			};
			try {
				const result = options.onEdit?.(draft.row, draft.field, value);
				if (typeof result === "object" && result !== null) {
					pending = true;
					refresh();
					void result.then(finish, (error) => finish(String(error)));
				} else finish(result);
			} catch (error) { finish(String(error)); }
		};

		if (options.startEditing) {
			const row = current(), field = fields()[state.detail];
			if (row && field?.editor) beginEdit(row, field);
		}

		return {
			capturesViewportInput: true,
			render(width: number) {
				const w = Math.max(1, width - 2);
				const muted = (text: string) => theme.fg("muted", text);
				const accent = (text: string) => theme.fg("accent", text);
				const actions = getActions();
				state.action = Math.max(0, Math.min(state.action, actions.length - 1));
				const actionLines: string[] = [];
				actionPositions = [];
				let actionLine = "";
				for (let i = 0; i < actions.length; i++) {
					const action = actions[i], focused = state.focus === "actions" && i === state.action;
					const label = uiText(action.label);
					const text = focused ? `[${label}]` : ` ${label} `;
					const token = fit(action.disabled ? theme.fg("dim", text) : focused ? accent(text) : muted(text), w);
					if (actionLine && visibleWidth(actionLine) + 1 + visibleWidth(token) > w) { actionLines.push(actionLine); actionLine = ""; }
					const gap = actionLine ? " " : "";
					actionPositions.push({ index: i, row: actionLines.length, column: visibleWidth(actionLine) + gap.length });
					actionLine += gap + token;
				}
				if (actionLine) actionLines.push(actionLine);
				const warning = options.warning?.();
				const warningLines = warning ? wrapTextWithAnsi(theme.fg("warning", theme.bold(uiText(warning))), w) : [];
				const chrome = 4 + actionLines.length + (options.subtitle ? 1 : 0) + warningLines.length;
				const terminalRows = tui.terminal?.rows ?? process.stdout.rows ?? 30;
				const height = panelHeight(terminalRows);
				const bodyHeight = Math.max(1, height - chrome);
				const split = !options.form && !options.compact && w >= 96;
				const leftWidth = split ? Math.max(30, Math.floor(w * 0.40)) : w;
				const rightWidth = split ? w - leftWidth - 3 : w;
				const rows = visible(), active = current();
				if (active) state.value = active.value;
				state.detail = Math.min(state.detail, Math.max(0, fields().length - 1));
				const index = Math.max(0, rows.findIndex((row) => row.value === active?.value));
				const lines: string[] = [];
				const add = (line = "") => lines.push(` ${fit(line, w)} `);
				const border = muted("─".repeat(w));
				add(border);
				const status = options.status?.(rows);
				add(`${accent(theme.bold(uiText(options.title)))}${status ? muted(`  · ${uiText(status)}`) : ""}`);
				if (options.subtitle) add(muted(uiText(options.subtitle)));
				for (const line of warningLines) add(line);

				const listLines = [muted(state.query ? `Filter: ${uiText(state.query)}  (${rows.length}/${options.items.length})` : `${options.items.length} items · type to filter`)];
				const rowHeight = listRowHeight;
				pageSize = Math.max(1, Math.floor((bodyHeight - 1) / rowHeight));
				const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), rows.length - pageSize));
				if (!rows.length) listLines.push(muted(state.query ? "No matches. Esc clears the filter." : uiText(options.empty ?? "Nothing here yet.")));
				for (const row of rows.slice(start, start + pageSize)) {
					const selected = row.value === active?.value;
					const marker = options.mark?.(row);
					const text = `${selected ? "›" : " "} ${marker ? `${uiText(marker)} ` : ""}${uiText(row.label)}`;
					const tag = row.tag ? ` ${row.tag === "*" ? "*" : `· ${uiText(row.tag)}`}` : "";
					listLines.push(fit(`${selected && state.focus === "list" ? accent(text) : text}${muted(tag)}`, leftWidth));
					if (listRowHeight === 2) listLines.push(muted(fit(`  ${uiText([row.suffix, row.description].filter(Boolean).join(" "))}`, leftWidth)));
				}

				const detailLines: string[] = [];
				renderedFields = [];
				const detailsActive = state.focus === "details";
				const wrap = (text: string) => detailLines.push(...wrapTextWithAnsi(text, Math.max(1, rightWidth)));
				if (!options.form) wrap(accent(theme.bold(active ? uiText(active.label) : "")));
				if (active) {
					const sections = active.details ?? [{ title: "", lines: [active.description ?? active.suffix ?? ""] }];
					for (const section of sections) {
						if (section.title) wrap(muted(uiText(section.title)));
						for (const field of section.fields ?? []) {
							const fieldIndex = renderedFields.length;
							renderedFields.push({ field, line: detailLines.length });
							const selected = detailsActive && fieldIndex === state.detail;
							const label = uiText(field.label).padEnd(Math.min(12, Math.max(4, rightWidth - 12)));
							const prefix = `${selected ? "›" : " "} ${label} `;
							if (editing?.field === field) {
								const editor = field.editor!;
								const value = editor.kind === "text" ? `[${editing.input!.render(Math.max(1, rightWidth - visibleWidth(prefix) - 2))[0]}]` : `‹ ${uiText(editor.choices[editing.choice].label)} ›`;
								wrap(accent(prefix) + value);
								if (editing.error) wrap(theme.fg("warning", `  ${uiText(editing.error)}`));
							} else {
								const text = prefix + uiText(field.value);
								const source = field.source ? ` · ${uiText(field.source)}` : "";
								const inlineSource = visibleWidth(text) + visibleWidth(source) <= rightWidth;
								wrap((selected ? accent(text) : text) + (inlineSource ? muted(source) : ""));
								if (source && !inlineSource) wrap(muted(`  ${uiText(field.source!)}`));
							}
						}
						for (const line of section.lines ?? []) wrap(muted(uiText(line)));
					}
				}
				detailPage = bodyHeight;
				if (detailsActive && renderedFields.length && ensureFieldVisible) {
					const target = renderedFields[state.detail].line;
					if (target < state.scroll) state.scroll = target;
					if (target >= state.scroll + detailPage) state.scroll = target - detailPage + 1;
				}
				ensureFieldVisible = false;
				detailScrollMax = Math.max(0, detailLines.length - detailPage);
				state.scroll = Math.max(0, Math.min(state.scroll, detailScrollMax));
				const inspector = detailLines.slice(state.scroll, state.scroll + detailPage);
				for (let i = 0; i < bodyHeight; i++) {
					if (split) add(`${pad(listLines[i] ?? "", leftWidth)} ${muted("│")} ${fit(inspector[i] ?? "", rightWidth)}`);
					else add((!options.form && state.focus === "list" ? listLines : inspector)[i] ?? "");
				}

				for (const line of actionLines) add(line);
				const actionKey = actions[state.action]?.key;
				const keyHint = actionKey ? ` · ${String(actionKey).replace(/^ctrl\+/, "Ctrl+")}` : "";
				const field = fields()[state.detail];
				const hint = editing ? (editing.field.editor!.kind === "choice" ? "Space/←→ choose · Enter confirm · Esc cancel" : editing.replace ? "Type to replace · Enter use · Esc cancel" : "Enter use · Esc cancel")
					: state.focus === "actions" ? `←→ / ↑↓ move · Enter run · Esc return${keyHint}`
					: options.onToggle ? (state.focus === "details" ? "Space toggle · Enter edit/confirm · ← list · Esc back" : "Space toggle · Enter confirm · → details · Ctrl+A all")
					: state.focus === "details" ? `↑↓ ${field?.action ? "fields · Enter edit" : "scroll"} · Ctrl+K actions · Esc back`
					: options.enterHint?.() ?? (options.compact ? "↑↓ move · Enter choose · Esc back" : `↑↓ move · Enter ${options.inspectOnEnter ? "details" : "open"} · Ctrl+K actions · Esc back`);
				add(muted(pending ? "Resolving metadata…" : hint));
				add(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (pending) return;
				if (editing) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { editing = undefined; refresh(); return; }
					if (matchesKey(data, Key.enter)) { void commitEdit(); return; }
					if (matchesKey(data, Key.ctrl("s"))) { commitEdit(() => runAction(getActions().find((action) => action.key && matchesKey(data, action.key)))); return; }
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
						const backwards = matchesKey(data, Key.shift("tab"));
						commitEdit(() => { state.detail = Math.max(0, Math.min(fields().length - 1, state.detail + (backwards ? -1 : 1))); ensureFieldVisible = true; refresh(); });
						return;
					}
					const editor = editing.field.editor!;
					editing.error = undefined;
					if (editor.kind === "choice") {
						if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) editing.choice = (editing.choice - 1 + editor.choices.length) % editor.choices.length;
						if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === " ") editing.choice = (editing.choice + 1) % editor.choices.length;
					} else {
						if (matchesKey(data, Key.ctrl("a"))) { editing.replace = true; refresh(); return; }
						const printable = /^[^\x00-\x1f\x7f-\x9f]+$/u.test(data) || data.includes("\x1b[200~");
						if (editing.replace && (printable || matchesKey(data, Key.backspace))) editing.input!.setValue("");
						editing.replace = false;
						editing.input!.handleInput(data);
					}
					refresh(); return;
				}
				if (matchesKey(data, Key.ctrl("c"))) return done(null);
				if (matchesKey(data, Key.escape)) {
					if (state.focus === "actions") { leaveActions(); return; }
					if (!options.form && state.focus !== "list") state.focus = "list";
					else if (state.query) state.query = "";
					else { done(null); return; }
					refresh(); return;
				}
				if (matchesKey(data, Key.ctrl("k"))) { enterActions(); return; }
				for (const action of getActions()) if (action.key && matchesKey(data, action.key)) { runAction(action); return; }
				if (matchesKey(data, Key.tab)) return cycleFocus();
				if (matchesKey(data, Key.shift("tab"))) return cycleFocus(-1);
				if (options.onAll && matchesKey(data, Key.ctrl("a"))) { options.onAll(visible()); refresh(); return; }
				if (matchesKey(data, Key.enter)) {
					if (state.focus === "actions") runAction(getActions()[state.action]);
					else if (state.focus === "details") {
						const field = fields()[state.detail], rendered = renderedFields[state.detail];
						if (options.enterAction && !field?.editor && !field?.action) { runAction(getActions().find((action) => action.id === options.enterAction)); return; }
						if (field && rendered && rendered.line >= state.scroll && rendered.line < state.scroll + detailPage) {
							if (field.editor && options.onEdit) beginEdit(current()!, field);
							else if (field.action) emit(field.action);
							else if (options.enterAction) runAction(getActions().find((action) => action.id === options.enterAction));
						}
					} else if (options.enterAction) runAction(getActions().find((action) => action.id === options.enterAction));
					else if (options.inspectOnEnter) enterDetails();
					else if (current()) emit("choose");
					return;
				}
				if (matchesKey(data, Key.right) && state.focus === "list") return enterDetails();
				if (!options.form && matchesKey(data, Key.left) && state.focus === "details") { state.focus = "list"; refresh(); return; }
				const up = matchesKey(data, Key.up), down = matchesKey(data, Key.down);
				const pgUp = matchesKey(data, Key.pageUp), pgDown = matchesKey(data, Key.pageDown);
				const home = matchesKey(data, Key.home), end = matchesKey(data, Key.end);
				if (state.focus === "actions") {
					const count = getActions().length;
					if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
						if (count) state.action = (state.action + (matchesKey(data, Key.left) ? -1 : 1) + count) % count;
						refresh(); return;
					}
					if (home || end) { state.action = home ? 0 : Math.max(0, count - 1); refresh(); return; }
					if (up || down) {
						const position = actionPositions.find((item) => item.index === state.action);
						const candidates = position ? actionPositions.filter((item) => item.row === position.row + (up ? -1 : 1)) : [];
						if (!candidates.length) { leaveActions(); return; }
						state.action = candidates.reduce((best, item) => Math.abs(item.column - position!.column) < Math.abs(best.column - position!.column) ? item : best).index;
						refresh(); return;
					}
				}
				if (up || down || pgUp || pgDown || home || end) {
					if (state.focus === "details") {
						const atTop = state.detail === 0 && state.scroll === 0;
						const atBottom = state.detail >= Math.max(0, fields().length - 1) && state.scroll >= detailScrollMax;
						if (((up && atTop) || (down && atBottom)) && enterActions()) return;
						if (home || end || pgUp || pgDown) {
							state.scroll = home ? 0 : end ? Number.MAX_SAFE_INTEGER : Math.max(0, state.scroll + (pgUp ? -detailPage : detailPage));
							if (home) state.detail = 0;
							if (end) state.detail = Math.max(0, fields().length - 1);
							ensureFieldVisible = false;
						} else {
							const before = state.detail;
							state.detail = Math.max(0, Math.min(fields().length - 1, state.detail + (up ? -1 : 1)));
							ensureFieldVisible = before !== state.detail;
							if (!ensureFieldVisible) state.scroll = Math.max(0, state.scroll + (up ? -1 : 1));
						}
					} else if (state.focus === "list") {
						const rows = visible(), at = rows.findIndex((row) => row.value === current()?.value);
						if (((up && at <= 0) || (down && at >= rows.length - 1)) && enterActions()) return;
						const next = home ? 0 : end ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (up || pgUp ? -1 : 1) * (pgUp || pgDown ? pageSize : 1)));
						setCurrent(rows[next]);
					}
					refresh(); return;
				}
				if (data === " " && options.onToggle && state.focus !== "actions") { const row = current(); if (row) options.onToggle(row); refresh(); return; }
				if (options.form || state.focus !== "list") return;
				if (matchesKey(data, Key.backspace) || data === "\u007f" || data === "\b") {
					state.query = [...state.query].slice(0, -1).join(""); setCurrent(visible()[0]); refresh(); return;
				}
				const text = data.replace(/\x1b\[20[01]~/g, "");
				if (text && /^[^\x00-\x1f\x7f-\x9f]+$/u.test(text)) { state.query += text; setCurrent(visible()[0]); refresh(); }
			},
		};
	});
}
