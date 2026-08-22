import { fetchModelsDevInfoForBaseUrl, probeDeveloperRole, probeModels } from "model-probe";
import { apiKeyFromProvider, resolveApiKeyForProbe } from "../api-key.ts";
import { BUILTIN_PROVIDER_IDS, loadModelsConfig, MODELS_JSON_PATH, saveModelsConfig } from "../config.ts";
import { applyReasoning, buildModelEntry, findModel, modelIdOf, readCeilingString, readModelOptions } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import type { CommandContext, ModelProbeInfo, ModelsConfig, ProbeResult, ProviderApi, ProviderStyle } from "../types.ts";
import { pickMany, selectOne } from "../ui/select.ts";
import {
	promptCeilingProviderString,
	promptContextWindow,
	promptMaxTokens,
	promptModelIdsOneByOne,
	promptReasoning,
	promptVision,
} from "../ui/prompts.ts";
import { buildProbeUrl, slugify } from "../url.ts";
import {
	addModelEntriesToProvider,
	collectProbedModelInfo,
	describeProvider,
	describeProviderInline,
	fetchGatewayWideInfo,
	mutateModel,
	mutateProvider,
	probePickerItems,
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
			{ value: "probe", label: "Re-probe for new models", description: "Query /models again and add ones not already configured" },
			{ value: "context", label: "Set context window (all models)", description: `Apply one contextWindow to all ${modelCount} model${modelCount === 1 ? "" : "s"}` },
			{ value: "models", label: "Edit per model", description: `${modelCount} model${modelCount === 1 ? "" : "s"} — reasoning, vision, context, max tokens, headers, delete` },
			{ value: "add", label: "Add models manually", description: "Type model ids to add" },
			{ value: "api", label: "API flavor", suffix: ` • ${typeof provider.api === "string" ? provider.api : "unset"}`, description: "Switch between Chat Completions, Responses, Anthropic Messages, and Gemini" },
			{
				value: "devrole",
				label: "Developer role",
				suffix:
					provider.compat?.supportsDeveloperRole === true
						? " • on"
						: provider.compat?.supportsDeveloperRole === false
							? " • off"
							: " • auto",
				description: "Whether the endpoint accepts the OpenAI developer role (probed automatically on add)",
			},
			{ value: "rename", label: "Rename provider", description: "Change the provider name in the models config" },
			{ value: "delete", label: "Delete provider", description: "Remove this provider from the models config" },
			{ value: "back", label: "Back", description: "Return to the provider list" },
		]);
		if (!action || action === "back") return;

		if (action === "models") {
			await editProviderModels(ctx, providerId);
		} else if (action === "probe") {
			await reprobeProvider(ctx, providerId);
		} else if (action === "context") {
			await setProviderContextWindow(ctx, providerId);
		} else if (action === "add") {
			await addModelsToProvider(ctx, providerId);
		} else if (action === "api") {
			await changeProviderApi(ctx, providerId);
		} else if (action === "devrole") {
			await changeProviderDeveloperRole(ctx, providerId);
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

// Set whether pi may send system messages with the OpenAI "developer" role to
// this endpoint. Probed automatically when a provider is added (one tiny chat
// completion); this menu re-runs that probe or sets the flag by hand. pi
// merges the flag over its own auto-detected compat per field.
async function changeProviderDeveloperRole(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const api = typeof provider?.api === "string" ? provider.api : "";
	if (api !== "openai-completions" && api !== "openai-responses") {
		ctx.ui.notify("Developer role only applies to OpenAI-style providers.", "warning");
		return;
	}

	const current: boolean | undefined =
		typeof provider?.compat?.supportsDeveloperRole === "boolean" ? provider.compat.supportsDeveloperRole : undefined;
	const tag = (value: boolean | undefined) => (value === current ? " • current" : undefined);
	const choice = await selectOne(ctx, `Developer role for ${providerId}`, [
		{ value: "probe", label: "Detect from the API", description: "Send a tiny chat completion with a developer message and set the flag from the result" },
		{ value: "on", label: "Supported", suffix: tag(true), description: "pi may send system messages with the developer role" },
		{ value: "off", label: "Not supported", suffix: tag(false), description: "system messages stay system — safe for every endpoint" },
		{ value: "auto", label: "Auto (pi default)", suffix: tag(undefined), description: "Remove the override; pi auto-detects from provider id / baseUrl" },
	]);
	if (!choice) return;

	let value: boolean | undefined;
	if (choice === "probe") {
		const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
		const firstModel = Array.isArray(provider?.models) ? provider.models.map(modelIdOf).find(Boolean) : undefined;
		if (!baseUrl || !firstModel) {
			ctx.ui.notify("Need a baseUrl and at least one model to probe.", "error");
			return;
		}
		const apiKey = apiKeyFromProvider(provider);
		ctx.ui.notify(`Probing developer-role support on ${baseUrl} ...`, "info");
		const probed = await probeDeveloperRole(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value), firstModel);
		if (probed === undefined) {
			ctx.ui.notify("Probe was inconclusive (network, auth, or an unrelated error) — nothing changed.", "warning");
			return;
		}
		value = probed;
	} else {
		value = choice === "on" ? true : choice === "off" ? false : undefined;
	}

	const saved = await mutateProvider(ctx, providerId, (p) => {
		if (value === undefined) {
			if (p.compat && typeof p.compat === "object") {
				delete p.compat.supportsDeveloperRole;
				if (Object.keys(p.compat).length === 0) delete p.compat;
			}
		} else {
			// Merge over existing compat (e.g. keep an Ollama provider's other flags).
			p.compat = { ...(p.compat ?? {}), supportsDeveloperRole: value };
		}
		return true;
	});
	if (saved) {
		ctx.ui.notify(
			`Developer role for "${providerId}" set to ${value === undefined ? "auto" : value ? "supported" : "not supported"}.`,
			"info",
		);
	}
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

// Apply a single contextWindow value to every model in the provider, preserving
// each model's reasoning/vision config. A value of 0 clears it from all models.
async function setProviderContextWindow(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const models = Array.isArray(provider?.models) ? provider.models : [];
	if (models.length === 0) {
		ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
		return;
	}

	// Prefill with the shared value if every model already agrees, else blank.
	const windows = models.map((m: any) => (typeof m?.contextWindow === "number" ? m.contextWindow : undefined));
	const shared = windows.every((w: number | undefined) => w === windows[0]) ? windows[0] : undefined;

	const result = await promptContextWindow(ctx, shared);
	if (result === null) return;

	const saved = await mutateProvider(ctx, providerId, (p) => {
		const list = Array.isArray(p.models) ? p.models : [];
		for (const m of list) {
			const opts = readModelOptions(m);
			opts.contextWindow = result === 0 ? undefined : result;
			const ceilingOverrides: Partial<Record<"xhigh" | "max", string>> = {};
			for (const level of ["xhigh", "max"] as const) {
				const value = readCeilingString(m, level);
				if (value) ceilingOverrides[level] = value;
			}
			const rebuilt = buildModelEntry(
				modelIdOf(m),
				opts,
				Object.keys(ceilingOverrides).length > 0 ? ceilingOverrides : undefined,
			);
			Object.assign(m, rebuilt);
			if (result === 0) delete m.contextWindow;
		}
		return true;
	});
	if (saved) {
		ctx.ui.notify(
			result === 0
				? `Cleared context window on all ${models.length} model${models.length === 1 ? "" : "s"}.`
				: `Set context window ${result} on all ${models.length} model${models.length === 1 ? "" : "s"}.`,
			"info",
		);
	}
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
			{ value: "vision", label: "Vision", suffix: ` • ${opts.vision ? "on" : "off"}`, description: "Toggle image input (text+image vs text-only)" },
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
		} else if (field === "vision") {
			const vision = await promptVision(ctx, opts.vision);
			if (vision === null) continue;
			await mutateModel(ctx, providerId, modelId, (m) => { m.input = vision ? ["text", "image"] : ["text"]; });
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

	const existing = new Set((Array.isArray(provider.models) ? provider.models : []).map(modelIdOf));
	const novelIds = probed.ids.filter((id) => !existing.has(id));
	if (novelIds.length === 0) {
		ctx.ui.notify("No new models — everything the endpoint returned is already configured.", "info");
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

	// Gateway-wide metadata (one call per source) — fetch BEFORE the picker so
	// it shows real detected values instead of local-rule guesses. Re-probe
	// always uses the auto profile.
	const profile = AUTO_PROBE_PROFILE;
	let gatewayWide: Map<string, ModelProbeInfo> | undefined;
	if (style !== "ollama") {
		ctx.ui.notify("Fetching model metadata (context, vision, reasoning) ...", "info");
		gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, profile);
		if (gatewayWide.size > 0) {
			for (const [id, info] of gatewayWide) {
				probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
			}
		}
	}

	// models.dev catalog tier — above the local rules, below detected values.
	const modelsDev = style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(probed.baseUrl) : undefined;

	const picked = await pickMany(ctx, `New models for ${providerId}`, probePickerItems(novelIds, probed.infoById, modelsDev));
	if (!picked || picked.length === 0) return;

	const infoById = await collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, gatewayWide, modelsDev);
	await addModelEntriesToProvider(ctx, providerId, picked, infoById);
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
	const ids = await promptModelIdsOneByOne(ctx, style);
	if (!ids || ids.length === 0) return;
	await addModelEntriesToProvider(ctx, providerId, ids);
}
