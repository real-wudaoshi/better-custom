import { execSync } from "node:child_process";
import { storedApiKey } from "./config.ts";
import type { ApiKeyMode, ProviderStyle } from "./types.ts";

export function resolveApiKeyForProbe(mode: ApiKeyMode, storedValue?: string): string | undefined {
	if (!storedValue || mode === "none") return undefined;
	if (mode === "literal") return storedValue;
	if (mode === "env") return process.env[storedValue]?.trim() || undefined;
	if (mode === "shell") {
		try {
			return execSync(storedValue, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function serializeApiKey(mode: ApiKeyMode, value?: string, style?: ProviderStyle): string | undefined {
	if (mode === "none") return style === "ollama" ? "ollama" : "dummy";
	if (!value) return undefined;
	// pi resolves an apiKey by prefix: "!cmd" runs a shell command, "$VAR" reads an
	// env var, anything else is a literal. See pi-ai resolve-config-value.
	if (mode === "shell") return value.startsWith("!") ? value : `!${value}`;
	if (mode === "env") return value.startsWith("$") ? value : `$${value}`;
	return value;
}

// What the user typed at an "API key" prompt: a literal key, or a reference —
// "$VAR" reads an environment variable, "!cmd" runs a shell command. Blank
// means no key.
export function parseApiKeyInput(input: string): { mode: ApiKeyMode; value?: string } {
	const trimmed = input.trim();
	if (!trimmed) return { mode: "none" };
	if (trimmed.startsWith("!") && trimmed.length > 1) return { mode: "shell", value: trimmed.slice(1).trim() };
	if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { mode: "env", value: trimmed.slice(1) };
	return { mode: "literal", value: trimmed };
}

// A key for display: references in full, a literal key by its last characters only.
export function describeApiKey(key: { mode: ApiKeyMode; value?: string }): string {
	if (key.mode === "none" || !key.value) return "none";
	if (key.mode === "env") return `$${key.value}`;
	if (key.mode === "shell") return `!${key.value}`;
	return key.value.length > 8 ? `…${key.value.slice(-4)}` : "set";
}

// Resolve a stored provider's key reference back into mode+value so we can
// reuse it for probing. Reads the stored key first (custom-providers-auth.json), falling
// back to a legacy inline apiKey in the models config. Anything other than
// $VAR or !cmd is treated as literal.
export function apiKeyFromProvider(providerId: string, provider: any): { mode: ApiKeyMode; value?: string } {
	const raw = storedApiKey(providerId, provider) ?? "";
	if (!raw || raw === "dummy" || raw === "ollama") return { mode: "none" };
	if (raw.startsWith("!")) return { mode: "shell", value: raw.slice(1) };
	if (raw.startsWith("$")) return { mode: "env", value: raw.slice(1) };
	return { mode: "literal", value: raw };
}
