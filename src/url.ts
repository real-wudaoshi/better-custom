import type { ProviderApi } from "./types.ts";

export function hasExplicitScheme(input: string): boolean {
	return /^[a-z]+:\/\//i.test(input.trim());
}

export function addDefaultScheme(input: string): string {
	if (hasExplicitScheme(input)) return input;
	const lower = input.toLowerCase();
	const isLocal =
		lower.startsWith("localhost") ||
		lower.startsWith("127.") ||
		lower.startsWith("0.0.0.0") ||
		lower.startsWith("10.") ||
		lower.startsWith("192.168.") ||
		lower.startsWith("172.16.") ||
		lower.startsWith("172.17.") ||
		lower.startsWith("172.18.") ||
		lower.startsWith("172.19.") ||
		lower.startsWith("172.20.") ||
		lower.startsWith("172.21.") ||
		lower.startsWith("172.22.") ||
		lower.startsWith("172.23.") ||
		lower.startsWith("172.24.") ||
		lower.startsWith("172.25.") ||
		lower.startsWith("172.26.") ||
		lower.startsWith("172.27.") ||
		lower.startsWith("172.28.") ||
		lower.startsWith("172.29.") ||
		lower.startsWith("172.30.") ||
		lower.startsWith("172.31.") ||
		lower.startsWith("[");
	return `${isLocal ? "http" : "https"}://${input}`;
}

function stripSuffix(pathname: string, suffix: string): string {
	return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) || "/" : pathname;
}

export function normalizeEndpoint(input: string, api: ProviderApi): string {
	const url = new URL(addDefaultScheme(input.trim()));
	let pathname = url.pathname.replace(/\/+$/, "") || "/";

	if (api === "openai-completions" || api === "openai-responses") {
		pathname = stripSuffix(pathname, "/chat/completions");
		pathname = stripSuffix(pathname, "/responses");
		pathname = stripSuffix(pathname, "/completions");
		pathname = stripSuffix(pathname, "/models");
	} else {
		pathname = stripSuffix(pathname, "/messages");
	}

	pathname = pathname === "/" ? "" : pathname;
	const port = url.port ? `:${url.port}` : "";
	return `${url.protocol}//${url.hostname}${port}${pathname}`;
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/--+/g, "-");
}

export function suggestProviderId(endpoint: string): string {
	const url = new URL(addDefaultScheme(endpoint));
	const host = url.hostname.replace(/^www\./, "").replace(/^api\./, "");
	const hostSlug = slugify(`${host}${url.port ? `-${url.port}` : ""}`) || "provider";
	return `custom-${hostSlug}`;
}

export function dedupe(values: string[]): string[] {
	return Array.from(new Set(values));
}

export function buildProbeUrl(baseUrl: string): string {
	const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL("models", withSlash).toString();
}

// Some gateways (LiteLLM, One API, New API) mount the API under /v1. When the
// user enters a bare host for one of those, fill the version prefix in.
export function ensureV1Path(endpoint: string): string {
	try {
		const url = new URL(endpoint);
		if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return endpoint;
	}
}

export function getPath(obj: any, path: string): any {
	let current = obj;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = current[key];
	}
	return current;
}

export function firstFiniteNumber(obj: any, ...paths: string[]): number | undefined {
	for (const path of paths) {
		const value = getPath(obj, path);
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}
