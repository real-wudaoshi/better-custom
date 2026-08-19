import type { ModelProbeInfo } from "./types.ts";

// Merge list-level metadata with per-model detail fetches. Best effort — when a
// server exposes nothing, the wizard falls back to its defaults per model.
// Conservative context-window fallback for well-known model ids. Used when a
// gateway exposes no metadata at all (stock One API / New API, bare proxies)
// Built-in local rules that classify well-known model ids and preset their
// context window, max output tokens, vision, and reasoning support. Used when
// a gateway exposes no metadata (stock One API / New API, bare proxies,
// manually added models). Values are conservative/stable; unknown ids are left
// unset. Entry order matters — more specific patterns (e.g. claude-sonnet-4-5)
// must come before their prefix (claude-sonnet-4).
type KnownModelRule = {
	pattern: RegExp;
	contextWindow: number;
	vision?: boolean;
	reasoning?: boolean;
};

const KNOWN_MODEL_RULES: KnownModelRule[] = [
	// ===== OpenAI =====
	{ pattern: /^gpt-5-mini/i, contextWindow: 128000, vision: true, reasoning: true },
	{ pattern: /^gpt-5-nano/i, contextWindow: 128000, reasoning: true },
	{ pattern: /^gpt-5/i, contextWindow: 272000, vision: true, reasoning: true },
	{ pattern: /^gpt-4\.1/i, contextWindow: 1047576, vision: true },
	{ pattern: /^gpt-4o-mini/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4o/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4-turbo/i, contextWindow: 128000, vision: true },
	{ pattern: /^gpt-4-32k/i, contextWindow: 32768 },
	{ pattern: /^gpt-4/i, contextWindow: 8192 },
	{ pattern: /^gpt-3\.5-turbo/i, contextWindow: 16385 },
	{ pattern: /^o4-mini/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^o4/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^o3-mini/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^o3/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^o1-preview/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^o1-mini/i, contextWindow: 128000, reasoning: true },
	{ pattern: /^o1/i, contextWindow: 200000, reasoning: true },
	{ pattern: /^gpt-oss/i, contextWindow: 128000, vision: true, reasoning: true },
	// ===== Anthropic =====
	{ pattern: /^claude-(opus|sonnet|haiku)-4-6/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^claude-(opus|sonnet|haiku)-4-5/i, contextWindow: 1000000, vision: true, reasoning: true },
	{ pattern: /^claude-(opus|sonnet|haiku)-4/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^claude-3-7-sonnet/i, contextWindow: 200000, vision: true, reasoning: true },
	{ pattern: /^claude-3-5-sonnet/i, contextWindow: 200000, vision: true },
	{ pattern: /^claude-3-5-haiku/i, contextWindow: 200000, vision: true },
	{ pattern: /^claude-3/i, contextWindow: 200000, vision: true },
	// ===== DeepSeek =====
	{ pattern: /^deepseek-v4/i, contextWindow: 1000000, vision: false, reasoning: true },
	{ pattern: /^deepseek-(chat|reasoner|v3|r1)/i, contextWindow: 128000, vision: false, reasoning: true },
	{ pattern: /^deepseek-coder/i, contextWindow: 16384 },
	// ===== Qwen =====
	{ pattern: /^qwen[0-9.]*-non-thinking/i, contextWindow: 262144, reasoning: false },
	{ pattern: /^qwen[^ ]*(thinking|reasoner)/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^qwen2\.5-turbo/i, contextWindow: 1000000 },
	{ pattern: /^qwen[^ ]*-vl/i, contextWindow: 131072, vision: true },
	{ pattern: /^qwen-long/i, contextWindow: 10000000 },
	{ pattern: /^qwen-max/i, contextWindow: 131072 },
	{ pattern: /^qwen-plus/i, contextWindow: 131072 },
	{ pattern: /^qwen-turbo/i, contextWindow: 131072 },
	{ pattern: /^qwen2\.5-coder/i, contextWindow: 131072 },
	{ pattern: /^qwen2\.5/i, contextWindow: 131072 },
	{ pattern: /^qwen2/i, contextWindow: 32768 },
	{ pattern: /^qwen3-coder/i, contextWindow: 131072, reasoning: true },
	{ pattern: /^qwen3\.(5|6|8)/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^qwen-chat/i, contextWindow: 262000 },
	{ pattern: /^qwen3/i, contextWindow: 131072, reasoning: true },
	{ pattern: /^qwen1\.5/i, contextWindow: 32768 },
	{ pattern: /^qwen/i, contextWindow: 131072 },
	// ===== Kimi (Moonshot) =====
	{ pattern: /^k3$/i, contextWindow: 1000000, reasoning: true },
	{ pattern: /^moonshotai\/kimi-k2/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^kimi-k2/i, contextWindow: 262144, reasoning: true },
	{ pattern: /^kimi-k1\.5/i, contextWindow: 131072, reasoning: true },
	{ pattern: /^moonshot-v1-128k/i, contextWindow: 131072 },
	{ pattern: /^moonshot-v1-32k/i, contextWindow: 32768 },
	{ pattern: /^moonshot-v1-8k/i, contextWindow: 8192 },
	{ pattern: /^moonshot-v1/i, contextWindow: 131072 },
	{ pattern: /^kimi-latest/i, contextWindow: 131072 },
	{ pattern: /^kimi/i, contextWindow: 131072 },
	// ===== GLM (Zhipu) =====
	{ pattern: /^glm-5/i, contextWindow: 128000, reasoning: true },
	{ pattern: /^glm-z1/i, contextWindow: 128000, reasoning: true },
	{ pattern: /^glm-4\.5/i, contextWindow: 128000, reasoning: true },
	{ pattern: /^glm-4v/i, contextWindow: 8192, vision: true },
	{ pattern: /^glm-4-long/i, contextWindow: 1024000 },
	{ pattern: /^glm-4/i, contextWindow: 128000 },
	{ pattern: /^glm/i, contextWindow: 128000 },
	// ===== Google / Meta / Mistral =====
	{ pattern: /^gemini-(1\.5|2\.0|2\.5|3)/i, contextWindow: 1000000, vision: true },
	{ pattern: /^llama(3|4)/i, contextWindow: 131072 },
	{ pattern: /^mistral-(large|small|medium)/i, contextWindow: 128000 },
];

// Classify a model id against the local rules and return the preset metadata.
function matchKnownModelRule(modelId: string): ModelProbeInfo | undefined {
	for (const rule of KNOWN_MODEL_RULES) {
		if (rule.pattern.test(modelId)) {
			const info: ModelProbeInfo = { contextWindow: rule.contextWindow };
			if (rule.vision !== undefined) info.vision = rule.vision;
			if (rule.reasoning !== undefined) info.reasoning = rule.reasoning;
			return info;
		}
	}
	return undefined;
}

// Fill any fields the probe couldn't determine from the built-in model rules.
// Real detected values always win; the rules only fill gaps. inferredFields
// records exactly which fields came from the rules.
export function applyKnownModelFallback(modelId: string, info: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	const known = matchKnownModelRule(modelId);
	if (!known) return info;
	const filled: ModelProbeInfo = {};
	const inferredFields: Array<"contextWindow" | "vision" | "reasoning"> = [];
	if (info?.contextWindow === undefined && known.contextWindow !== undefined) {
		filled.contextWindow = known.contextWindow;
		inferredFields.push("contextWindow");
	}
	if (info?.vision === undefined && known.vision !== undefined) {
		filled.vision = known.vision;
		inferredFields.push("vision");
	}
	if (info?.reasoning === undefined && known.reasoning !== undefined) {
		filled.reasoning = known.reasoning;
		inferredFields.push("reasoning");
	}
	if (inferredFields.length === 0) return info;
	return { ...(info ?? {}), ...filled, inferred: true, inferredFields };
}
