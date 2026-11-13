import { normalizeBaseUrl } from "model-probe";
import type { ProviderApi } from "./types.ts";

export function normalizeEndpoint(input: string, _api: ProviderApi): string {
	return normalizeBaseUrl(input);
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-");
}

export function suggestProviderId(endpoint: string): string {
	const url = new URL(normalizeBaseUrl(endpoint));
	const host = url.hostname.replace(/^www\./, "").replace(/^api\./, "");
	// Bare slug — the "custom." marker is added centrally by ensureCustomId.
	return slugify(`${host}${url.port ? `-${url.port}` : ""}`) || "provider";
}

export function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}
