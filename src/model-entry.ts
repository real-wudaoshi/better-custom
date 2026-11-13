import { getMetadataProvenance, metadataUpdateFields, savedModelMetadata } from "model-probe";
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
		const key = option.toLowerCase();
		const level = Object.hasOwn(EFFORT_ALIASES, key) ? EFFORT_ALIASES[key] : undefined;
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
		maxTokens: info.maxTokens ?? fallback.maxTokens,
		cost: info.cost ?? fallback.cost,
		metadataProvenance: getMetadataProvenance(info),
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
			const ceiling = ceilingFromThinkingMap(map);
			if (ceiling !== "off") {
				opts.reasoning = ceiling;
				opts.thinkingLevelMap = map;
			}
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
	if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) {
		entry.maxTokens = opts.maxTokens;
	}

	// List prices so pi's usage accounting can estimate cost for custom
	// providers too. Rates are reported by the gateway/catalog or set explicitly
	// by the user. Borrowed catalog rates retain their inferred provenance.
	if (opts.metadataProvenance) entry.metadataProvenance = opts.metadataProvenance;
	if (opts.cost) {
		entry.cost = opts.cost;
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
	// The key is written to our own auth file by persistApiKey, never inline.
	const config: any = {
		baseUrl,
		api,
		models: modelIds.map((id) => {
			// resolveModelInfo layers detected metadata over models.dev, the local
			// rules, the api fallback, and the built-in defaults — including for
			// manually added models, which have no probe info at all.
			const info = infoById?.get(id);
			const override = optionOverrides?.get(id);
			const modelOpts = override
				? {
						...override,
						contextWindow: override.contextWindow ?? info?.contextWindow,
						maxTokens: override.maxTokens ?? info?.maxTokens,
					}
				: modelOptionsFromProbe(info, opts);
			return buildModelEntry(id, modelOpts, ceilingOverrides);
		}),
	};

	if (style === "ollama") {
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

export function storedMetadata(raw: any): ModelProbeInfo {
	const model = typeof raw === "string" ? { id: raw } : raw ?? {};
	const map = model.thinkingLevelMap;
	const provenance = model.metadataProvenance;
	const savedLevels = model.reasoning === true && map && typeof map === "object" && provenance?.alwaysThinking === undefined
		? PI_THINKING_LEVELS.flatMap((level) => map[level] === null || ((level === "max" || level === "xhigh") && map[level] === undefined)
			? [] : [typeof map[level] === "string" ? map[level] : level === "off" ? "none" : level])
		: undefined;
	return savedModelMetadata({
		contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost,
		image: Array.isArray(model.input) ? model.input.includes("image") : undefined,
		reasoning: typeof model.reasoning === "boolean" ? model.reasoning : provenance?.reasoning ? false : undefined,
		alwaysThinking: model.reasoning === true && map?.off === null && (provenance?.alwaysThinking || !savedLevels?.length) ? true : undefined,
		effortOptions: savedLevels?.length ? savedLevels : undefined,
	}, provenance);
}

type ModelMetadataChange = { field: "contextWindow" | "maxTokens" | "image" | "cost" | "reasoning" | "effortOptions" | "alwaysThinking"; before: unknown; after: unknown };

function syncModelMetadata(entry: any, info: ModelProbeInfo, apply: boolean): ModelMetadataChange[] {
	const saved = storedMetadata(entry);
	const fields = new Set(metadataUpdateFields(info, saved));
	const provenance = getMetadataProvenance(info), previous = getMetadataProvenance(saved);
	const changes: ModelMetadataChange[] = [];
	const record = (field: ModelMetadataChange["field"], before: unknown, after: unknown, write: () => void, representationChanged = false) => {
		const verified = previous[field]?.infer && !provenance[field]?.infer;
		if (JSON.stringify(before) === JSON.stringify(after) && !representationChanged && !verified) return;
		changes.push({ field, before, after });
		if (apply) {
			write();
			(entry.metadataProvenance ??= {})[field] = provenance[field];
		}
	};
	for (const field of ["contextWindow", "maxTokens", "image", "cost"] as const) {
		if (!fields.has(field)) continue;
		const before = field === "cost" && saved.cost ? [saved.cost.input, saved.cost.output, saved.cost.cacheRead ?? 0, saved.cost.cacheWrite ?? 0] : saved[field];
		const after = field === "cost" && info.cost ? [info.cost.input, info.cost.output, info.cost.cacheRead, info.cost.cacheWrite] : info[field];
		record(field, before, after, () => {
			if (field === "image") entry.input = info.image ? ["text", "image"] : ["text"];
			else entry[field] = info[field];
		});
	}

	const updateReasoning = fields.has("reasoning");
	const reasoning = updateReasoning ? info.reasoning : saved.reasoning;
	const levelField = fields.has("alwaysThinking") && info.alwaysThinking ? "alwaysThinking"
		: fields.has("effortOptions") ? "effortOptions" : undefined;
	if (updateReasoning) {
		record("reasoning", saved.reasoning, reasoning, () => {
			if (reasoning) {
				if (saved.reasoning !== true) applyReasoning(entry, "xhigh");
			} else {
				applyReasoning(entry, "off");
				delete entry.metadataProvenance?.effortOptions;
				delete entry.metadataProvenance?.alwaysThinking;
			}
		});
	}
	if (levelField && reasoning !== false) {
		const options = modelOptionsFromProbe({
			reasoning: true,
			effortOptions: levelField === "effortOptions" ? info.effortOptions : undefined,
			alwaysThinking: levelField === "alwaysThinking",
		}, { reasoning: "xhigh", image: false });
		const map = options.thinkingLevelMap;
		if (map) {
			const oldMap = entry.thinkingLevelMap;
			const before = saved.alwaysThinking ? "always on" : saved.effortOptions?.join("/") ?? (oldMap ? readModelOptions(entry).reasoning : undefined);
			const after = levelField === "alwaysThinking" ? "always on" : info.effortOptions?.join("/");
			record(levelField, before, after, () => {
				entry.reasoning = true;
				entry.thinkingLevelMap = map;
				delete entry.metadataProvenance?.[levelField === "alwaysThinking" ? "effortOptions" : "alwaysThinking"];
			}, JSON.stringify(oldMap) !== JSON.stringify(map));
		}
	}
	return changes;
}

export function modelMetadataChanges(raw: any, info: ModelProbeInfo): ModelMetadataChange[] {
	return syncModelMetadata(typeof raw === "string" ? { id: raw } : raw ?? {}, info, false);
}

export function applyModelMetadata(entry: any, info: ModelProbeInfo): number {
	return syncModelMetadata(entry, info, true).length;
}

export function modelIdOf(model: any): string {
	return typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
}

export function findModel(provider: any, id: string): any {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models.find((m: any) => modelIdOf(m) === id);
}
