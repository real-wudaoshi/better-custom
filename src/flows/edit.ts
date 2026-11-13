import { Key } from "@mariozechner/pi-tui";
import { chatModelCandidates, fetchModelMetadata, probeDeveloperRole } from "model-probe";
import { apiKeyFromProvider, describeApiKey, parseApiKeyInput, resolveApiKeyForProbe, serializeApiKey } from "../api-key.ts";
import { ensureCustomId, loadModelsConfig, STORE_PATH, renameProviderApiKey, saveModelsConfig, saveProviderApiKey } from "../config.ts";
import { describeInfo, describeStoredModel, formatCost, formatTokens } from "../format.ts";
import { applyModelMetadata, applyReasoning, buildModelEntry, findModel, modelIdOf, modelMetadataChanges, readCeilingString, readModelOptions } from "../model-entry.ts";
import { managedProvider, renameManaged, suppressModels } from "../modelsdev-sync.ts";
import type { CommandContext, DetailSection, ModelProbeInfo, ModelsConfig, ProviderApi } from "../types.ts";
import { pickMany, selectOne } from "../ui/select.ts";
import { panelConfirm, panelInput } from "../ui/panel.ts";
import { applyModelEdits, editedModelOptions, editorDefaults, editPriceValue, markModelEdits, mergedCost, priceValidation, PRICE_KEYS, probeDetails, storedDetails, type ModelEdits } from "../ui/metadata.ts";
import { reviewChanges, type ReviewItem } from "../ui/review.ts";
import { showWorkbench, workbenchState } from "../ui/workbench.ts";
import { parseTokenInput, promptManualModels } from "../ui/prompts.ts";
import { REASONING_LEVELS, type ReasoningCeiling } from "../types.ts";
import { normalizeEndpoint, slugify } from "../url.ts";
import {
	addModelEntriesToProvider,
	describeProvider,
	mutateProvider,
	providerModelItems,
	providerStyleOf,
	removeProvider,
} from "./shared.ts";

// Common metadata edits stay in the inspector and update drafts synchronously.
type ModelDraft = { base: any; value: any };
const EDITABLE_KEYS = ["contextWindow", "maxTokens", "input", "reasoning", "thinkingLevelMap", "baseUrl", "api", "headers", "cost"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const modelObject = (raw: any) => typeof raw === "string" ? { id: raw } : structuredClone(raw);
const changedKeys = (draft: ModelDraft) => EDITABLE_KEYS.filter((key) => !same(draft.base[key], draft.value[key]));

export async function editSingleProvider(ctx: CommandContext, providerId: string) {
	const state = workbenchState();
	const drafts = new Map<string, ModelDraft>();
	const draftError = () => {
		for (const [id, draft] of drafts) if (changedKeys(draft).includes("cost")) {
			const error = priceValidation(undefined, draft.value.cost);
			if (error) return `${id}: ${error}`;
		}
		return "";
	};
	const save = async (): Promise<boolean> => {
		if (!drafts.size) return true;
		const error = draftError();
		if (error) { ctx.ui.notify(error, "warning"); return false; }
		let saved = false;
		await mutateProvider(ctx, providerId, (provider) => {
			for (const [id, draft] of drafts) {
				const current = findModel(provider, id);
				if (!current) { ctx.ui.notify(`"${id}" was removed while editing. Discard its draft before saving.`, "warning"); return false; }
				const latest = modelObject(current);
				if (changedKeys(draft).some((key) => !same(latest[key], draft.base[key]) && !same(latest[key], draft.value[key]))) {
					ctx.ui.notify(`"${id}" changed outside this editor. Nothing saved; discard drafts and review the latest values.`, "warning");
					return false;
				}
				if (draft.value.contextWindow && draft.value.maxTokens && draft.value.maxTokens > draft.value.contextWindow) {
					ctx.ui.notify(`"${id}": max output cannot exceed the context window.`, "warning"); return false;
				}
			}
			for (const [id, draft] of drafts) {
				const index = provider.models.findIndex((model: any) => modelIdOf(model) === id);
				const target = modelObject(provider.models[index]);
				const keys = changedKeys(draft);
				for (const key of keys) {
					if (draft.value[key] === undefined) delete target[key];
					else target[key] = key === "cost" ? mergedCost(draft.value.cost) : draft.value[key];
				}
				markModelEdits(target, [
					...(keys.includes("cost") ? ["cost" as const] : []),
					...(keys.includes("reasoning") || keys.includes("thinkingLevelMap") ? ["reasoning" as const] : []),
				]);
				provider.models[index] = target;
			}
			saved = true;
			return true;
		}).then((written) => { saved = saved && written; });
		if (saved) { drafts.clear(); ctx.ui.notify("Model changes saved.", "info"); }
		return saved;
	};
	const settle = async (): Promise<boolean> => {
		if (!drafts.size) return true;
		const choice = await selectOne(ctx, `${drafts.size} model draft(s) not saved`, [
			{ value: "save", label: "Save changes and continue", description: "Write edited fields to the provider configuration" },
			{ value: "discard", label: "Discard changes and continue", description: "Restore stored values; no configuration will be written" },
			{ value: "cancel", label: "Keep editing", description: "Return to the workspace with drafts intact" },
		]);
		if (choice === "save") return save();
		if (choice === "discard") { drafts.clear(); return true; }
		return false;
	};
	while (true) {
		let provider: any;
		try { provider = loadModelsConfig().providers?.[providerId]; }
		catch (error) { ctx.ui.notify(`Could not read ${STORE_PATH}: ${String(error)}`, "error"); return; }
		if (!provider) return;
		const models: any[] = Array.isArray(provider.models) ? provider.models : [];
		const rows = models.map((raw) => {
			const id = modelIdOf(raw);
			const model = drafts.get(id)?.value ?? raw;
			return { value: id, label: id, description: describeStoredModel(model), tag: drafts.has(id) ? "*" : undefined, details: storedDetails(model, provider, true, drafts.get(id)?.base ?? raw) };
		}).filter((item) => item.value);
		const event = await showWorkbench(ctx, {
			title: `${providerId} · Models`,
			items: rows, state, inspectOnEnter: true,
			status: () => draftError() || (drafts.size ? `${drafts.size} unsaved` : ""),
			onEdit: (row, field, value) => {
				const raw = findModel(provider, row.value);
				const draft = drafts.get(row.value) ?? { base: modelObject(raw), value: modelObject(raw) };
				const error = editDraftValue(draft.value, field.action!, value, draft.base);
				if (error) return error;
				if (changedKeys(draft).length) drafts.set(row.value, draft); else drafts.delete(row.value);
				row.details = storedDetails(draft.value, provider, true, draft.base);
				row.description = describeStoredModel(draft.value);
				row.tag = drafts.has(row.value) ? "*" : undefined;
			},
			actions: () => [
				...(drafts.size ? [{ id: "save", label: "Save", key: Key.ctrl("s"), disabled: !!draftError() }, { id: "discard", label: "Discard" }] : []),
				{ id: "add", label: "Add", key: Key.ctrl("n") },
				{ id: "probe", label: "Discover", key: Key.ctrl("r") },
				{ id: "refresh", label: "Refresh", key: Key.ctrl("u"), disabled: !rows.length },
				{ id: "override", label: "Overrides", key: Key.ctrl("o"), disabled: !rows.length },
				{ id: "settings", label: "Settings", key: Key.ctrl("e") },
				{ id: "remove", label: "Remove", key: Key.ctrl("d"), disabled: !rows.length },
			],
			empty: "No models. Choose Add or Discover.",
		});
		const action = event?.action;
		if (action === "save") { await save(); continue; }
		if (action === "discard") {
			if (drafts.size && await panelConfirm(ctx,"Discard model drafts?", `Discard unsaved edits to ${drafts.size} model(s)?`)) drafts.clear();
			continue;
		}
		if (action === "override" && event?.value) {
			const raw = findModel(provider, event.value);
			const draft = drafts.get(event.value) ?? { base: modelObject(raw), value: modelObject(raw) };
			await editModelOverride(ctx, draft.value);
			if (changedKeys(draft).length) drafts.set(event.value, draft); else drafts.delete(event.value);
			continue;
		}
		if (action === "refresh" && event?.value) {
			if (await refreshModelMetadata(ctx, providerId, event.value)) {
				// Refresh saved metadata without discarding or forcing a save of
				// the user's pending edits. Rebase their changed fields on it.
				const draft = drafts.get(event.value);
				if (draft) {
					const latest = findModel(loadModelsConfig().providers?.[providerId], event.value);
					if (latest) {
						const rebased = { base: modelObject(latest), value: modelObject(latest) };
						for (const key of changedKeys(draft)) {
							if (draft.value[key] === undefined) delete rebased.value[key];
							else rebased.value[key] = draft.value[key];
						}
						if (changedKeys(rebased).length) drafts.set(event.value, rebased); else drafts.delete(event.value);
					}
				}
			}
			continue;
		}
		if (!(await settle())) continue;
		if (!event || action === "back") return;
		if (action === "probe") await reprobeProvider(ctx, providerId);
		else if (action === "add") {
			const added = await addModelsToProvider(ctx, providerId);
			if (added) Object.assign(state, { query: "", value: added, focus: "list", bodyFocus: "list", detail: 0, scroll: 0, action: 0 });
		}
		else if (action === "remove") await deleteModelsFromProvider(ctx, providerId);
		else if (action === "settings") {
			const renamed = await providerSettings(ctx, providerId);
			if (!renamed) return;
			providerId = renamed;
		}
	}
}

export function providerConnectionDetails(providerId: string, provider: any, defaults = provider, showModels = true): DetailSection[] {
	const api = provider.api ?? "openai-completions", defaultApi = defaults.api ?? "openai-completions";
	const role = provider.compat?.supportsDeveloperRole === true, defaultRole = defaults.compat?.supportsDeveloperRole === true;
	return [{ title: "Connection", fields: [
		{ label: "Endpoint", value: provider.baseUrl || "Not set", source: provider.baseUrl === defaults.baseUrl ? "saved" : "custom", action: "endpoint",
			editor: { kind: "text", value: provider.baseUrl ?? "", placeholder: `${defaults.baseUrl || "Required"} · saved (default)` } },
		{ label: "API", value: api, source: api === defaultApi ? "saved" : "custom", action: "api",
			editor: { kind: "choice", value: api, choices: API_OPTIONS.map((option) => ({ value: option.value, label: `${option.label} · ${option.value === defaultApi ? "saved" : "custom"}` })) } },
		{ label: "API key", value: describeApiKey(apiKeyFromProvider(providerId, provider)), action: "apikey",
			editor: { kind: "text", value: "", placeholder: "Keep saved key; - removes it; $ENV_VAR / !command supported" } },
		...(providerStyleOf(provider) === "openai" ? [{ label: "Developer role", value: role ? "On" : "Off", source: role === defaultRole ? "saved" : "custom", action: "devrole",
			editor: { kind: "choice" as const, value: role ? "on" : "off", choices: [false, true].map((on) => ({ value: on ? "on" : "off", label: `${on ? "On" : "Off"} · ${on === defaultRole ? "saved" : "custom"}` })) } }] : []),
		...(showModels ? [{ label: "Models", value: String(Array.isArray(provider.models) ? provider.models.length : 0), action: "models" }] : []),
	] }];
}

// Used by both the initial provider inspector and Settings. No nested input
// prompts; blank text restores its saved default, and secrets are never read back.
export function editProviderConnection(providerId: string, field: string, value: string, defaults: any): string | undefined {
	try {
		const config = loadModelsConfig(), provider = config.providers?.[providerId];
		if (!provider) return "Provider no longer exists.";
		if (field === "apikey") {
			if (!value.trim()) return;
			const key = value.trim() === "-" ? { mode: "none" as const } : parseApiKeyInput(value);
			const serialized = serializeApiKey(key.mode, key.value, providerStyleOf(provider));
			if (serialized) saveProviderApiKey(providerId, serialized);
			return;
		}
		if (field === "endpoint") provider.baseUrl = normalizeEndpoint(value.trim() || defaults.baseUrl || "", provider.api ?? "openai-completions");
		else if (field === "api") {
			if (!API_OPTIONS.some((option) => option.value === value)) return "Choose an API protocol.";
			provider.api = value;
		} else if (field === "devrole") provider.compat = { ...(provider.compat ?? {}), supportsDeveloperRole: value === "on" };
		else return "This field cannot be edited.";
		saveModelsConfig(config);
	} catch (error) { return error instanceof Error ? error.message : String(error); }
}

// Connection settings are a field inspector, not interleaved with model tasks.
async function providerSettings(ctx: CommandContext, providerId: string): Promise<string | null> {
	const state = workbenchState(providerId);
	const defaults = loadModelsConfig().providers?.[providerId];
	while (true) {
		const provider = loadModelsConfig().providers?.[providerId];
		if (!provider) return null;
		const managed = managedProvider(providerId);
		const choice = await showWorkbench(ctx, {
			title: `${providerId} · Settings`, form: true, state,
			subtitle: "Connection changes save immediately.",
			items: [{ value: providerId, label: providerId, details: [
				...providerConnectionDetails(providerId, provider, defaults, false),
				{ title: "Model list", lines: [managed ? `Mirrors models.dev/${managed.modelsDevProviderId} at session start. Catalog sync can replace model metadata.` : "Static model list. Discovery is always reviewed before applying."] },
			] }],
			onEdit: (row, field, value) => {
				const error = editProviderConnection(providerId, field.action!, value, defaults);
				if (error) return error;
				row.details = providerConnectionDetails(providerId, loadModelsConfig().providers?.[providerId], defaults, false);
			},
			actions: [{ id: "back", label: "Back to models" }, ...(providerStyleOf(provider) === "openai" ? [{ id: "detect-role", label: "Detect role" }] : []), { id: "rename", label: "Rename" }, { id: "delete", label: "Delete provider" }],
		});
		if (!choice || choice.action === "back") return providerId;
		if (choice.action === "detect-role") await changeDeveloperRole(ctx, providerId, true);
		else if (choice.action === "rename") { const renamed = await renameProvider(ctx, providerId); if (renamed) providerId = renamed; }
		else if (choice.action === "delete" && await panelConfirm(ctx,"Delete provider?", describeProvider(providerId, provider))) {
			if (await removeProvider(ctx, providerId)) return null;
		}
	}
}

// Replace or remove a provider's stored key. Never shows the current key.
async function changeProviderApiKey(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = apiKeyFromProvider(providerId, provider);
	const input = await panelInput(ctx,
		'API key (blank = keep, "-" = remove)',
		current.mode === "none" ? "paste the key, or $ENV_VAR / !command" : `current: ${describeApiKey(current)}`,
	);
	if (input === undefined || !input.trim()) return;
	const next = input.trim() === "-" ? { mode: "none" as const } : parseApiKeyInput(input);
	// "none" stores the placeholder key, so the provider still loads.
	const serialized = serializeApiKey(next.mode, next.value, providerStyleOf(provider));
	if (!serialized) return;
	try {
		saveProviderApiKey(providerId, serialized);
	} catch (error) {
		ctx.ui.notify(`Could not write the API key: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	ctx.ui.notify(next.mode === "none" ? `Removed the API key of "${providerId}".` : `Updated the API key of "${providerId}".`, "info");
}

// Turn the "developer" role on or off, or ask the endpoint which it takes.
async function changeDeveloperRole(ctx: CommandContext, providerId: string, detectOnly = false) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = provider?.compat?.supportsDeveloperRole === true;
	const choice = detectOnly ? "detect" : await selectOne(ctx, `Developer role for ${providerId}`, [
		{ value: "detect", label: "Detect", description: "Ask the endpoint with one tiny chat completion" },
		{ value: "on", label: "On", suffix: current ? " • current" : undefined, description: 'Send system prompts with the "developer" role' },
		{ value: "off", label: "Off", suffix: current ? undefined : " • current", description: 'Send them with the "system" role — accepted everywhere' },
	]);
	if (!choice) return;

	let value = choice === "on";
	if (choice === "detect") {
		const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
		const ids = (Array.isArray(provider?.models) ? provider.models : []).map(modelIdOf).filter(Boolean);
		if (!baseUrl || ids.length === 0) {
			ctx.ui.notify("Detection needs an endpoint and at least one model.", "warning");
			return;
		}
		const apiKey = apiKeyFromProvider(providerId, provider);
		ctx.ui.notify("Probing developer-role support ...", "info");
		const probed = await probeDeveloperRole(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value), chatModelCandidates(ids));
		if (probed === undefined) {
			ctx.ui.notify("The probe was inconclusive — nothing changed.", "warning");
			return;
		}
		value = probed;
	}
	if (value === current) {
		ctx.ui.notify(`Developer role for "${providerId}" is already ${value ? "on" : "off"}.`, "info");
		return;
	}
	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.compat = { ...(p.compat && typeof p.compat === "object" ? p.compat : {}), supportsDeveloperRole: value };
		return true;
	});
	if (saved) ctx.ui.notify(`Developer role for "${providerId}" is now ${value ? "on" : "off"}.`, "info");
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
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
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
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";

	const input = await panelInput(ctx,"Endpoint", current || "e.g. https://api.example.com/v1");
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
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	config.providers ||= {};
	if (!config.providers[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return null;
	}

	const input = await panelInput(ctx,"Rename provider", `current: ${providerId}`);
	if (input === undefined) return null;
	// Slugify so names stay consistent with the Add flow.
	// Every id lives in our own namespace, so a rename can never collide with a
	// built-in provider. Typing "foo", "custom.foo" or "custom-foo" all land on "custom.foo".
	let newId = ensureCustomId(slugify(input.trim()));
	if (!newId || newId === providerId) return null;

	if (config.providers[newId]) {
		ctx.ui.notify(`Provider "${newId}" already exists. Choose a different name.`, "warning");
		return null;
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
		ctx.ui.notify(`Could not write ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}

	// Carry the stored key over to the new id; best-effort, the rename
	// itself already succeeded.
	try {
		renameProviderApiKey(providerId, newId);
	} catch (error) {
		ctx.ui.notify(`Renamed, but the stored key could not be moved: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	ctx.ui.notify(`Renamed "${providerId}" → "${newId}".`, "info");
	// Keep the models.dev mirror attached to the renamed provider.
	renameManaged(providerId, newId);
	return newId;
}

// Remove several models at once: multi-select over the provider's models,
// confirm, then filter them out of the config.
async function deleteModelsFromProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const modelItems = providerModelItems(provider);
	if (modelItems.length === 0) {
		ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
		return;
	}

	const picked = await pickMany(ctx, `Remove models from ${providerId}`, modelItems, { confirmLabel: "Remove" });
	if (!picked || picked.length === 0) return;

	const removeSet = new Set(picked);
	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.models = (Array.isArray(p.models) ? p.models : []).filter((m: any) => !removeSet.has(modelIdOf(m)));
		return true;
	});
	if (saved) {
		// A mirrored provider must not resurrect models the user deleted.
		suppressModels(providerId, picked);
		ctx.ui.notify(`Deleted ${picked.length} model${picked.length === 1 ? "" : "s"} from "${providerId}".`, "info");
	}
}

// Used by the inline inspector. Invalid input stays beside the field.
function editDraftValue(model: any, field: string, value: string, defaults: any): string | undefined {
	if (field.startsWith("cost.")) {
		const edits: ModelEdits = { cost: {} };
		for (const key of PRICE_KEYS) if (model.cost?.[key] !== undefined && model.cost[key] !== defaults.cost?.[key]) edits.cost![key] = model.cost[key];
		const error = editPriceValue(defaults.cost, edits, field, value);
		if (error) return error;
		const cost = { ...defaults.cost, ...edits.cost };
		if (Object.keys(cost).length) model.cost = cost; else delete model.cost;
		return;
	}
	if (field === "context" || field === "maxtokens") {
		const key = field === "context" ? "contextWindow" : "maxTokens";
		const parsed = value.trim() ? parseTokenInput(value) : defaults[key] ?? 0;
		if (parsed === undefined) return "Use tokens, 128K or 1M; blank restores the default.";
		if (parsed === 0) delete model[key]; else model[key] = parsed;
	} else if (field === "image") {
		const defaultImage = Array.isArray(defaults.input) && defaults.input.includes("image");
		if ((value === "on") === defaultImage) { if (defaults.input === undefined) delete model.input; else model.input = [...defaults.input]; }
		else model.input = value === "on" ? ["text", "image"] : ["text"];
	} else if (field === "reasoning") {
		if (!REASONING_LEVELS.includes(value as ReasoningCeiling)) return "Choose a reasoning level.";
		if (value === readModelOptions(defaults).reasoning) {
			for (const key of ["reasoning", "thinkingLevelMap"]) { if (defaults[key] === undefined) delete model[key]; else model[key] = structuredClone(defaults[key]); }
		} else applyReasoning(model, value as ReasoningCeiling, { xhigh: readCeilingString(model, "xhigh"), max: readCeilingString(model, "max") });
	}
}

// Nested override form is itself a draft. Header values are never echoed.
async function editModelOverride(ctx: CommandContext, model: any) {
	const next = structuredClone(model);
	const state = workbenchState();
	while (true) {
		const event = await showWorkbench(ctx, {
			title: "Model connection overrides", form: true, state,
			items: [{ value: "override", label: model.id, details: [{ title: "Overrides", fields: [
				{ label: "Endpoint", value: next.baseUrl || "Use provider endpoint", action: "base" },
				{ label: "API", value: next.api || "Use provider API", action: "api" },
				{ label: "Headers", value: next.headers ? Object.keys(next.headers).join(", ") : "None", action: "headers" },
			] }] }],
			actions: [{ id: "apply", label: "Use these overrides", key: Key.ctrl("s") }, { id: "cancel", label: "Cancel" }],
		});
		if (!event || event.action === "cancel") return;
		if (event.action === "apply") {
			for (const key of ["baseUrl", "api", "headers"]) {
				if (next[key] === undefined) delete model[key]; else model[key] = next[key];
			}
			return;
		}
		if (event.action === "base") {
			const value = await panelInput(ctx,'Endpoint override (blank = keep, "-" = inherit)', next.baseUrl || "https://api.example.com/v1");
			if (value?.trim() === "-") delete next.baseUrl;
			else if (value?.trim()) {
				try {
					const url = new URL(value.trim());
					if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an http:// or https:// URL");
					next.baseUrl = value.trim();
				} catch (error) { ctx.ui.notify(`Invalid endpoint: ${String(error)}`, "warning"); }
			}
		} else if (event.action === "api") {
			const value = await selectOne(ctx, "API override", [{ value: "inherit", label: "Use provider API" }, ...API_OPTIONS]);
			if (value === "inherit") delete next.api; else if (value) next.api = value;
		} else if (event.action === "headers") {
			const value = await panelInput(ctx,'Headers JSON (blank = keep, "-" = clear)', 'e.g. {"x-api-version":"2024-01"}; existing values are hidden');
			if (value?.trim() === "-") delete next.headers;
			else if (value?.trim()) {
				try {
					const parsed = JSON.parse(value);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) throw new Error("Expected an object of string header values");
					next.headers = parsed;
				} catch (error) { ctx.ui.notify(`Invalid headers: ${String(error)}`, "warning"); }
			}
		}
	}
}

// Fields where a fresh probe may override the stored config. Only values
// detected from the gateway or the models.dev catalog count as authoritative
// — local-rule guesses, api-fallback and built-in defaults never rewrite an
// existing entry.
function diffStoredModel(model: any, info: ModelProbeInfo): string[] {
	const labels = { contextWindow: "ctx", maxTokens: "out", image: "image", reasoning: "reasoning", cost: "cost", effortOptions: "effort", alwaysThinking: "effort" };
	const format = (field: keyof typeof labels, value: unknown): string => {
		if (value === undefined) return "unset";
		if (typeof value === "boolean") return value ? "on" : "off";
		if (typeof value === "number") return formatTokens(value);
		if (field === "cost" && Array.isArray(value)) return formatCost({ input: value[0], output: value[1] });
		return String(value);
	};
	return modelMetadataChanges(model, info).map(({ field, before, after }) => {
		const left = format(field, before), right = format(field, after);
		if (left !== right) return `${labels[field]} ${left}→${right}`;
		if (typeof before === "number" && typeof after === "number") return `${labels[field]} ${before}→${after}`;
		return `${labels[field]} ${right} updated`;
	});
}

// One-line summary of a stored entry's current config, for the re-probe list.
const storedModelSummary = describeStoredModel;

async function reprobeProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
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

	const apiKey = apiKeyFromProvider(providerId, provider);
	let probed;
	try {
		probed = await fetchModelMetadata([], {
			baseUrl, api, apiKey: resolveApiKeyForProbe(apiKey.mode, apiKey.value),
			ollama: providerStyleOf(provider) === "ollama",
		});
	} catch (error) {
		ctx.ui.notify("Probe failed: " + String(error), "error");
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

	const infoById = probed.infoById;

	// Explicit planned actions replace the old overloaded tri-state checkboxes.
	const novelSet = new Set(novelIds);
	const changeById = new Map<string, string[]>();
	for (const id of overlapIds) {
		const info = infoById.get(id);
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		if (!info || !stored) continue;
		const changes = diffStoredModel(stored, info);
		if (changes.length > 0) changeById.set(id, changes);
	}

	const items: ReviewItem[] = [];
	for (const [id, changes] of changeById) {
		const stored = storedModels.find((model) => modelIdOf(model) === id);
		const info = infoById.get(id)!;
		items.push({
			value: id, label: id, kind: "changed", operations: ["keep", "update", "remove"], initial: "keep", info, current: stored,
			description: changes.join(" · "), searchText: `${id} updated changed`,
		});
	}
	for (const id of novelIds) items.push({
		value: id, label: id, kind: "new", operations: ["skip", "add"], initial: "skip", info: infoById.get(id),
		description: describeInfo(infoById.get(id)), details: probeDetails(infoById.get(id)), searchText: `${id} new`,
	});
	for (const id of unsupportedIds) {
		const stored = storedModels.find((model) => modelIdOf(model) === id);
		items.push({
			value: id, label: id, kind: "missing", operations: ["keep", "remove"], initial: "keep",
			description: "Not returned by this discovery. Kept unless you explicitly remove it.", searchText: `${id} missing not returned`,
			details: [{ title: "Not returned ≠ unsupported", lines: ["A filtered or incomplete model list does not prove this model is unavailable. Keeping it is safe."] }, ...storedDetails(stored, provider)],
		});
	}
	for (const id of storedIds) {
		if (changeById.has(id) || !probedSet.has(id)) continue;
		const stored = storedModels.find((model) => modelIdOf(model) === id);
		items.push({ value: id, label: id, kind: "same", operations: ["keep", "remove"], initial: "keep", info: infoById.get(id), current: stored, description: storedModelSummary(stored) || "No changes", details: storedDetails(stored, provider) });
	}

	const picked = await reviewChanges(ctx, `Discover / ${providerId}`, items);
	if (picked === null) return;

	const addIds: string[] = [];
	const removeIds: string[] = [];
	const updateIds: string[] = [];
	for (const item of items) {
		const action = picked.decisions.get(item.value);
		if (novelSet.has(item.value)) { if (action === "add") addIds.push(item.value); }
		else if (action === "remove") removeIds.push(item.value);
		else if (action === "update") updateIds.push(item.value);
	}

	// Apply the reviewed plan in a single configuration write.
	const removeSet = new Set(removeIds);
	const saved = await mutateProvider(ctx, providerId, (current) => {
		const models: any[] = (Array.isArray(current.models) ? current.models : []).filter((model: any) => !removeSet.has(modelIdOf(model)));
		for (const id of updateIds) {
			const index = models.findIndex((model) => modelIdOf(model) === id);
			if (index < 0) continue;
			models[index] = modelObject(models[index]);
			const info = infoById.get(id)!;
			applyModelMetadata(models[index], info);
			applyModelEdits(models[index], picked.edits.get(id) ?? {});
		}
		const existing = new Set(models.map(modelIdOf));
		for (const id of addIds) {
			if (!existing.has(id)) models.push(buildModelEntry(id, editedModelOptions(editorDefaults(infoById.get(id)!), picked.edits.get(id) ?? {})));
		}
		current.models = models;
		return addIds.length + updateIds.length + removeIds.length > 0;
	});
	if (saved) {
		if (removeIds.length) suppressModels(providerId, removeIds);
		ctx.ui.notify(`Discovery applied: ${addIds.length} added, ${updateIds.length} updated, ${removeIds.length} removed.`, "info");
	}
}

// One-click refresh: catalog mirrors use their configured table, exactly as
// background sync does. Other endpoints use detected metadata, then the
// catalog's automatic endpoint/normalized-ID lookup. No source/site picker.
async function refreshModelMetadata(ctx: CommandContext, providerId: string, modelId: string): Promise<boolean> {
	try {
		const provider = loadModelsConfig().providers?.[providerId];
		const stored = findModel(provider, modelId);
		if (!provider || !stored) {
			ctx.ui.notify(`Model "${modelId}" no longer exists.`, "warning");
			return false;
		}
		ctx.ui.notify(`Refreshing metadata for "${modelId}" ...`, "info");
		const api = stored?.api ?? provider.api ?? "openai-completions";
		const key = apiKeyFromProvider(providerId, provider);
		const batch = await fetchModelMetadata([modelId], {
			baseUrl: stored?.baseUrl ?? provider.baseUrl,
			api, apiKey: resolveApiKeyForProbe(key.mode, key.value),
			ollama: providerStyleOf({ ...provider, api }) === "ollama",
			catalogProviderId: managedProvider(providerId)?.modelsDevProviderId,
			requireLiveCatalog: true,
		});
		const info = batch.infoById.get(modelId);
		if (!info) {
			ctx.ui.notify(`No metadata found for "${modelId}".`, "warning");
			return false;
		}
		const resolved = info;
		let checked = false, changeCount = 0;
		const saved = await mutateProvider(ctx, providerId, (current) => {
			const models = Array.isArray(current.models) ? current.models : [];
			const index = models.findIndex((model: any) => modelIdOf(model) === modelId);
			if (index < 0) return false;
			checked = true;
			const model = modelObject(models[index]);
			changeCount = applyModelMetadata(model, resolved);
			if (!changeCount) return false;
			models[index] = model;
			return true;
		});
		if (saved) ctx.ui.notify(`"${modelId}": refreshed ${changeCount} metadata field(s).`, "info");
		else if (checked && !changeCount) ctx.ui.notify(`"${modelId}": no metadata changes.`, "info");
		return saved || (checked && !changeCount);
	} catch (error) {
		ctx.ui.notify(`Could not refresh "${modelId}": ${error instanceof Error ? error.message : String(error)}`, "warning");
		return false;
	}
}

async function addModelsToProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const style = providerStyleOf(provider);
	const existingIds = (Array.isArray(provider?.models) ? provider.models : []).map(modelIdOf).filter(Boolean);
	if (!provider) return;
	const key = apiKeyFromProvider(providerId, provider);
	const manual = await promptManualModels(ctx, style, {
		existingIds,
		metadata: {
			baseUrl: provider.baseUrl, api: provider.api, ollama: style === "ollama",
			catalogProviderId: managedProvider(providerId)?.modelsDevProviderId,
			apiKey: resolveApiKeyForProbe(key.mode, key.value),
		},
	});
	if (!manual) return;
	const added = await addModelEntriesToProvider(ctx, providerId, manual.ids, manual.infoById, manual.options);
	return added[0];
}
