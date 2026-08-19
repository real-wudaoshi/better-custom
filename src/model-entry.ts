import { serializeApiKey } from "./api-key.ts";
import { applyKnownModelFallback } from "./known-models.ts";
import { PI_THINKING_LEVELS, REASONING_LEVELS } from "./types.ts";
import type {
	ApiKeyMode,
	ModelOptions,
	ModelProbeInfo,
	ProviderApi,
	ProviderStyle,
	ReasoningCeiling,
} from "./types.ts";

// Provider reasoning-effort option names mapped onto pi thinking levels.
const EFFORT_ALIASES: Record<string, string> = {
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	extended: "xhigh",
};

// Map provider reasoning-effort options onto pi thinking levels. Levels the
// provider doesn't name are hidden with null.
function buildThinkingMapFromEffortOptions(options: string[]): Record<string, string | null> {
	const supported = new Map<string, string>();
	for (const raw of options) {
		const option = raw.trim();
		const level = EFFORT_ALIASES[option.toLowerCase()];
		if (level && !supported.has(level)) supported.set(level, option);
	}
	const map: Record<string, string | null> = {};
	for (const level of PI_THINKING_LEVELS) {
		map[level] = supported.get(level) ?? null;
	}
	return map;
}

function ceilingFromThinkingMap(map: Record<string, string | null>): ReasoningCeiling {
	for (let i = PI_THINKING_LEVELS.length - 1; i >= 1; i--) {
		const level = PI_THINKING_LEVELS[i];
		if (map[level] !== undefined && map[level] !== null) return level as ReasoningCeiling;
	}
	return "off";
}

// Turn probe metadata into model knobs. Fields the probe couldn't determine fall
// back to the wizard's defaults (reasoning on at the xhigh ceiling, text+image).
export function modelOptionsFromProbe(info: ModelProbeInfo | undefined, fallback: ModelOptions): ModelOptions {
	if (!info) return fallback;
	const opts: ModelOptions = {
		reasoning: fallback.reasoning,
		vision: info.vision ?? fallback.vision,
		contextWindow: info.contextWindow ?? fallback.contextWindow,
	};

	if (info.reasoning === false) {
		opts.reasoning = "off";
	} else if (info.reasoning === true) {
		if (info.alwaysThinking) {
			// Thinking exists but cannot be disabled — hide "off" from the UI.
			opts.reasoning = "minimal";
			opts.thinkingLevelMap = { off: null };
		} else if (info.effortOptions && info.effortOptions.length > 0) {
			const map = buildThinkingMapFromEffortOptions(info.effortOptions);
			opts.reasoning = ceilingFromThinkingMap(map);
			opts.thinkingLevelMap = map;
		}
		// reasoning === true with no level info: keep the wizard's default ceiling.
	}
	return opts;
}

// Apply a reasoning ceiling to an entry in place, preserving other fields.
// Mirrors pi's getSupportedThinkingLevels: off/minimal/low/medium/high are on
// by default when reasoning is true; xhigh/max are available ONLY if explicitly
// mapped; any level set to null is removed. So we only need a map to (a) unlock
// xhigh/max, or (b) cap below high by nulling the higher levels.
export function applyReasoning(entry: any, ceiling: ReasoningCeiling, ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>) {
	if (ceiling === "off") {
		delete entry.reasoning;
		delete entry.thinkingLevelMap;
		return;
	}
	entry.reasoning = true;
	const ceilingIndex = REASONING_LEVELS.indexOf(ceiling);
	const map: Record<string, string | null> = {};
	for (const level of REASONING_LEVELS) {
		if (level === "off") continue;
		const index = REASONING_LEVELS.indexOf(level);
		if (level === "xhigh" || level === "max") {
			// Opt-in levels: only appear when the ceiling reaches them.
			if (ceilingIndex >= index) map[level] = ceilingOverrides?.[level]?.trim() || level;
		} else if (index > ceilingIndex) {
			map[level] = null;
		}
	}
	if (Object.keys(map).length > 0) entry.thinkingLevelMap = map;
	else delete entry.thinkingLevelMap;
}

export function buildModelEntry(
	id: string,
	opts: ModelOptions,
	ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>,
): any {
	const entry: any = {
		id,
		// Default to text+image so pi forwards images upstream. Without this,
		// custom models default to text-only and images are silently dropped.
		input: opts.vision ? ["text", "image"] : ["text"],
	};

	if (typeof opts.contextWindow === "number" && opts.contextWindow > 0) {
		entry.contextWindow = opts.contextWindow;
	}

	if (opts.thinkingLevelMap) {
		// The probe knew the provider's exact thinking levels (e.g. OpenAI
		// effort_options) — write that map verbatim instead of deriving one.
		entry.reasoning = true;
		entry.thinkingLevelMap = opts.thinkingLevelMap;
	} else {
		applyReasoning(entry, opts.reasoning, ceilingOverrides);
	}
	return entry;
}

export function buildProviderConfig(
	style: ProviderStyle,
	api: ProviderApi,
	baseUrl: string,
	apiKey: { mode: ApiKeyMode; value?: string },
	modelIds: string[],
	opts: ModelOptions,
	ceilingOverrides?: Partial<Record<"xhigh" | "max", string>>,
	infoById?: Map<string, ModelProbeInfo>,
) {
	const serializedApiKey = serializeApiKey(apiKey.mode, apiKey.value, style);
	const config: any = {
		baseUrl,
		api,
		...(serializedApiKey ? { apiKey: serializedApiKey } : {}),
		models: modelIds.map((id) => {
			// Detected metadata wins; the built-in rules fill any gaps — including
			// for manually added models, which have no probe info at all.
			const info = applyKnownModelFallback(id, infoById?.get(id));
			return buildModelEntry(id, modelOptionsFromProbe(info, opts), ceilingOverrides);
		}),
	};

	if (style === "ollama") {
		if (!config.apiKey) config.apiKey = "ollama";
		config.compat = {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}

	return config;
}

// Read the reasoning ceiling + vision flags already stored on a model entry,
// mirroring pi's getSupportedThinkingLevels so edit defaults match reality.
export function readModelOptions(model: any): ModelOptions {
	const vision = Array.isArray(model?.input) ? model.input.includes("image") : true;
	const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
	if (!model || model.reasoning !== true) return { reasoning: "off", vision, contextWindow };

	const map = model.thinkingLevelMap;
	let ceiling: ReasoningCeiling = "high";
	if (map && typeof map === "object") {
		if (map.max !== undefined && map.max !== null) {
			ceiling = "max";
		} else if (map.xhigh !== undefined && map.xhigh !== null) {
			ceiling = "xhigh";
		} else {
			for (let i = REASONING_LEVELS.length - 1; i >= 1; i--) {
				const level = REASONING_LEVELS[i];
				if (level === "xhigh" || level === "max") continue;
				if (map[level] === null) continue;
				ceiling = level;
				break;
			}
		}
	}
	return { reasoning: ceiling, vision, contextWindow };
}

export function readCeilingString(model: any, level: "xhigh" | "max"): string | undefined {
	const v = model?.thinkingLevelMap?.[level];
	return typeof v === "string" ? v : undefined;
}

export function modelIdOf(model: any): string {
	return typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
}

export function findModel(provider: any, id: string): any {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models.find((m: any) => modelIdOf(m) === id);
}
