import { getMetadataProvenance, getMetadataSourceLabel, isMetadataAuthoritative, mergeWithExistingMetadata, type MetadataField } from "model-probe";
import { applyReasoning, modelOptionsFromProbe, readCeilingString, readModelOptions, storedMetadata } from "../model-entry.ts";
import { formatTokens, parseTokenInput } from "../format.ts";
import { REASONING_LEVELS } from "../types.ts";
import type { DetailField, DetailSection, ModelCostInfo, ModelOptions, ModelProbeInfo, ReasoningCeiling } from "../types.ts";

export function sourceOf(info: ModelProbeInfo, field: string): string {
	return getMetadataSourceLabel(info, field as MetadataField);
}

export function effortDetails(infos: Array<ModelProbeInfo | undefined>): DetailField[] {
	const levels = infos.map((info) => info?.reasoning === false ? undefined : info?.effortOptions);
	const values = [...new Set(levels.map((options) => options?.join(", ") ?? ""))];
	if (!values.some(Boolean)) return [];
	const sources = [...new Set(infos.flatMap((info, index) => levels[index]?.length ? [getMetadataSourceLabel(info, "effortOptions")] : []))];
	return [{ label: "Effort levels", value: values.length === 1 ? values[0] : "Varies by model", source: values.length === 1 && sources.length === 1 ? sources[0] : undefined }];
}

const tokens = (value: number | undefined) => value === undefined ? "Not set" : formatTokens(value);
const exactTokens = (value: number | undefined) => value === undefined ? "Registration fallback" : `${value.toLocaleString("en-US")} tokens`;
const price = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? `$${value}` : "Unknown";

export const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type PriceKey = typeof PRICE_KEYS[number];
export type ModelEdits = Partial<Pick<ModelOptions, "contextWindow" | "maxTokens" | "image" | "reasoning">> & { cost?: Partial<ModelCostInfo> };
export type EditorDefaults = { options: ModelOptions; sources: Record<keyof ModelEdits, string>; info: ModelProbeInfo };
const validPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const defaultPrice = (base: Partial<ModelCostInfo> | undefined, key: PriceKey) => base?.[key] ?? (key === "cacheRead" || key === "cacheWrite" ? 0 : undefined);

export function parsePriceInput(text: string): number | undefined {
	const input = text.trim().replace(/^\$\s*/, "").replace(/[_,]/g, "");
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input)) return undefined;
	const value = Number(input);
	return validPrice(value) ? value : undefined;
}

export function mergedCost(base?: Partial<ModelCostInfo>, edits?: Partial<ModelCostInfo>): ModelCostInfo | undefined {
	const value = { ...base, ...edits };
	if (!validPrice(value.input) || !validPrice(value.output) || !validPrice(value.cacheRead ?? 0) || !validPrice(value.cacheWrite ?? 0)) return undefined;
	return { input: value.input, output: value.output, cacheRead: value.cacheRead ?? 0, cacheWrite: value.cacheWrite ?? 0 };
}

export function priceValidation(base?: Partial<ModelCostInfo>, edits?: Partial<ModelCostInfo>): string {
	return edits && Object.keys(edits).length && !mergedCost(base, edits) ? "Set both input and output prices; 0 means free. Blank restores defaults." : "";
}

export function editPriceValue(base: Partial<ModelCostInfo> | undefined, target: ModelEdits, action: string, text: string, mixed: ReadonlySet<PriceKey> = new Set()): string | undefined {
	const key = action.slice(5) as PriceKey;
	if (!PRICE_KEYS.includes(key)) return "Unknown price field.";
	const value = text.trim() ? parsePriceInput(text) : undefined;
	if (text.trim() && value === undefined) return "Enter a nonnegative USD / 1M price, e.g. 0, 0.15 or $2.50.";
	const cost = { ...target.cost };
	if (value === undefined || (!mixed.has(key) && value === defaultPrice(base, key))) delete cost[key]; else cost[key] = value;
	if (Object.keys(cost).length) target.cost = cost; else delete target.cost;
}

export function editablePricing(base?: Partial<ModelCostInfo>, edits?: Partial<ModelCostInfo>, source = "saved", mixed: ReadonlySet<PriceKey> = new Set()): DetailSection {
	const labels: Record<PriceKey, string> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };
	return { title: "Price · USD / 1M tokens", fields: PRICE_KEYS.map((key) => {
		const custom = edits?.[key] !== undefined, varies = mixed.has(key) && !custom;
		const value = custom ? edits![key] : defaultPrice(base, key);
		const optional = base?.[key] === undefined && (key === "cacheRead" || key === "cacheWrite");
		return { label: labels[key], action: `cost.${key}`, source: custom ? "custom" : optional ? "default" : base?.[key] === undefined ? undefined : source,
			value: varies ? "Auto per model" : `${price(value)}${optional && !custom ? " (optional)" : ""}`,
			editor: { kind: "text", value: varies ? "" : custom ? String(edits![key]) : base?.[key] === undefined ? "" : String(base[key]),
				placeholder: varies ? "Auto per model (default)" : `${price(defaultPrice(base, key))} · ${optional ? "default" : source} (default)` },
		};
	}) };
}


export function editorDefaults(info: ModelProbeInfo, raw?: any): EditorDefaults {
	const merged = mergeWithExistingMetadata(info, raw === undefined ? undefined : storedMetadata(raw));
	const options = modelOptionsFromProbe(merged, { reasoning: "xhigh", image: false });
	const keys = ["contextWindow", "maxTokens", "image", "reasoning", "cost"] as const;
	const provenance = getMetadataProvenance(merged);
	const sources = Object.fromEntries(keys.map((key) => [key, getMetadataSourceLabel(merged, key, key === "reasoning")])) as EditorDefaults["sources"];
	if (raw && merged.reasoning === true && raw.reasoning === true && !merged.alwaysThinking && !merged.effortOptions?.length) {
		options.reasoning = readModelOptions(raw).reasoning;
		options.thinkingLevelMap = raw.thinkingLevelMap;
		sources.reasoning = getMetadataSourceLabel(storedMetadata(raw), "reasoning");
	}
	options.metadataProvenance = provenance;
	return { options, sources, info: merged };
}

export function editedModelOptions(defaults: EditorDefaults, edits: ModelEdits): ModelOptions {
	const { cost, ...fields } = edits;
	const options: ModelOptions = { ...defaults.options, ...fields };
	if (cost) options.cost = mergedCost(defaults.options.cost, cost);
	options.metadataProvenance = { ...defaults.options.metadataProvenance };
	if (edits.reasoning !== undefined) {
		delete options.thinkingLevelMap;
		delete options.metadataProvenance.effortOptions;
		delete options.metadataProvenance.alwaysThinking;
	}
	for (const key of Object.keys(edits) as MetadataField[]) options.metadataProvenance[key] = { source: "custom", match: "exact", infer: false };
	return options;
}

export function editMetadataValue(defaults: EditorDefaults, edits: ModelEdits, key: string, text: string): string | undefined {
	if (key.startsWith("cost.")) return editPriceValue(defaults.options.cost, edits, key, text);
	if (key === "contextWindow" || key === "maxTokens") {
		const value = text.trim() ? parseTokenInput(text) : 0;
		if (value === undefined) return "Use tokens, 128K or 1M; blank restores the default.";
		if (!value || value === defaults.options[key]) delete edits[key]; else edits[key] = value;
	} else if (key === "image") {
		if (!["on", "off", "auto"].includes(text)) return "Choose On or Off.";
		if (text === "auto" || (text === "on") === defaults.options.image) delete edits.image; else edits.image = text === "on";
	} else if (key === "reasoning") {
		if (text === "auto" || text === defaults.options.reasoning) delete edits.reasoning;
		else if (REASONING_LEVELS.includes(text as ReasoningCeiling)) edits.reasoning = text as ReasoningCeiling;
		else return "Choose a reasoning level.";
	}
}

export function markModelEdits(model: { metadataProvenance?: import("model-probe").MetadataProvenance }, fields: readonly MetadataField[]): void {
	for (const field of fields) (model.metadataProvenance ??= {})[field] = { source: "custom", match: "exact", infer: false };
	if (fields.includes("reasoning")) {
		delete model.metadataProvenance!.effortOptions;
		delete model.metadataProvenance!.alwaysThinking;
	}
}

export function applyModelEdits(model: any, edits: ModelEdits): void {
	markModelEdits(model, Object.keys(edits) as MetadataField[]);
	if (edits.cost) model.cost = mergedCost(model.cost, edits.cost);
	if (edits.contextWindow !== undefined) model.contextWindow = edits.contextWindow;
	if (edits.maxTokens !== undefined) model.maxTokens = edits.maxTokens;
	if (edits.image !== undefined) model.input = edits.image ? ["text", "image"] : ["text"];
	if (edits.reasoning !== undefined) applyReasoning(model, edits.reasoning, { xhigh: readCeilingString(model, "xhigh"), max: readCeilingString(model, "max") });
}

// Default values stay stable while a user experiments. Empty numeric input
// resets to the source value; a choice matching that value is not "custom".
export function editableMetadata(defaults: EditorDefaults, edits: ModelEdits, raw?: any): DetailSection[] {
	const value = editedModelOptions(defaults, edits), model = typeof raw === "string" ? { id: raw } : raw;
	const source = (key: keyof ModelEdits) => edits[key] === undefined ? defaults.sources[key] : "custom";
	const range = (before: string | undefined, after: string) => before !== undefined && before !== after ? `${before} → ${after}` : after;
	const number = (key: "contextWindow" | "maxTokens", label: string): DetailField => ({
		label, action: key, value: range(model && model[key] !== undefined ? tokens(model[key]) : undefined, tokens(value[key])), source: source(key),
		editor: { kind: "text", value: value[key] === undefined ? "" : String(value[key]), placeholder: `${tokens(defaults.options[key])} · ${defaults.sources[key]} (default)` },
	});
	return [
		{ title: "Limits", fields: [number("contextWindow", "Context"), number("maxTokens", "Max output")] },
		{ title: "Capabilities", fields: [
			{ label: "Images", action: "image", value: range(model ? Array.isArray(model.input) && model.input.includes("image") ? "On" : "Off" : undefined, value.image ? "On" : "Off"), source: source("image"),
				editor: { kind: "choice", value: value.image ? "on" : "off", choices: [false, true].map((on) => ({ value: on ? "on" : "off", label: `${on ? "On" : "Off"} · ${on === defaults.options.image ? defaults.sources.image : "custom"}` })) } },
			{ label: "Reasoning", action: "reasoning", value: range(model ? readModelOptions(model).reasoning : undefined, value.reasoning), source: source("reasoning"),
				editor: { kind: "choice", value: value.reasoning, choices: REASONING_LEVELS.map((level) => ({ value: level, label: `${level} · ${level === defaults.options.reasoning ? defaults.sources.reasoning : "custom"}` })) } },
			...(edits.reasoning === undefined ? effortDetails([defaults.info]) : []),
		] },
		editablePricing(defaults.options.cost, edits.cost, defaults.sources.cost),
	];
}

function pricing(cost: any, source?: string): DetailSection {
	return {
		title: "Price · USD / 1M tokens",
		fields: cost ? [
			{ label: "Input", value: price(cost.input), source },
			{ label: "Output", value: price(cost.output), source },
			...(cost.cacheRead || cost.cacheWrite ? [{ label: "Cache R / W", value: `${price(cost.cacheRead)} / ${price(cost.cacheWrite)}`, source }] : []),
		] : [{ label: "Price", value: "Unknown", hint: "No price configured; unknown does not mean free." }],
	};
}

export function probeDetails(info: ModelProbeInfo | undefined, sourceOverride?: string): DetailSection[] {
	if (!info) return [{ title: "Metadata", lines: ["No metadata available."] }];
	const field = (key: keyof ModelProbeInfo, label: string, value: string, hint?: string): DetailField => ({
		label, value, source: info[key] === undefined ? undefined : sourceOverride ?? sourceOf(info, key), hint,
	});
	return [
		{ title: "Limits", fields: [
			field("contextWindow", "Context", tokens(info.contextWindow), exactTokens(info.contextWindow)),
			field("maxTokens", "Max output", tokens(info.maxTokens), exactTokens(info.maxTokens)),
		] },
		{ title: "Capabilities", fields: [
			field("image", "Images", info.image === undefined ? "Unknown" : info.image ? "Yes" : "No"),
			field("reasoning", "Reasoning", info.reasoning === undefined ? "Unknown" : info.reasoning ? (info.alwaysThinking ? "Always on" : "Yes") : "No"),
			...(info.video ? [field("video", "Video", "Reported", "Informational; Pi does not expose video input in model configuration.")] : []),
			...effortDetails([info]),
			...(info.endpointTypes?.length ? [{ label: "Endpoints", value: info.endpointTypes.join(", ") }] : []),
		] },
		pricing(info.cost, info.cost ? sourceOverride ?? sourceOf(info, "cost") : undefined),
	];
}

export function comparisonDetails(raw: any, info: ModelProbeInfo, sourceOverride?: string): DetailSection {
	const model = typeof raw === "string" ? { id: raw } : raw ?? {};
	const fields: DetailField[] = [];
	const add = (key: string, label: string, before: string, after: string) => {
		if (before !== after && isMetadataAuthoritative(info, key as MetadataField)) fields.push({ label, value: `${before} → ${after}`, source: sourceOverride ?? sourceOf(info, key) });
	};
	if (info.contextWindow !== undefined) add("contextWindow", "Context", model.contextWindow === undefined ? "Not set" : model.contextWindow.toLocaleString("en-US"), info.contextWindow.toLocaleString("en-US"));
	if (info.maxTokens !== undefined) add("maxTokens", "Max output", model.maxTokens === undefined ? "Not set" : model.maxTokens.toLocaleString("en-US"), info.maxTokens.toLocaleString("en-US"));
	if (info.image !== undefined) add("image", "Images", Array.isArray(model.input) && model.input.includes("image") ? "On" : "Off", info.image ? "On" : "Off");
	if (info.reasoning !== undefined) add("reasoning", "Reasoning", model.reasoning === true ? "On" : "Off", info.reasoning ? "On" : "Off");
	if (info.cost) {
		for (const [key, label] of [["input", "Input $/1M"], ["output", "Output $/1M"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]] as const) add("cost", label, price(model.cost?.[key]), price(info.cost[key]));
	}
	return { title: "Changes", fields, lines: fields.length ? undefined : ["No metadata changes."] };
}

// Stored values are settings, not fresh capability claims. Common fields edit
// in place; connection overrides have a direct toolbar action.
export function storedDetails(raw: any, _provider?: any, editable = false, rawDefaults = raw): DetailSection[] {
	const model = typeof raw === "string" ? { id: raw } : raw ?? {};
	const defaults = typeof rawDefaults === "string" ? { id: rawDefaults } : rawDefaults ?? {};
	const defaultImage = Array.isArray(defaults.input) && defaults.input.includes("image");
	const defaultReasoning = readModelOptions(defaults).reasoning;
	const context: DetailField = { label: "Context", value: tokens(model.contextWindow), hint: exactTokens(model.contextWindow) };
	const output: DetailField = { label: "Max output", value: tokens(model.maxTokens), hint: exactTokens(model.maxTokens) };
	const image: DetailField = { label: "Images", value: Array.isArray(model.input) && model.input.includes("image") ? "On" : "Off" };
	const ceiling = readModelOptions(model).reasoning;
	const reasoning: DetailField = { label: "Reasoning", value: ceiling === "off" ? "Off" : ceiling };
	const showEffort = JSON.stringify(model.thinkingLevelMap) === JSON.stringify(defaults.thinkingLevelMap);
	if (editable) {
		Object.assign(context, { source: model.contextWindow === defaults.contextWindow ? "saved" : "custom", action: "context", editor: { kind: "text", value: model.contextWindow === undefined ? "" : String(model.contextWindow), placeholder: `${tokens(defaults.contextWindow)} · saved (default)` } });
		Object.assign(output, { source: model.maxTokens === defaults.maxTokens ? "saved" : "custom", action: "maxtokens", editor: { kind: "text", value: model.maxTokens === undefined ? "" : String(model.maxTokens), placeholder: `${tokens(defaults.maxTokens)} · saved (default)` } });
		Object.assign(image, { source: (image.value === "On") === defaultImage ? "saved" : "custom", action: "image", editor: { kind: "choice", value: image.value === "On" ? "on" : "off", choices: [false, true].map((on) => ({ value: on ? "on" : "off", label: `${on ? "On" : "Off"} · ${on === defaultImage ? "saved" : "custom"}` })) } });
		Object.assign(reasoning, { source: ceiling === defaultReasoning ? "saved" : "custom", action: "reasoning", editor: { kind: "choice", value: ceiling, choices: REASONING_LEVELS.map((value) => ({ value, label: `${value} · ${value === defaultReasoning ? "saved" : "custom"}` })) } });
	}
	const saved = storedMetadata(defaults);
	if (editable && reasoning.editor?.kind === "choice") {
		const source = saved.effortOptions?.length ? getMetadataSourceLabel(saved, "reasoning", true) : getMetadataSourceLabel(saved, "reasoning");
		reasoning.editor.choices = REASONING_LEVELS.map((value) => ({ value, label: `${value} · ${value === defaultReasoning ? source : "custom"}` }));
	}
	for (const [field, key] of [[context, "contextWindow"], [output, "maxTokens"], [image, "image"], [reasoning, "reasoning"]] as const) {
		if (field.source !== "custom" && saved[key] !== undefined) field.source = getMetadataSourceLabel(saved, key, key === "reasoning" && !!saved.effortOptions?.length);
	}
	const costEdits: Partial<ModelCostInfo> = {};
	for (const key of PRICE_KEYS) if (model.cost?.[key] !== undefined && model.cost[key] !== defaults.cost?.[key]) costEdits[key] = model.cost[key];
	const sections: DetailSection[] = [
		{ title: "Limits", fields: [context, output] },
		{ title: "Capabilities", fields: [image, reasoning, ...(showEffort ? effortDetails([saved]) : [])] },
		editable ? editablePricing(defaults.cost, costEdits, getMetadataSourceLabel(saved, "cost")) : pricing(model.cost, getMetadataSourceLabel(saved, "cost")),
	];
	if (model.baseUrl || model.api || model.headers) sections.push({ title: "Overrides", fields: [
		...(model.baseUrl ? [{ label: "Endpoint", value: model.baseUrl }] : []),
		...(model.api ? [{ label: "API", value: model.api }] : []),
		...(model.headers ? [{ label: "Headers", value: Object.keys(model.headers).join(", ") }] : []),
	] });
	return sections;
}
