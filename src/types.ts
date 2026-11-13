import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MetadataProvenance, ModelCostInfo } from "model-probe";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ProviderStyle = "openai" | "openai-responses" | "anthropic" | "ollama" | "gemini";
export type ApiKeyMode = "env" | "literal" | "shell" | "none";
// pi's reasoning ceilings. "off" means no reasoning; the rest are the levels a
// model is allowed to use. See pi-ai getSupportedThinkingLevels.
export type ReasoningCeiling = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const REASONING_LEVELS: ReasoningCeiling[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Per-model knobs the wizard can write. apiKey lives at provider scope, not here.
export type ModelOptions = {
	metadataProvenance?: import("model-probe").MetadataProvenance;
	reasoning: ReasoningCeiling;
	image: boolean;
	contextWindow?: number;
	maxTokens?: number;
	// USD per 1M tokens from the gateway, a catalog offering or the user.
	cost?: ModelCostInfo;
	// When set, written verbatim instead of deriving a map from the ceiling. Used
	// when model-probe supplied named effort options.
	thinkingLevelMap?: Record<string, string | null>;
};

// Model metadata types come from the model-probe package (probing logic was
// extracted there); re-exported here so the rest of the extension has one
// place to import from.
export type { ModelCostInfo, ModelProbeInfo, ProbeResult } from "model-probe";

export type ModelsConfig = {
	providers?: Record<string, any>;
};

// Structured inspector data, shared by saved models, discovery and change review.
// Sources belong to individual fields, never to a whole mixed-source model.
export type FieldEditor =
	| { kind: "text"; value: string; placeholder?: string }
	| { kind: "choice"; value: string; choices: Array<{ value: string; label: string }> };

export type DetailField = {
	label: string;
	value: string;
	source?: string;
	hint?: string;
	action?: string;
	editor?: FieldEditor;
};

export type DetailSection = {
	title: string;
	fields?: DetailField[];
	lines?: string[];
};

export type SelectItem = {
	value: string;
	label: string;
	suffix?: string;
	description?: string;
	searchText?: string;
	tag?: string;
	details?: DetailSection[];
};

export type ProbeItem = SelectItem;

export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
