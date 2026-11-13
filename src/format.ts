import { getMetadataProvenance, getMetadataSourceLabel, type MetadataField } from "model-probe";
// How model metadata is shown. One place, so pickers, menus and diffs agree.
import { readModelOptions } from "./model-entry.ts";
import type { ModelProbeInfo } from "./types.ts";

// 128000 -> "128K", 16384 -> "16.4K", 1048576 -> "1.05M"
export function formatTokens(value: number): string {
	const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
	if (value >= 1_000_000) return `${trim(value / 1_000_000, 2)}M`;
	if (value >= 100_000) return `${Math.round(value / 1000)}K`;
	if (value >= 1000) return `${trim(value / 1000, 1)}K`;
	return String(value);
}

export function parseTokenInput(input: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(input.trim().replace(/[_,]/g, ""));
	if (!match) return undefined;
	const value = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1000 : 1);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function formatCost(cost: { input: number; output: number }): string {
	return `$${cost.input}/$${cost.output}`;
}

type Origin = string;

function originOf(info: ModelProbeInfo, field: string): Origin | undefined {
	const label = getMetadataSourceLabel(info, field as MetadataField);
	return label === "default" ? undefined : label;
}

// One line for freshly resolved metadata: "128K ctx • 16.4K out • image ·
// models.dev". Values equal to the defaults (no image, reasoning on) are left
// out, and the source is named once at the end instead of after every field —
// not at all when the gateway itself reported everything.
export function describeInfo(info: ModelProbeInfo | undefined): string | undefined {
	if (!info) return undefined;
	const parts: string[] = [];
	const origins = new Set<Origin>();
	const show = (field: string, text: string) => {
		const origin = originOf(info, field);
		if (!origin) return;
		parts.push(text);
		origins.add(origin);
	};
	if (info.contextWindow !== undefined) show("contextWindow", `${formatTokens(info.contextWindow)} ctx`);
	if (info.maxTokens !== undefined) show("maxTokens", `${formatTokens(info.maxTokens)} out`);
	if (info.image === true) show("image", "image");
	if (info.video === true) show("video", "video");
	if (info.reasoning === false) show("reasoning", "no reasoning");
	else if (info.reasoning === true && info.alwaysThinking) show("reasoning", "always thinks");
	if (info.cost) show("cost", `${formatCost(info.cost)} per 1M`);
	if (info.endpointTypes && info.endpointTypes.length > 0) parts.push(info.endpointTypes.join("/"));
	if (parts.length === 0) return undefined;

	const borrowed = [...origins].filter((origin) => origin !== "gateway");
	const note = borrowed.length === 0 ? "" : ` · ${origins.has("gateway") ? "gateway + " : ""}${borrowed.join(" + ")}`;
	return `${parts.join(" • ")}${note}`;
}

// The same line for an entry already stored in custom-providers.json.
export function describeStoredModel(model: any): string {
	if (!model || typeof model !== "object") return "";
	const parts: string[] = [];
	if (typeof model.contextWindow === "number") parts.push(`${formatTokens(model.contextWindow)} ctx`);
	if (typeof model.maxTokens === "number") parts.push(`${formatTokens(model.maxTokens)} out`);
	if (Array.isArray(model.input) && model.input.includes("image")) parts.push("image");
	parts.push(model.reasoning === true ? `reasoning ${readModelOptions(model).reasoning}` : "no reasoning");
	if (model.cost && typeof model.cost === "object") parts.push(`${formatCost(model.cost)} per 1M`);
	return parts.join(" • ");
}

// "gateway 3 • models.dev 2 • defaults 1": where each model's best metadata
// came from, for the message after a provider is saved.
export function summarizeOrigins(ids: string[], infoById: Map<string, ModelProbeInfo> | undefined): string {
	const counts = new Map<string, number>();
	for (const id of ids) {
		const info = infoById?.get(id);
		const origins = new Set<Origin | undefined>(
			info ? (["contextWindow", "maxTokens", "image", "video", "reasoning", "cost"] as const).filter((field) => info[field] !== undefined).map((field) => { const trace = getMetadataProvenance(info)[field]; return trace?.infer ? "infer" : trace?.source; }) : [],
		);
		const best = (["gateway", "models.dev", "infer"] as const).find((origin) => origins.has(origin)) ?? "defaults";
		counts.set(best, (counts.get(best) ?? 0) + 1);
	}
	return ["gateway", "models.dev", "infer", "defaults"]
		.filter((origin) => counts.has(origin))
		.map((origin) => `${origin} ${counts.get(origin)}`)
		.join(" • ");
}
