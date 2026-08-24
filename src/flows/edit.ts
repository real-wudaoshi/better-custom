import { describeProbeInfo, fetchModelsDevInfoForBaseUrl, probeModels } from "model-probe";
import { apiKeyFromProvider, resolveApiKeyForProbe } from "../api-key.ts";
import { BUILTIN_PROVIDER_IDS, loadModelsConfig, MODELS_JSON_PATH, saveModelsConfig } from "../config.ts";
import { applyReasoning, findModel, modelIdOf, readCeilingString, readModelOptions } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import type { CommandContext, ModelProbeInfo, ModelsConfig, ProbeResult, ProviderApi, ProviderStyle } from "../types.ts";
import { pickMany, pickTriState, selectOne } from "../ui/select.ts";
import type { TriItem } from "../ui/select.ts";
import {
	promptCeilingProviderString,
	promptContextWindow,
	promptManualModels,
	promptMaxTokens,
	promptReasoning,
	promptImage,
} from "../ui/prompts.ts";
import { buildProbeUrl, normalizeEndpoint, slugify } from "../url.ts";
import {
	addModelEntriesToProvider,
	collectProbedModelInfo,
	describeProvider,
	describeProviderInline,
	fetchGatewayWideInfo,
	mutateModel,
	mutateProvider,
	providerModelItems,
	removeProvider,
} from "./shared.ts";

export async function editProviderFlow(ctx: CommandContext) {
	let cursor = 0;

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
			ctx.ui.notify(`No providers found in ${MODELS_JSON_PATH}`, "warning");
			return;
		}

		const choice = await selectOne(
			ctx,
			"Edit provider",
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

		cursor = providerIds.indexOf(choice);
		await editSingleProvider(ctx, choice);
	}
}

// Per-provider action menu. Returns when the user backs out to the provider list.
async function editSingleProvider(ctx: CommandContext, providerId: string) {
	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const provider = config.providers?.[providerId];
		if (!provider) {
			ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
			return;
		}

		const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
		const action = await selectOne(ctx, `Edit ${providerId}`, [
			{ value: "probe", label: "Re-probe for models", description: "Query /models again: add new models, flag vanished ones as unsupported, offer metadata updates" },
			{ value: "models", label: "Edit per model", description: `${modelCount} model${modelCount === 1 ? "" : "s"} — reasoning, image input, context, max tokens, headers, delete` },
			{ value: "deletemodels", label: "Delete models", description: "Remove multiple models at once" },
			{ value: "add", label: "Add models manually", description: "Type model ids to add" },
			{ value: "api", label: "API flavor", suffix: ` • ${typeof provider.api === "string" ? provider.api : "unset"}`, description: "Switch between Chat Completions, Responses, Anthropic Messages, and Gemini" },
			{ value: "endpoint", label: "Endpoint", suffix: ` • ${typeof provider.baseUrl === "string" ? provider.baseUrl : "unset"}`, description: "Change the provider's baseUrl" },
			{ value: "rename", label: "Rename provider", description: "Change the provider name in the models config" },
			{ value: "delete", label: "Delete provider", description: "Remove this provider from the models config" },
			{ value: "back", label: "Back", description: "Return to the provider list" },
		]);
		if (!action || action === "back") return;

		if (action === "models") {
			await editProviderModels(ctx, providerId);
		} else if (action === "probe") {
			await reprobeProvider(ctx, providerId);
		} else if (action === "deletemodels") {
			await deleteModelsFromProvider(ctx, providerId);
		} else if (action === "add") {
			await addModelsToProvider(ctx, providerId);
		} else if (action === "api") {
			await changeProviderApi(ctx, providerId);
		} else if (action === "endpoint") {
			await changeProviderEndpoint(ctx, providerId);
		} else if (action === "delete") {
			const confirmed = await ctx.ui.confirm("Delete provider?", describeProvider(providerId, provider));
			if (confirmed && (await removeProvider(ctx, providerId))) return; // provider is gone — back to the list
		} else if (action === "rename") {
			// Reassign so the menu keeps editing the same provider under its new name.
			const renamed = await renameProvider(ctx, providerId);
			if (renamed) providerId = renamed;
		}
	}
}

const API_OPTIONS: Array<{ value: ProviderApi; label: string; description: string }> = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
	{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
	{ value: "anthropic-messages", label: "Anthropic Messages", description: 'api: "anthropic-messages" — requires an Anthropic-style endpoint' },
	{ value: "google-generative-ai", label: "Gemini (Google generative AI)", description: 'api: "google-generative-ai" — native Gemini format; baseUrl must include the version path (/v1beta)' },
];

// Switch a provider's api flavor in the models config, keeping everything else.
async function changeProviderApi(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.api === "string" ? (provider.api as ProviderApi) : undefined;
	const options = API_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label,
		description: option.description,
		suffix: option.value === current ? " • current" : undefined,
	})).sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : 0));

	const choice = await selectOne(ctx, `API flavor for ${providerId}`, options);
	if (!choice || choice === current) return;

	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.api = choice;
		return true;
	});
	if (saved) ctx.ui.notify(`Changed "${providerId}" to ${choice}.`, "info");
}

// Change a provider's baseUrl, normalized the same way as at add time.
async function changeProviderEndpoint(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";

	const input = await ctx.ui.input("Endpoint", current || "e.g. https://api.example.com/v1");
	if (input === undefined) return;
	const trimmed = input.trim();
	if (!trimmed || trimmed === current) return;

	let normalized: string;
	try {
		normalized = normalizeEndpoint(trimmed, api);
	} catch (error) {
		ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.baseUrl = normalized;
		return true;
	});
	if (saved) ctx.ui.notify(`Endpoint for "${providerId}" set to ${normalized}.`, "info");
}

// Rename a provider's key in the models config, preserving its config and original
// position in the file. Returns the new id on success, or null if cancelled,
// unchanged, or rejected. Only touches the models config — a currently-selected model
// pinned to the old provider id must be reselected via /model afterwards.
async function renameProvider(ctx: CommandContext, providerId: string): Promise<string | null> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	config.providers ||= {};
	if (!config.providers[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return null;
	}

	const input = await ctx.ui.input("Rename provider", `current: ${providerId}`);
	if (input === undefined) return null;
	// Slugify so names stay consistent with the Add flow.
	const newId = slugify(input.trim());
	if (!newId || newId === providerId) return null;

	if (config.providers[newId]) {
		ctx.ui.notify(`Provider "${newId}" already exists. Choose a different name.`, "warning");
		return null;
	}

	if (BUILTIN_PROVIDER_IDS.has(newId)) {
		const ok = await ctx.ui.confirm(
			"Override built-in provider?",
			`"${newId}" matches a built-in provider id. Saving this will override that provider in the active models config. Continue?`,
		);
		if (!ok) return null;
	}

	// Rebuild key-by-key so the renamed entry keeps its position rather than
	// jumping to the bottom (a naive delete + reassign would reorder it).
	const rebuilt: Record<string, any> = {};
	for (const [key, value] of Object.entries(config.providers)) {
		rebuilt[key === providerId ? newId : key] = value;
	}
	config.providers = rebuilt;

	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}

	ctx.ui.notify(`Renamed "${providerId}" → "${newId}".`, "info");
	return newId;
}

// Remove several models at once: multi-select over the provider's models,
// confirm, then filter them out of the config.
async function deleteModelsFromProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const modelItems = providerModelItems(provider);
	if (modelItems.length === 0) {
		ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
		return;
	}

	const picked = await pickMany(ctx, `Delete models from ${providerId}`, modelItems);
	if (!picked || picked.length === 0) return;
	const confirmed = await ctx.ui.confirm(
		"Delete models?",
		`Remove ${picked.length} model${picked.length === 1 ? "" : "s"} from "${providerId}":\n${picked.map((id) => `- ${id}`).join("\n")}`,
	);
	if (!confirmed) return;

	const removeSet = new Set(picked);
	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.models = (Array.isArray(p.models) ? p.models : []).filter((m: any) => !removeSet.has(modelIdOf(m)));
		return true;
	});
	if (saved) ctx.ui.notify(`Deleted ${picked.length} model${picked.length === 1 ? "" : "s"} from "${providerId}".`, "info");
}

// Pick a model, then a field to edit. Each edit mutates one field in place so
// other fields (headers, overrides, cost) are preserved.
async function editProviderModels(ctx: CommandContext, providerId: string) {
	let cursor = 0;
	while (true) {
		let provider: any;
		try {
			provider = loadModelsConfig().providers?.[providerId];
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const modelItems = providerModelItems(provider);
		if (modelItems.length === 0) {
			ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
			return;
		}

		const choice = await selectOne(ctx, `Edit model in ${providerId}`, modelItems, {
			initialIndex: Math.min(cursor, modelItems.length - 1),
		});
		if (!choice) return;
		cursor = modelItems.findIndex((item) => item.value === choice);

		const deleted = await editSingleModel(ctx, providerId, choice);
		if (deleted) cursor = Math.max(0, cursor - 1);
	}
}

// Field-picker for one model. Returns true if the model was deleted (so the
// caller can adjust its cursor).
async function editSingleModel(ctx: CommandContext, providerId: string, modelId: string): Promise<boolean> {
	while (true) {
		let model: any;
		try {
			model = findModel(loadModelsConfig().providers?.[providerId], modelId);
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		if (!model) {
			ctx.ui.notify(`Model "${modelId}" no longer exists.`, "warning");
			return false;
		}

		const opts = readModelOptions(model);
		const ctxWin = typeof model.contextWindow === "number" ? model.contextWindow : "unset";
		const maxTok = typeof model.maxTokens === "number" ? model.maxTokens : "unset";
		const hasHeaders = model.headers && Object.keys(model.headers).length > 0;
		const override = model.baseUrl || model.api ? "set" : "unset";

		const field = await selectOne(ctx, `Edit ${modelId}`, [
			{ value: "reasoning", label: "Reasoning", suffix: ` • ${opts.reasoning}`, description: "Set the reasoning ceiling (off → xhigh)" },
			{ value: "image", label: "Image input", suffix: ` • ${opts.image ? "on" : "off"}`, description: "Toggle image input (text+image vs text-only)" },
			{ value: "context", label: "Context window", suffix: ` • ${ctxWin}`, description: "Max context tokens for this model" },
			{ value: "maxtokens", label: "Max output tokens", suffix: ` • ${maxTok}`, description: "Max tokens this model may generate" },
			{ value: "override", label: "Headers / endpoint override", suffix: ` • ${hasHeaders ? "headers" : override}`, description: "Per-model HTTP headers and api/baseUrl override" },
			{ value: "delete", label: "Delete this model", description: "Remove this model from the provider" },
			{ value: "back", label: "Back", description: "Return to the model list" },
		]);
		if (!field || field === "back") return false;

		if (field === "reasoning") {
			const reasoning = await promptReasoning(ctx, opts.reasoning);
			if (reasoning === null) continue;
			let ceilingOverrides: Partial<Record<"xhigh" | "max", string>> | undefined;
			if (reasoning === "xhigh" || reasoning === "max") {
				const value = await promptCeilingProviderString(ctx, reasoning, readCeilingString(model, reasoning));
				if (value) {
					ceilingOverrides = {};
					ceilingOverrides[reasoning] = value;
				}
			}
			await mutateModel(ctx, providerId, modelId, (m) => applyReasoning(m, reasoning, ceilingOverrides));
		} else if (field === "image") {
			const image = await promptImage(ctx, opts.image);
			if (image === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { m.input = image ? ["text", "image"] : ["text"]; });
		} else if (field === "context") {
			const result = await promptContextWindow(ctx, typeof model.contextWindow === "number" ? model.contextWindow : undefined);
			if (result === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { if (result === 0) delete m.contextWindow; else m.contextWindow = result; });
		} else if (field === "maxtokens") {
			const result = await promptMaxTokens(ctx, typeof model.maxTokens === "number" ? model.maxTokens : undefined);
			if (result === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { if (result === 0) delete m.maxTokens; else m.maxTokens = result; });
		} else if (field === "override") {
			await editModelOverride(ctx, providerId, modelId);
		} else if (field === "delete") {
			const ok = await ctx.ui.confirm("Delete model?", `Remove "${modelId}" from "${providerId}"?`);
			if (!ok) continue;
			const saved = await mutateProvider(ctx, providerId, (p) => {
				const models = Array.isArray(p.models) ? p.models : [];
				const index = models.findIndex((m: any) => modelIdOf(m) === modelId);
				if (index === -1) return false;
				models.splice(index, 1);
				return true;
			});
			if (saved) ctx.ui.notify(`Deleted "${modelId}".`, "info");
			return true;
		}
	}
}

// Edit per-model HTTP headers and api/baseUrl endpoint override.
async function editModelOverride(ctx: CommandContext, providerId: string, modelId: string) {
	let model: any;
	try {
		model = findModel(loadModelsConfig().providers?.[providerId], modelId);
	} catch {
		model = undefined;
	}
	const currentBase = typeof model?.baseUrl === "string" ? model.baseUrl : "";
	const currentHeaders = model?.headers && typeof model.headers === "object" ? JSON.stringify(model.headers) : "";

	const base = await ctx.ui.input("baseUrl override (blank = use provider, \"-\" to clear)", currentBase || "e.g. https://api.example.com/v1");
	if (base === undefined) return;
	const headers = await ctx.ui.input("Headers as JSON (blank = keep, \"-\" to clear)", currentHeaders || 'e.g. {"x-api-version":"2024-01"}');
	if (headers === undefined) return;

	let parsedHeaders: Record<string, string> | null | undefined;
	const trimmedHeaders = headers.trim();
	if (trimmedHeaders === "-") parsedHeaders = null;
	else if (trimmedHeaders) {
		try {
			const obj = JSON.parse(trimmedHeaders);
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
			parsedHeaders = obj;
		} catch (error) {
			ctx.ui.notify(`Invalid headers JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
	}

	await mutateModel(ctx, providerId, modelId, (m) => {
		const trimmedBase = base.trim();
		if (trimmedBase === "-") delete m.baseUrl;
		else if (trimmedBase) m.baseUrl = trimmedBase;
		if (parsedHeaders === null) delete m.headers;
		else if (parsedHeaders) m.headers = parsedHeaders;
	});
}

// Fields where a fresh probe may override the stored config. Only values
// detected from the gateway or the models.dev catalog count as authoritative
// — local-rule guesses and built-in defaults never rewrite an existing entry.
const DIFFABLE_FIELDS = ["contextWindow", "image", "reasoning"] as const;
type DiffableField = (typeof DIFFABLE_FIELDS)[number];
type MetaChange = { field: DiffableField; label: string };

// Compare a stored model entry against freshly resolved probe info. Returns
// the authoritative differences, rendered as `context 128000 -> 1000000` for
// the context window and `image [+]` / `reasoning [-]` for boolean fields.
function diffStoredModel(model: any, info: ModelProbeInfo): MetaChange[] {
	const guessed = new Set<string>([...(info.inferredFields ?? []), ...(info.defaultedFields ?? [])]);
	const changes: MetaChange[] = [];
	for (const field of DIFFABLE_FIELDS) {
		const value = info[field];
		if (value === undefined || guessed.has(field)) continue;
		if (field === "contextWindow") {
			const old = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
			if (old !== value) changes.push({ field, label: `context ${old ?? "unset"} -> ${value}` });
		} else if (field === "image") {
			const old = Array.isArray(model?.input) ? model.input.includes("image") : true;
			if (old !== value) changes.push({ field, label: `image [${value ? "+" : "-"}]` });
		} else {
			const old = model?.reasoning === true;
			if (old !== value) changes.push({ field, label: `reasoning [${value ? "+" : "-"}]` });
		}
	}
	return changes;
}

// Write the authoritative probed values onto a stored entry in place.
function applyMetaChanges(entry: any, info: ModelProbeInfo, changes: MetaChange[]) {
	for (const change of changes) {
		if (change.field === "contextWindow") entry.contextWindow = info.contextWindow;
		else if (change.field === "image") entry.input = info.image ? ["text", "image"] : ["text"];
		else applyReasoning(entry, info.reasoning ? "xhigh" : "off");
	}
}

// One-line summary of a stored entry's current config, for the re-probe list.
function storedModelSummary(model: any): string {
	const details: string[] = [];
	if (model?.reasoning === true) details.push(`reasoning:${readModelOptions(model).reasoning}`);
	if (Array.isArray(model?.input) && model.input.includes("image")) details.push("image");
	if (typeof model?.contextWindow === "number") details.push(`context ${model.contextWindow}`);
	return details.length > 0 ? details.join(" • ") : "up to date";
}

async function reprobeProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";
	if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages" && api !== "google-generative-ai") {
		ctx.ui.notify("This provider's API doesn't expose /models. Use 'Add models manually'.", "warning");
		return;
	}
	const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	if (!baseUrl) {
		ctx.ui.notify(`Provider "${providerId}" has no baseUrl to probe.`, "error");
		return;
	}

	const apiKey = apiKeyFromProvider(provider);
	let probed: ProbeResult;
	try {
		ctx.ui.notify(`Probing ${buildProbeUrl(baseUrl)} ...`, "info");
		probed = await probeModels(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value));
	} catch (error) {
		ctx.ui.notify(`Probe failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const storedModels: any[] = Array.isArray(provider.models) ? provider.models : [];
	const storedIds: string[] = [];
	for (const m of storedModels) {
		const id = modelIdOf(m);
		if (id) storedIds.push(id);
	}
	const storedSet = new Set(storedIds);
	const probedSet = new Set(probed.ids);
	const novelIds = probed.ids.filter((id) => !storedSet.has(id));
	const overlapIds = probed.ids.filter((id) => storedSet.has(id));
	const unsupportedIds = storedIds.filter((id) => !probedSet.has(id));

	const style: ProviderStyle =
		provider?.api === "anthropic-messages"
			? "anthropic"
			: provider?.api === "google-generative-ai"
				? "gemini"
				: provider?.compat
					? "ollama"
					: "openai";

	// Gateway-wide metadata (one call per source) — fetch BEFORE any picker so
	// it shows real detected values instead of local-rule guesses. Re-probe
	// always uses the auto profile.
	const profile = AUTO_PROBE_PROFILE;
	let gatewayWide: Map<string, ModelProbeInfo> | undefined;
	if (style !== "ollama") {
		ctx.ui.notify("Fetching model metadata (context, image/video, reasoning) ...", "info");
		gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, profile);
		if (gatewayWide.size > 0) {
			for (const [id, info] of gatewayWide) {
				probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
			}
		}
	}

	// models.dev catalog tier — above the local rules, below detected values.
	const modelsDev = style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(probed.baseUrl) : undefined;

	// Resolve metadata for everything we may touch: new models (to describe and
	// add them) and already-configured ones (to diff against the stored entry).
	const infoById = await collectProbedModelInfo(
		ctx,
		style,
		apiKey,
		probed.baseUrl,
		[...novelIds, ...overlapIds],
		probed.infoById,
		gatewayWide,
		modelsDev,
	);

	// One tri-state list for everything: [x] keep/add with the latest metadata,
	// [-] keep but don't touch metadata (only for models with changes), [ ]
	// remove/skip. Models needing a decision come first.
	const novelSet = new Set(novelIds);
	const changeById = new Map<string, MetaChange[]>();
	for (const id of overlapIds) {
		const info = infoById.get(id);
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		if (!info || !stored) continue;
		const changes = diffStoredModel(stored, info);
		if (changes.length > 0) changeById.set(id, changes);
	}

	const items: TriItem[] = [];
	for (const [id, changes] of changeById) {
		items.push({
			value: id,
			label: id,
			description: changes.map((c) => c.label).join(" • "),
			searchText: `${id} updated`,
			states: ["off", "mid", "on"],
			initial: "mid",
		});
	}
	for (const id of novelIds) {
		items.push({
			value: id,
			label: id,
			description: describeProbeInfo(infoById.get(id) ?? {}),
			searchText: `${id} new`,
			states: ["off", "on"],
			initial: "off",
		});
	}
	for (const id of unsupportedIds) {
		// No fresh probe data for these — show the metadata already stored in
		// the config, same as any other configured model, with "unsupported"
		// as a suffix.
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		items.push({
			value: id,
			label: `${id} • unsupported`,
			description: storedModelSummary(stored),
			searchText: `${id} unsupported`,
			states: ["off", "on"],
			initial: "on",
		});
	}
	for (const id of storedIds) {
		if (changeById.has(id) || !probedSet.has(id)) continue;
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		items.push({ value: id, label: id, description: storedModelSummary(stored), states: ["off", "on"], initial: "on" });
	}

	const picked = await pickTriState(ctx, `Re-probe ${providerId}`, items);
	if (picked === null) return;

	const addIds: string[] = [];
	const removeIds: string[] = [];
	const updateIds: string[] = [];
	for (const item of items) {
		const state = picked.get(item.value) ?? item.initial;
		if (novelSet.has(item.value)) {
			if (state === "on") addIds.push(item.value);
			continue;
		}
		if (state === "off") removeIds.push(item.value);
		else if (state === "on" && changeById.has(item.value)) updateIds.push(item.value);
		// "mid": keep the stored entry unchanged
	}

	let touched = 0;
	if (removeIds.length > 0 || updateIds.length > 0) {
		const removeSet = new Set(removeIds);
		const saved = await mutateProvider(ctx, providerId, (p) => {
			let models: any[] = Array.isArray(p.models) ? p.models : [];
			models = models.filter((m) => !removeSet.has(modelIdOf(m)));
			for (const id of updateIds) {
				const index = models.findIndex((m) => modelIdOf(m) === id);
				if (index === -1) continue;
				// Strings become objects so the new fields have somewhere to live.
				if (typeof models[index] === "string") models[index] = { id, input: ["text", "image"] };
				applyMetaChanges(models[index], infoById.get(id)!, changeById.get(id)!);
			}
			p.models = models;
			return true;
		});
		if (saved) {
			touched += removeIds.length + updateIds.length;
			const parts: string[] = [];
			if (updateIds.length > 0) parts.push(`updated metadata for ${updateIds.length}`);
			if (removeIds.length > 0) parts.push(`removed ${removeIds.length}`);
			ctx.ui.notify(`Re-probe: ${parts.join(", ")} in "${providerId}".`, "info");
		}
	}
	if (addIds.length > 0) {
		touched += addIds.length;
		await addModelEntriesToProvider(ctx, providerId, addIds, infoById);
	}
	if (touched === 0) {
		ctx.ui.notify("No changes — everything the endpoint returned is already configured and up to date.", "info");
	}
}

async function addModelsToProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const style: ProviderStyle =
		provider?.api === "anthropic-messages"
			? "anthropic"
			: provider?.api === "google-generative-ai"
				? "gemini"
				: provider?.compat
					? "ollama"
					: "openai";
	const manual = await promptManualModels(ctx, style);
	if (!manual) return;
	await addModelEntriesToProvider(ctx, providerId, manual.ids, undefined, manual.options);
}
