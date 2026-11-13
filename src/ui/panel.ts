import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { CommandContext } from "../types.ts";

// All pages use the same editor-slot drawer, sized by the terminal, not by
// their content. Leave room for Pi's footer and shrink on small terminals.
export function panelHeight(terminalRows: number): number {
	return Math.max(1, Math.min(Math.max(1, terminalRows - 4), Math.max(20, Math.min(30, Math.floor(terminalRows / 2)))));
}

const safe = (text: string) => String(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");
const wrapped = (text: string, width: number) => safe(text).split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, width) : [""]);
type Theme = CommandContext["ui"]["theme"];

function frame(width: number, height: number, title: string, body: string[], footer: string[], theme: Theme): string[] {
	const inner = Math.max(1, width - 2);
	const border = theme.fg("muted", "─".repeat(inner));
	const lines = [border, theme.fg("accent", theme.bold(safe(title).replace(/\n/g, " ")))];
	const available = Math.max(0, height - 3 - footer.length);
	for (let i = 0; i < available; i++) lines.push(body[i] ?? "");
	lines.push(...footer, border);
	return lines.map((line) => ` ${truncateToWidth(line, inner)} `);
}

// Input and confirmation must not collapse the drawer into a different native
// dialog. They use the same bottom editor slot and height as the workbench.
export async function panelInput(ctx: CommandContext, title: string, placeholder = ""): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const input = new Input();
		input.focused = true;
		input.onSubmit = done;
		input.onEscape = () => done(undefined);
		return {
			capturesViewportInput: true,
			render(width: number) {
				const inner = Math.max(1, width - 2);
				const height = panelHeight(tui.terminal?.rows ?? process.stdout.rows ?? 30);
				const body = wrapped(placeholder, inner).map((line) => theme.fg("muted", line));
				return frame(width, height, title, body, [input.render(inner)[0], theme.fg("muted", "Enter confirm · Esc cancel")], theme);
			},
			invalidate() { input.invalidate(); },
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("c"))) { done(undefined); return; }
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export async function panelConfirm(ctx: CommandContext, title: string, message: string): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		let yes = false, scroll = 0, page = 10, maxScroll = 0;
		return {
			capturesViewportInput: true,
			render(width: number) {
				const inner = Math.max(1, width - 2);
				const height = panelHeight(tui.terminal?.rows ?? process.stdout.rows ?? 30);
				const body = wrapped(message, inner);
				page = Math.max(1, height - 5);
				maxScroll = Math.max(0, body.length - page);
				scroll = Math.min(scroll, maxScroll);
				const choice = yes ? `${theme.fg("accent", "[Yes]")}   No` : ` Yes   ${theme.fg("accent", "[No]")}`;
				const hint = `Space/←→ choose · Enter confirm${maxScroll ? " · PgUp/PgDn scroll" : ""} · Esc cancel`;
				return frame(width, height, title, body.slice(scroll, scroll + page), [choice, theme.fg("muted", hint)], theme);
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { done(false); return; }
				if (matchesKey(data, Key.enter)) { done(yes); return; }
				if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) yes = true;
				else if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) yes = false;
				else if (matchesKey(data, Key.tab) || data === " ") yes = !yes;
				else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page);
				else if (matchesKey(data, Key.pageDown)) scroll = Math.min(maxScroll, scroll + page);
				else if (matchesKey(data, Key.home)) scroll = 0;
				else if (matchesKey(data, Key.end)) scroll = maxScroll;
				tui.requestRender();
			},
		};
	});
}
