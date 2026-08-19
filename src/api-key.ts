import { execSync } from "node:child_process";
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

// Resolve a stored provider's apiKey reference back into mode+value so we can
// reuse it for probing. Anything other than $VAR or !cmd is treated as literal.
export function apiKeyFromProvider(provider: any): { mode: ApiKeyMode; value?: string } {
	const raw = typeof provider?.apiKey === "string" ? provider.apiKey : "";
	if (!raw || raw === "dummy" || raw === "ollama") return { mode: "none" };
	if (raw.startsWith("!")) return { mode: "shell", value: raw.slice(1) };
	if (raw.startsWith("$")) return { mode: "env", value: raw.slice(1) };
	return { mode: "literal", value: raw };
}
