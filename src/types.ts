import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type ProviderStyle = "openai" | "openai-responses" | "anthropic" | "ollama";
export type ApiKeyMode = "env" | "literal" | "shell" | "none";
// pi's reasoning ceilings. "off" means no reasoning; the rest are the levels a
// model is allowed to use. See pi-ai getSupportedThinkingLevels.
export type ReasoningCeiling = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const REASONING_LEVELS: ReasoningCeiling[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Per-model knobs the wizard can write. apiKey lives at provider scope, not here.
export type ModelOptions = {
	reasoning: ReasoningCeiling;
	vision: boolean;
	contextWindow?: number;
	// When set, written verbatim instead of deriving a map from the ceiling. Used
	// when a probe learned the provider's exact thinking levels (effort options).
	thinkingLevelMap?: Record<string, string | null>;
};

// Best-effort model metadata detected while probing /models.
export type ModelProbeInfo = {
	contextWindow?: number;
	vision?: boolean;
	reasoning?: boolean;
	alwaysThinking?: boolean; // reasoning exists but cannot be turned off
	effortOptions?: string[]; // provider reasoning-effort names (none/minimal/low/.../max)
	endpointTypes?: string[]; // New API / One API: supported_endpoint_types (chat, embeddings, ...)
	inferred?: boolean; // filled from the built-in model table, not the gateway
	inferredFields?: Array<"contextWindow" | "vision" | "reasoning">; // which fields were inferred
};

export type ProbeResult = {
	items: ProbeItem[];
	infoById: Map<string, ModelProbeInfo>;
	// The base variant that actually answered /models (may differ from the
	// configured baseUrl by a /v1 suffix on quirky gateways).
	baseUrl: string;
};

export type ModelsConfig = {
	providers?: Record<string, any>;
};

export type ProbeItem = {
	value: string;
	label: string;
	description?: string;
};

export type SelectItem = {
	value: string;
	label: string;
	suffix?: string;
	description?: string;
	searchText?: string;
};

export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export const PROBE_CONCURRENCY = 4;
export const PROBE_TIMEOUT_MS = 4000;
