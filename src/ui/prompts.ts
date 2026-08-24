import { BUILTIN_PROVIDER_IDS, loadModelsConfig } from "../config.ts";
import { describeProbeInfo, resolveModelInfo } from "model-probe";
import { REASONING_LEVELS } from "../types.ts";
import type { ApiKeyMode, CommandContext, ModelOptions, ProviderApi, ProviderStyle, ReasoningCeiling, SelectItem } from "../types.ts";
import { normalizeEndpoint, slugify, suggestProviderId } from "../url.ts";
import { selectOne } from "./select.ts";

export async function promptApiKey(
	ctx: CommandContext,
): Promise<{ mode: ApiKeyMode; value?: string } | null> {
	const choice = await selectOne(ctx, "API key", [
		{ value: "literal", label: "API key", description: "Stored verbatim in the active models config" },
		{ value: "none", label: "None", description: "No key; a placeholder is written so the provider still loads" },
	]);
	if (!choice) return null;
	if (choice === "none") return { mode: "none" };

	const value = await ctx.ui.input("API key", "saved directly in the active models config");
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return { mode: "none" };
	return { mode: "literal", value: trimmed };
}

function reasoningLabel(level: ReasoningCeiling): string {
	if (level === "off") return "Off - no reasoning";
	if (level === "xhigh") return "xhigh - maximum (only if the model supports it)";
	if (level === "max") return "max - maximum (only if the model supports it)";
	return `${level} - cap reasoning at ${level}`;
}

// Prompts for a reasoning ceiling. Returns null if cancelled.
export async function promptReasoning(ctx: CommandContext, current?: ReasoningCeiling): Promise<ReasoningCeiling | null> {
	const items: SelectItem[] = REASONING_LEVELS.map((level) => ({
		value: level,
		label: reasoningLabel(level),
	}));
	const initialIndex = current ? REASONING_LEVELS.indexOf(current) : 0;
	const choice = await selectOne(ctx, "Reasoning", items, { initialIndex: Math.max(0, initialIndex) });
	return (choice as ReasoningCeiling | null) ?? null;
}

// When a model is capped at xhigh or max, some providers name that level
// differently (e.g. "max"). Offer an optional override for the provider-facing string.
export async function promptCeilingProviderString(ctx: CommandContext, level: "xhigh" | "max", current?: string): Promise<string | undefined> {
	const value = await ctx.ui.input(
		`${level} provider value (blank = ${level})`,
		current && current !== level ? `current: ${current}` : `e.g. max (leave blank to send "${level}")`,
	);
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

export async function promptImage(ctx: CommandContext, current?: boolean): Promise<boolean | null> {
	const choice = await selectOne(ctx, "Image input", [
		{ value: "yes", label: "Yes - send text + images", description: "Sets input: [text, image]" },
		{ value: "no", label: "No - text only", description: "Sets input: [text]" },
	], { initialIndex: current === false ? 1 : 0 });
	if (!choice) return null;
	return choice === "yes";
}

// Prompts for a context window size in tokens. Returns:
//   number  -> set/replace contextWindow
//   0       -> clear contextWindow (user typed 0)
//   null    -> cancelled, leave unchanged
export async function promptContextWindow(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Context window (tokens)",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 128000 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed.replace(/[_,]/g, ""), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// Prompts for max output tokens. Same return contract as promptContextWindow:
// number to set, 0 to clear, null to leave unchanged.
export async function promptMaxTokens(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Max output tokens",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 8192 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed.replace(/[_,]/g, ""), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// After manual id entry: offer per-model metadata customization. Each model
// shows its resolved metadata (local rules + defaults — manual ids have no
// probe data); choosing "Set metadata manually" walks reasoning / image /
// context window with the resolved values as starting points. Returns a map
// of id -> ModelOptions for customized models only; null on cancel (callers
// treat that as "no overrides").
export async function promptManualModelOptions(
	ctx: CommandContext,
	ids: string[],
): Promise<Map<string, ModelOptions> | null> {
	const overrides = new Map<string, ModelOptions>();
	for (const id of ids) {
		const resolved = resolveModelInfo(id);
		const choice = await selectOne(ctx, `Metadata for ${id}`, [
			{ value: "auto", label: "Use resolved metadata", description: describeProbeInfo(resolved) || "no known metadata — defaults (text-only, reasoning on)" },
			{ value: "custom", label: "Set metadata manually", description: "Choose reasoning, image input, and context window" },
		]);
		if (choice === null) return null;
		if (choice !== "custom") continue;

		const reasoning = await promptReasoning(ctx, resolved.reasoning === false ? "off" : "xhigh");
		if (reasoning === null) return null;
		const image = await promptImage(ctx, resolved.image ?? false);
		if (image === null) return null;
		const contextWindow = await promptContextWindow(ctx, resolved.contextWindow);
		if (contextWindow === null) return null;
		overrides.set(id, { reasoning, image, contextWindow: contextWindow > 0 ? contextWindow : undefined });
	}
	return overrides;
}

export async function promptModelIdsOneByOne(
	ctx: CommandContext,
	style: ProviderStyle,
): Promise<string[] | null> {
	const modelIds: string[] = [];
	const firstPlaceholder =
		style === "anthropic"
			? "e.g. claude-sonnet-4-5 (blank to finish)"
			: style === "ollama"
				? "e.g. llama3.1:8b or qwen2.5-coder:7b (blank to finish)"
				: style === "gemini"
					? "e.g. gemini-2.5-pro (blank to finish)"
					: "e.g. gpt-4o-mini or qwen/qwen3-coder (blank to finish)";
	const nextPlaceholder =
		style === "anthropic"
			? "another Anthropic-style model id (blank to finish)"
			: style === "ollama"
				? "another Ollama model id (blank to finish)"
				: style === "gemini"
					? "another Gemini model id (blank to finish)"
					: "another OpenAI-style model id (blank to finish)";

	while (true) {
		const value = await ctx.ui.input(modelIds.length === 0 ? "Model id" : "Add another model id", modelIds.length === 0 ? firstPlaceholder : nextPlaceholder);
		if (value === undefined) return null;
		const trimmed = value.trim();
		if (!trimmed) {
			if (modelIds.length === 0) {
				ctx.ui.notify("Add at least one model.", "warning");
				continue;
			}
			return modelIds;
		}
		if (modelIds.includes(trimmed)) {
			ctx.ui.notify(`Model already added: ${trimmed}`, "warning");
			continue;
		}
		modelIds.push(trimmed);
	}
}

export async function promptProviderStyle(
	ctx: CommandContext,
): Promise<{ style: ProviderStyle; api: ProviderApi } | null> {
	const choice = await selectOne(ctx, "Provider style", [
		{ value: "openai", label: "OpenAI-compatible (Chat Completions)", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
		{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
		{ value: "anthropic", label: "Anthropic-compatible", description: 'api: "anthropic-messages"' },
		{ value: "gemini", label: "Gemini (Google generative AI)", description: 'api: "google-generative-ai" — native Gemini format, baseUrl includes /v1beta' },
		{ value: "ollama", label: "Ollama-compatible", description: 'api: "openai-completions" with Ollama-specific compat defaults' },
	]);
	if (!choice) return null;

	const style = choice as ProviderStyle;
	const api: ProviderApi =
		style === "anthropic"
			? "anthropic-messages"
			: style === "openai-responses"
				? "openai-responses"
				: style === "gemini"
					? "google-generative-ai"
					: "openai-completions";
	return { style, api };
}

export async function promptEndpoint(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
): Promise<{ normalized: string; raw: string } | null> {
	const endpointInput = await ctx.ui.input(
		"Endpoint",
		style === "anthropic"
			? "e.g. https://api.anthropic-proxy.com/v1"
			: style === "ollama"
				? "e.g. http://localhost:11434/v1"
				: style === "gemini"
					? "e.g. https://generativelanguage.googleapis.com/v1beta"
					: style === "openai-responses"
						? "e.g. https://api.openai.com/v1"
						: "e.g. https://api.example.com/v1 or http://localhost:11434/v1",
	);
	if (endpointInput === undefined) return null;
	const raw = endpointInput.trim();
	if (!raw) {
		ctx.ui.notify("Endpoint is required.", "error");
		return null;
	}

	try {
		return { normalized: normalizeEndpoint(raw, api), raw };
	} catch (error) {
		ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}

export async function promptProviderId(ctx: CommandContext, normalizedEndpoint: string, suggestion?: string): Promise<string | null> {
	let existingIds = new Set<string>();
	try {
		existingIds = new Set(Object.keys(loadModelsConfig().providers ?? {}));
	} catch {
		// If config can't be read, persistProvider surfaces the error later.
	}

	const providerIdSuggestion = suggestion ?? suggestProviderId(normalizedEndpoint);
	const suggestionTaken = existingIds.has(providerIdSuggestion);

	while (true) {
		const providerNameInput = await ctx.ui.input(
			suggestionTaken ? "Provider name (must be unique)" : `Provider name (blank = ${providerIdSuggestion})`,
			"e.g. custom-example-com",
		);
		if (providerNameInput === undefined) return null;
		const providerId = slugify(providerNameInput.trim() || providerIdSuggestion);
		if (!providerId) {
			ctx.ui.notify("Provider name is required.", "error");
			continue;
		}

		// Provider names must be unique — never silently overwrite an existing one.
		if (existingIds.has(providerId)) {
			ctx.ui.notify(`Provider "${providerId}" already exists. Choose a different name.`, "warning");
			continue;
		}

		if (BUILTIN_PROVIDER_IDS.has(providerId)) {
			const ok = await ctx.ui.confirm(
				"Override built-in provider?",
				`"${providerId}" matches a built-in provider id. Saving this will override that provider in the active models config. Continue?`,
			);
			if (!ok) continue;
		}
		return providerId;
	}
}
