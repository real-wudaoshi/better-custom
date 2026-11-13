import { Key } from "@mariozechner/pi-tui";
import { fetchModelMetadata, getMetadataSourceLabel, type MetadataField, type ModelMetadataOptions } from "model-probe";
import { describeApiKey, parseApiKeyInput } from "../api-key.ts";
import { CUSTOM_PREFIX, ensureCustomId, loadModelsConfig } from "../config.ts";
import { formatTokens, parseTokenInput } from "../format.ts";
export { parseTokenInput } from "../format.ts";
import { REASONING_LEVELS } from "../types.ts";
import type { ApiKeyMode, CommandContext, DetailField, ModelOptions, ModelProbeInfo, ProviderApi, ProviderStyle, ReasoningCeiling, SelectItem } from "../types.ts";
import { editablePricing, effortDetails, editedModelOptions, editorDefaults, editPriceValue, priceValidation, PRICE_KEYS, sourceOf, type ModelEdits, type PriceKey } from "./metadata.ts";
import { normalizeEndpoint, slugify, suggestProviderId } from "../url.ts";
import { panelInput } from "./panel.ts";
import { selectOne } from "./select.ts";
import { showWorkbench, workbenchState } from "./workbench.ts";

export async function promptApiKey(ctx: CommandContext): Promise<{ mode: ApiKeyMode; value?: string } | null> {
	const value = await panelInput(ctx,"API key (blank = none)", "paste a key, $ENV_VAR, or !command — stored separately from provider settings");
	return value === undefined ? null : parseApiKeyInput(value);
}

export async function promptReasoning(ctx: CommandContext, current?: ReasoningCeiling): Promise<ReasoningCeiling | null> {
	const items: SelectItem[] = REASONING_LEVELS.map((level) => ({
		value: level,
		label: level === "off" ? "Off — no reasoning" : `Up to ${level}`,
		description: level === "off" ? "Disable reasoning for this model" : "A configuration ceiling, not a claim that the model supports every level below it",
	}));
	return await selectOne(ctx, "Reasoning ceiling", items, { initialIndex: Math.max(0, REASONING_LEVELS.indexOf(current ?? "off")) }) as ReasoningCeiling | null;
}

export async function promptCeilingProviderString(ctx: CommandContext, level: "xhigh" | "max", current?: string): Promise<string | undefined> {
	const value = await panelInput(ctx,`${level} provider value (blank = ${level})`, current && current !== level ? `current: ${current}` : `e.g. max; leave blank to send "${level}"`);
	return value?.trim() || undefined;
}

export async function promptImage(ctx: CommandContext, current?: boolean): Promise<boolean | null> {
	const choice = await selectOne(ctx, "Image input", [
		{ value: "yes", label: "Enabled — text + images", description: "Pi may send images to this model" },
		{ value: "no", label: "Text only", description: "Pi will not send images to this model" },
	], { initialIndex: current === false ? 1 : 0 });
	return choice ? choice === "yes" : null;
}

async function promptTokens(ctx: CommandContext, title: string, current?: number): Promise<number | null> {
	while (true) {
		const value = await panelInput(ctx,title, `${current === undefined ? "Not set" : `Current: ${current.toLocaleString("en-US")}`} · blank keep · 0 clear · accepts 128K / 1M`);
		if (value === undefined || !value.trim()) return null;
		const parsed = parseTokenInput(value);
		if (parsed !== undefined) return parsed;
		ctx.ui.notify("Use whole tokens or K/M units, e.g. 128000, 128K, 1M. Use 0 to clear.", "warning");
	}
}

export const promptContextWindow = (ctx: CommandContext, current?: number): Promise<number | null> => promptTokens(ctx, "Context window", current);
export const promptMaxTokens = (ctx: CommandContext, current?: number): Promise<number | null> => promptTokens(ctx, "Maximum output", current);
const apiForStyle = (style: ProviderStyle): ProviderApi => style === "anthropic" ? "anthropic-messages" : style === "gemini" ? "google-generative-ai" : style === "openai-responses" ? "openai-responses" : "openai-completions";

// IDs and metadata are one draft form, not a prompt followed by a picker.
// Auto values remain per-model when pasting several IDs. Explicit edits survive
// changing the IDs, so fields can be filled in any order.
export async function promptManualModels(
	ctx: CommandContext,
	style: ProviderStyle,
	options?: { existingIds?: string[]; metadata?: ModelMetadataOptions; defaults?: Map<string, ModelProbeInfo> },
): Promise<{ ids: string[]; options: Map<string, ModelOptions>; infoById: Map<string, ModelProbeInfo>; edits: Map<string, ModelEdits> } | null> {
	let ids: string[] = [], idText = "";
	let metadataContext = options?.metadata?.context;
	const existing = new Set(options?.existingIds ?? []);
	const bases = new Map<string, ModelOptions>();
	const infos = new Map<string, ModelProbeInfo>();
	const overrides: ModelEdits = {};
	const row: SelectItem = { value: "new-model", label: "Add model" };
	const effective = (id: string): ModelOptions => editedModelOptions(editorDefaults(infos.get(id)!), overrides);
	const mixedPrices = () => new Set<PriceKey>(PRICE_KEYS.filter((key) => ids.some((id) => bases.get(id)?.cost?.[key] !== bases.get(ids[0])?.cost?.[key])));
	const validation = () => {
		for (const id of ids) {
			const pricingError = priceValidation(bases.get(id)?.cost, overrides.cost);
			if (pricingError) return `${id}: ${pricingError}`;
			const value = effective(id);
			if (value.contextWindow && value.maxTokens && value.maxTokens > value.contextWindow) return `${id}: max output exceeds context`;
		}
		return "";
	};
	const refreshFields = () => {
		const values = ids.map(effective), baseValues = ids.map((id) => bases.get(id)!);
		const provenance = (key: string) => [...new Set(ids.map((id) => {
			return getMetadataSourceLabel(infos.get(id), key as MetadataField, key === "reasoning");
		}))].join(" / ") || "default";
		const limits = (key: "contextWindow" | "maxTokens", label: string): DetailField => {
			const first = overrides[key] ?? values[0]?.[key];
			const mixed = values.some((value) => value[key] !== first);
			return { label, action: key,
				value: mixed ? "Auto per model" : first === undefined ? "Auto" : formatTokens(first),
				source: overrides[key] === undefined ? (ids.length && !mixed ? provenance(key) : undefined) : "custom",
				editor: { kind: "text", value: mixed || first === undefined ? "" : String(first), placeholder: `${baseValues[0]?.[key] === undefined ? "Auto per model" : formatTokens(baseValues[0][key]!)} · ${provenance(key)} (default)` },
			};
		};
		const images = overrides.image ?? values[0]?.image;
		const mixedImages = values.some((value) => value.image !== images);
		const reasoning = overrides.reasoning ?? values[0]?.reasoning;
		const mixedReasoning = values.some((value) => value.reasoning !== reasoning);
		const defaultImage = baseValues[0]?.image, defaultReasoning = baseValues[0]?.reasoning;
		const mixedDefaultImage = !baseValues.length || baseValues.some((value) => value.image !== defaultImage);
		const mixedDefaultReasoning = !baseValues.length || baseValues.some((value) => value.reasoning !== defaultReasoning);
		row.details = [
			{ title: "", fields: [{ label: "Model ID(s)", value: ids.length > 1 ? `${ids[0]} + ${ids.length - 1} more` : ids[0] ?? "Required", action: "ids", editor: { kind: "text", value: idText } }] },
			{ title: "Limits", fields: [limits("contextWindow", "Context"), limits("maxTokens", "Max output")] },
			{ title: "Capabilities", fields: [
				{ label: "Images", action: "image", value: mixedImages ? "Auto per model" : images === undefined ? "Auto" : images ? "On" : "Off", source: overrides.image === undefined ? (ids.length && !mixedImages ? provenance("image") : undefined) : "custom",
					editor: { kind: "choice", value: overrides.image === undefined ? mixedDefaultImage ? "auto" : defaultImage ? "on" : "off" : overrides.image ? "on" : "off", choices: [
						...(mixedDefaultImage ? [{ value: "auto", label: `Auto per model · ${provenance("image")}` }] : []),
						...[false, true].map((on) => ({ value: on ? "on" : "off", label: `${on ? "On" : "Off"} · ${!mixedDefaultImage && on === defaultImage ? provenance("image") : "custom"}` })),
					] } },
				{ label: "Reasoning", action: "reasoning", value: mixedReasoning ? "Auto per model" : reasoning ?? "Auto", source: overrides.reasoning === undefined ? (ids.length && !mixedReasoning ? provenance("reasoning") : undefined) : "custom",
					editor: { kind: "choice", value: overrides.reasoning ?? (mixedDefaultReasoning ? "auto" : defaultReasoning!), choices: [
						...(mixedDefaultReasoning ? [{ value: "auto", label: `Auto per model · ${provenance("reasoning")}` }] : []),
						...REASONING_LEVELS.map((value) => ({ value, label: `${value} · ${!mixedDefaultReasoning && value === defaultReasoning ? provenance("reasoning") : "custom"}` })),
					] } },
				...(overrides.reasoning === undefined ? effortDetails(ids.map((id) => infos.get(id))) : []),
			] },
			editablePricing(baseValues[0]?.cost, overrides.cost, provenance("cost"), mixedPrices()),
		];
	};
	refreshFields();
	const event = await showWorkbench(ctx, {
		title: "Add model", form: true, startEditing: true, items: [row],
		status: validation,
		onEdit: async (_row, field, value) => {
			if (field.action === "ids") {
				const next = [...new Set(value.trim().split(/[\s,;]+/).filter(Boolean))];
				if (!next.length) return "Enter a model ID; commas separate multiple IDs.";
				const duplicate = next.find((id) => existing.has(id));
				if (duplicate) return `Already configured: ${duplicate}`;
				const missing = next.filter((id) => !options?.defaults?.has(id));
				const batch = missing.length ? await fetchModelMetadata(missing, {
					...options?.metadata, api: options?.metadata?.api ?? apiForStyle(style), context: metadataContext,
				}) : undefined;
				if (batch) metadataContext = batch.context;
				ids = next; idText = value.trim(); bases.clear(); infos.clear();
				for (const id of ids) {
					const info = options?.defaults?.get(id) ?? batch!.infoById.get(id)!;
					infos.set(id, info); bases.set(id, editorDefaults(info).options);
				}
				for (const key of ["contextWindow", "maxTokens", "image", "reasoning"] as const) {
					if (overrides[key] !== undefined && ids.every((id) => bases.get(id)![key] === overrides[key])) delete overrides[key];
				}
				for (const key of PRICE_KEYS) {
					if (overrides.cost?.[key] !== undefined && ids.every((id) => bases.get(id)!.cost?.[key] === overrides.cost![key])) delete overrides.cost[key];
				}
				if (overrides.cost && !Object.keys(overrides.cost).length) delete overrides.cost;
			} else if (field.action?.startsWith("cost.")) {
				const error = editPriceValue(bases.get(ids[0])?.cost, overrides, field.action, value, mixedPrices());
				if (error) return error;
			} else if (field.action === "contextWindow" || field.action === "maxTokens") {
				const parsed = value.trim() ? parseTokenInput(value) : 0;
				if (parsed === undefined) return "Use tokens, 128K or 1M; blank restores Auto.";
				if (parsed === 0 || (ids.length > 0 && ids.every((id) => bases.get(id)![field.action as "contextWindow" | "maxTokens"] === parsed))) delete overrides[field.action]; else overrides[field.action] = parsed;
			} else if (field.action === "image") {
				if (value === "auto" || (ids.length > 0 && ids.every((id) => bases.get(id)!.image === (value === "on")))) delete overrides.image; else overrides.image = value === "on";
			} else if (field.action === "reasoning") {
				if (value === "auto" || (ids.length > 0 && ids.every((id) => bases.get(id)!.reasoning === value))) delete overrides.reasoning;
				else if (REASONING_LEVELS.includes(value as ReasoningCeiling)) overrides.reasoning = value as ReasoningCeiling;
				else return "Choose a reasoning level.";
			}
			refreshFields();
		},
		actions: () => [
			{ id: "add", label: ids.length > 1 ? `Add (${ids.length})` : "Add", key: Key.ctrl("s"), disabled: !ids.length || !!validation() },
			{ id: "cancel", label: "Cancel" },
		],
	});
	return event?.action === "add" ? { ids, options: new Map(ids.map((id) => [id, effective(id)])), infoById: infos, edits: new Map(ids.map((id) => [id, { ...overrides }])) } : null;
}

export async function promptProviderStyle(ctx: CommandContext): Promise<{ style: ProviderStyle; api: ProviderApi } | null> {
	const choice = await selectOne(ctx, "API protocol", [
		{ value: "openai", label: "OpenAI-compatible · Chat Completions", description: "Most gateways and compatible servers" },
		{ value: "openai-responses", label: "OpenAI Responses", description: "The /responses API" },
		{ value: "anthropic", label: "Anthropic Messages", description: "Native /messages format" },
		{ value: "gemini", label: "Gemini", description: "Native Google API; keep /v1beta in the endpoint" },
		{ value: "ollama", label: "Ollama", description: "Local Ollama with native metadata discovery" },
	]);
	return choice ? { style: choice as ProviderStyle, api: apiForStyle(choice as ProviderStyle) } : null;
}

export async function promptEndpoint(ctx: CommandContext, style: ProviderStyle, api: ProviderApi): Promise<{ normalized: string; raw: string } | null> {
	const input = await panelInput(ctx,"Endpoint", style === "ollama" ? "http://localhost:11434/v1" : style === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.example.com/v1 (a scheme-less URL is accepted)");
	if (input === undefined) return null;
	const raw = input.trim();
	try { return { normalized: normalizeEndpoint(raw, api), raw }; }
	catch (error) { ctx.ui.notify(`Invalid endpoint: ${String(error)}`, "warning"); return null; }
}

export async function promptProviderId(ctx: CommandContext, endpoint: string, suggestion?: string): Promise<string | null> {
	const suggested = ensureCustomId(slugify(suggestion ?? suggestProviderId(endpoint)));
	while (true) {
		const input = await panelInput(ctx,`Provider name (blank = ${suggested})`, "A unique name, e.g. work-relay; the custom. prefix is added automatically");
		if (input === undefined) return null;
		const id = ensureCustomId(slugify(input.trim() || suggested));
		if (id === CUSTOM_PREFIX) { ctx.ui.notify("Provider name is required.", "warning"); continue; }
		try {
			if (loadModelsConfig().providers?.[id]) { ctx.ui.notify(`Provider "${id}" already exists. Choose another name.`, "warning"); continue; }
		} catch (error) { ctx.ui.notify(`Could not read provider configuration: ${String(error)}`, "error"); return null; }
		return id;
	}
}

export type ProviderConnection = {
	style: ProviderStyle; api: ProviderApi; endpoint: { normalized: string; raw: string };
	providerId: string; name?: string; apiKey: { mode: ApiKeyMode; value?: string };
};

// Step one of the wizard. Back from the model step passes this draft back in;
// endpoint, protocol, name and key are edited inline, with no nested prompts.
export async function promptProviderConnection(
	ctx: CommandContext,
	preset?: { endpoint: string; suggestion: string; catalog: string },
	initial?: ProviderConnection,
): Promise<ProviderConnection | null> {
	let style: ProviderStyle = initial?.style ?? "openai";
	let api: ProviderApi = initial?.api ?? "openai-completions";
	let raw = initial?.endpoint.raw ?? preset?.endpoint ?? "";
	let name = initial?.name;
	let apiKey = initial?.apiKey ?? { mode: "none" as ApiKeyMode };
	let issue = "";
	const state = workbenchState("connection");
	const endpointDefault = preset?.endpoint ?? initial?.endpoint.raw ?? "";
	const styles: Array<{ value: ProviderStyle; label: string }> = [
		{ value: "openai", label: "OpenAI Chat Completions" }, { value: "openai-responses", label: "OpenAI Responses" },
		{ value: "anthropic", label: "Anthropic Messages" }, { value: "gemini", label: "Gemini" }, { value: "ollama", label: "Ollama" },
	];
	const suggestedName = () => {
		try { return ensureCustomId(slugify(preset?.suggestion ?? (raw ? suggestProviderId(normalizeEndpoint(raw, api)) : "provider"))); }
		catch { return "custom.provider"; }
	};
	while (true) {
		const row: SelectItem = { value: "connection", label: "Connection" };
		const update = () => {
			row.details = [{ title: "Connection", fields: [
				{ label: "Endpoint", value: raw || "Required", source: preset && raw === preset.endpoint ? "models.dev" : raw ? "custom" : undefined, action: "endpoint",
					editor: { kind: "text", value: raw, placeholder: endpointDefault || "https://api.example.com/v1" } },
				{ label: "API", value: styles.find((option) => option.value === style)!.label, source: style === "openai" ? preset ? "models.dev" : "default" : "custom", action: "api",
					editor: { kind: "choice", value: style, choices: styles.map((option) => ({ value: option.value, label: `${option.label} · ${option.value === "openai" ? preset ? "models.dev" : "default" : "custom"}` })) } },
				{ label: "Name", value: name ?? suggestedName(), source: name ? "custom" : "default", action: "name",
					editor: { kind: "text", value: name ?? "", placeholder: `${suggestedName()} (default)` } },
				{ label: "API key", value: describeApiKey(apiKey), action: "key",
					editor: { kind: "text", value: "", placeholder: "Blank keeps the default; - removes it; $ENV_VAR / !command supported" } },
			] }, ...(preset ? [{ title: "Catalog", lines: [`models.dev/${preset.suggestion} · sync at session start`] }] : [])];
		};
		update();
		const event = await showWorkbench(ctx, {
			title: `Add provider · 1/2 Connection${preset ? ` · ${preset.catalog}` : ""}`,
			form: true, state, startEditing: !raw, items: [row], warning: () => issue,
			onEdit: (_row, field, value) => {
				if (field.action === "endpoint") {
					const next = value.trim() || endpointDefault;
					if (!next) return "An endpoint is required.";
					try { normalizeEndpoint(next, api); } catch (error) { return String(error); }
					raw = next;
				} else if (field.action === "api") {
					if (!styles.some((option) => option.value === value)) return "Choose an API protocol.";
					style = value as ProviderStyle; api = apiForStyle(style);
				} else if (field.action === "name") {
					const nextName = value.trim() ? ensureCustomId(slugify(value.trim())) : undefined;
					if (nextName === CUSTOM_PREFIX) return "Enter a provider name.";
					name = nextName;
				} else if (field.action === "key") apiKey = !value.trim() ? initial?.apiKey ?? { mode: "none" } : value.trim() === "-" ? { mode: "none" } : parseApiKeyInput(value);
				issue = "";
				update();
			},
			actions: () => [{ id: "continue", label: "Next: add models", key: Key.ctrl("s"), disabled: !raw }, { id: "cancel", label: "Cancel" }],
		});
		if (!event || event.action === "cancel") return null;
		try {
			const normalized = normalizeEndpoint(raw, api), providerId = name ?? suggestedName();
			if (loadModelsConfig().providers?.[providerId]) { issue = "Provider ID already in use. Edit the Name field."; state.focus = "details"; state.detail = 2; continue; }
			return { style, api, endpoint: { raw, normalized }, providerId, name, apiKey };
		} catch (error) { issue = String(error); }
	}
}
