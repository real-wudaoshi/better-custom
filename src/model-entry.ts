import { serializeApiKey } from "./api-key.ts";
import { resolveModelInfo } from "model-probe";
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

// Turn probe metadata into model knobs. model-probe has already resolved each
// field (detected > models.dev > local rules > its own defaults: image off,
// reasoning on); the wizard fallback only supplies the reasoning ceiling for
// thinking models. (model-probe also tracks video input, but pi's model config
// only supports text/image, so it isn't carried into ModelOptions.)
export function modelOptionsFromProbe(info: ModelProbeInfo | undefined, fallback: ModelOptions): ModelOptions {
	if (!info) return fallback;
	const opts: ModelOptions = {
		reasoning: fallback.reasoning,
		image: info.image ?? fallback.image,
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
		// image comes from the probe (default: off). Text-only models have
		// images silently dropped by pi, so this must match reality. pi's
		// input union has no "video", so video never lands here.
		input: opts.image ? ["text", "image"] : ["text"],
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
	developerRole?: boolean,
	// Explicit per-model options from the manual-entry metadata prompts; these
	// win over the resolved probe/rule values (contextWindow falls back to the
	// resolved value when the user left it unset).
	optionOverrides?: Map<string, ModelOptions>,
) {
	const serializedApiKey = serializeApiKey(apiKey.mode, apiKey.value, style);
	const config: any = {
		baseUrl,
		api,
		...(serializedApiKey ? { apiKey: serializedApiKey } : {}),
		models: modelIds.map((id) => {
			// resolveModelInfo layers detected metadata over the local rules and
			// the built-in defaults (image off, reasoning on) — including for
			// manually added models, which have no probe info at all.
			const info = resolveModelInfo(id, infoById?.get(id));
			const override = optionOverrides?.get(id);
			const modelOpts = override
				? { ...override, contextWindow: override.contextWindow ?? info.contextWindow }
				: modelOptionsFromProbe(info, opts);
			return buildModelEntry(id, modelOpts, ceilingOverrides);
		}),
	};

	if (style === "ollama") {
		if (!config.apiKey) config.apiKey = "ollama";
		config.compat = {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	} else if (style === "openai" || style === "openai-responses") {
		// pi-ai auto-detects developer-role support only for a handful of known
		// providers (by id / baseUrl); everyone else gets the probed value.
		// When the probe couldn't tell, default to false — sending "system"
		// instead of "developer" is accepted everywhere, the reverse is not.
		config.compat = { supportsDeveloperRole: developerRole ?? false };
	}

	return config;
}

// Read the reasoning ceiling + image flag already stored on a model entry,
// mirroring pi's getSupportedThinkingLevels so edit defaults match reality.
export function readModelOptions(model: any): ModelOptions {
	const image = Array.isArray(model?.input) ? model.input.includes("image") : true;
	const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
	if (!model || model.reasoning !== true) return { reasoning: "off", image, contextWindow };

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
	return { reasoning: ceiling, image, contextWindow };
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
