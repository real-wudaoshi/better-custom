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

// Model metadata types come from the model-probe package (probing logic was
// extracted there); re-exported here so the rest of the extension has one
// place to import from.
export type { ModelProbeInfo, ProbeResult } from "model-probe";

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
