import * as CodingAgent from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelsConfig } from "./types.ts";

// This extension keeps its own store instead of writing into pi's models.json:
//   custom-providers.json       this extension's providers (never pi's file)
//   custom-providers-auth.json  their API keys (never pi's auth.json)
// At load time every provider here is injected into pi with
// pi.registerProvider(), so it shows up in /model exactly like a native one
// while the files stay separate.
export const AGENT_DIR = CodingAgent.getAgentDir();
export const STORE_PATH = join(AGENT_DIR, "custom-providers.json");
export const STORE_AUTH_PATH = join(AGENT_DIR, "custom-providers-auth.json");
// pi's own files — read only for the one-time import and never written.
export const PI_MODELS_PATH = join(AGENT_DIR, "models.json");
export const PI_AUTH_PATH = join(AGENT_DIR, "auth.json");

// Every custom provider id carries this prefix. It is the visible marker that
// separates our providers from pi's built-ins in /model and /login, and it
// makes an id collision with a built-in provider impossible. A dot rather than
// a slash: pi parses model references as "provider/model" splitting at the
// FIRST slash, so a slash inside a provider id cannot be referenced at all
// (verified against pi's resolveModelReference).
export const CUSTOM_PREFIX = "custom.";
// Prefixes older versions wrote. Accepted on input and renamed in the store.
const LEGACY_PREFIXES = ["custom-"];

export function isCustomId(id: string): boolean {
	return id.startsWith(CUSTOM_PREFIX);
}

// Normalize any user/legacy id into our namespace: "Ustc Relay" -> "custom.ustc-relay".
// An id already carrying a known prefix (custom. or the legacy custom-) keeps
// its marker stripped and re-added, so both spellings land on the same id.
export function ensureCustomId(id: string): string {
	let trimmed = id.trim();
	if (isCustomId(trimmed)) trimmed = trimmed.slice(CUSTOM_PREFIX.length);
	for (const legacy of LEGACY_PREFIXES) {
		if (trimmed.startsWith(legacy)) trimmed = trimmed.slice(legacy.length);
	}
	return `${CUSTOM_PREFIX}${trimmed}`;
}

function ensureConfigDir() {
	mkdirSync(dirname(STORE_PATH), { recursive: true });
}

// Fired after every store/auth write so the caller can re-register the
// providers with pi. Set from index.ts (keeps this module host-agnostic).
let saveListener: (() => void) | undefined;
export function onStoreSaved(listener: () => void): void {
	saveListener = listener;
}

type AuthFile = Record<string, any>;

export function loadAuthFile(): AuthFile {
	if (!existsSync(STORE_AUTH_PATH)) return {};
	const raw = readFileSync(STORE_AUTH_PATH, "utf8").trim();
	if (!raw) return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${STORE_AUTH_PATH} must be an object`);
	}
	return parsed;
}

function saveAuthFile(auth: AuthFile) {
	mkdirSync(dirname(STORE_AUTH_PATH), { recursive: true });
	writeFileSync(STORE_AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
	saveListener?.();
}

// The store's key for a provider: our auth file first, then a legacy inline
// apiKey left over from an import.
export function storedApiKey(providerId: string, provider: any): string | undefined {
	try {
		const entry = loadAuthFile()[providerId];
		if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key) {
			return entry.key;
		}
	} catch {
		// Unreadable auth store — fall back to the inline key below.
	}
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey : "";
	return inline || undefined;
}

export function saveProviderApiKey(providerId: string, serializedKey: string) {
	const auth = loadAuthFile();
	auth[providerId] = { type: "api_key", key: serializedKey };
	saveAuthFile(auth);
}

export function removeProviderApiKey(providerId: string) {
	let auth: AuthFile;
	try {
		auth = loadAuthFile();
	} catch {
		return;
	}
	if (!(providerId in auth)) return;
	delete auth[providerId];
	saveAuthFile(auth);
}

export function renameProviderApiKey(oldId: string, newId: string) {
	let auth: AuthFile;
	try {
		auth = loadAuthFile();
	} catch {
		return;
	}
	if (!(oldId in auth)) return;
	if (!(newId in auth)) auth[newId] = auth[oldId];
	delete auth[oldId];
	saveAuthFile(auth);
}

// Rename ids written with an older marker (custom-foo -> custom.foo) in both
// files. Called once at load, before the first registration. Returns true when
// anything changed.
export function normalizeStoreIds(): boolean {
	let store: ModelsConfig;
	try {
		store = loadModelsConfig();
	} catch {
		return false;
	}
	const providers = store.providers ?? {};
	const renames: Array<[string, string]> = [];
	for (const id of Object.keys(providers)) {
		if (isCustomId(id)) continue;
		const renamed = ensureCustomId(id);
		if (renamed === id || providers[renamed]) continue;
		renames.push([id, renamed]);
	}
	if (renames.length === 0) return false;

	const rebuilt: Record<string, any> = {};
	for (const [id, provider] of Object.entries(providers)) {
		const hit = renames.find(([old]) => old === id);
		rebuilt[hit ? hit[1] : id] = provider;
	}
	store.providers = rebuilt;
	writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2).trimEnd()}\n`, "utf8");

	try {
		const auth = loadAuthFile();
		let authChanged = false;
		for (const [old, renamed] of renames) {
			if (!(old in auth) || renamed in auth) continue;
			auth[renamed] = auth[old];
			delete auth[old];
			authChanged = true;
		}
		if (authChanged) writeFileSync(STORE_AUTH_PATH, `${JSON.stringify(auth, null, 2).trimEnd()}\n`, "utf8");
	} catch {
		// Keys stay under the old id; the provider still registers, pi just
		// reports the missing credential and the user can re-enter it.
	}
	return true;
}

// Move inline apiKeys into our auth file and strip them from the provider, so
// keys and declarations never share a file. auth is written BEFORE the store so
// a failed write never strands a key.
function migrateInlineApiKeys(config: ModelsConfig) {
	const providers = config.providers ?? {};
	const inline: Array<[string, string]> = [];
	for (const [id, provider] of Object.entries(providers)) {
		const key = (provider as any)?.apiKey;
		if (typeof key === "string" && key) inline.push([id, key]);
	}
	if (inline.length === 0) return;

	const auth = loadAuthFile();
	for (const [id, key] of inline) {
		if (!(id in auth)) auth[id] = { type: "api_key", key };
	}
	saveAuthFile(auth);
	for (const [id] of inline) {
		delete (providers[id] as any).apiKey;
	}
}

export function loadModelsConfig(): ModelsConfig {
	ensureConfigDir();
	if (!existsSync(STORE_PATH)) {
		return { providers: {} };
	}
	const raw = readFileSync(STORE_PATH, "utf8").trim();
	if (!raw) return { providers: {} };

	let parsed: ModelsConfig;
	try {
		parsed = JSON.parse(raw) as ModelsConfig;
	} catch (error) {
		throw new Error(`${STORE_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${STORE_PATH} must be an object`);
	}
	if (!parsed.providers || typeof parsed.providers !== "object") {
		parsed.providers = {};
	}
	return parsed;
}

export function saveModelsConfig(config: ModelsConfig) {
	ensureConfigDir();
	migrateInlineApiKeys(config);
	writeFileSync(STORE_PATH, `${JSON.stringify(config, null, 2).trimEnd()}\n`, "utf8");
	saveListener?.();
}

// --- one-time import from pi's models.json -----------------------------------
// pi's file mixes the user's own declarations with providers this extension
// wrote before the split, and the two can't be told apart. So the import is
// explicit: the user picks what to move, and the picked entries are removed
// from models.json afterwards (their keys move out of pi's auth.json too).

export type LegacyProvider = { id: string; provider: any; apiKey?: string };

export function readLegacyProviders(): LegacyProvider[] {
	let config: any;
	try {
		if (!existsSync(PI_MODELS_PATH)) return [];
		const raw = readFileSync(PI_MODELS_PATH, "utf8").trim();
		if (!raw) return [];
		config = JSON.parse(raw);
	} catch {
		return [];
	}
	const providers = config?.providers;
	if (!providers || typeof providers !== "object") return [];

	let auth: AuthFile = {};
	try {
		if (existsSync(PI_AUTH_PATH)) auth = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8"));
	} catch {
		// Unreadable pi auth — the import simply carries no keys.
	}

	const out: LegacyProvider[] = [];
	for (const [id, provider] of Object.entries(providers)) {
		const entry = auth[id];
		const apiKey =
			entry && typeof entry === "object" && entry.type === "api_key" && typeof entry.key === "string"
				? entry.key
				: typeof (provider as any)?.apiKey === "string"
					? (provider as any).apiKey
					: undefined;
		out.push({ id, provider, apiKey });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Move the given legacy ids into the store (prefixed) and drop them from
// models.json. Returns the ids now in the store under their custom. names.
export function importLegacyProviders(ids: string[]): { imported: string[]; skipped: string[] } {
	const legacy = readLegacyProviders();
	const wanted = new Set(ids);
	const store = loadModelsConfig();
	store.providers ||= {};
	const auth = loadAuthFile();
	const imported: string[] = [];
	const skipped: string[] = [];

	for (const entry of legacy) {
		if (!wanted.has(entry.id)) continue;
		const newId = ensureCustomId(entry.id);
		if (store.providers[newId]) {
			skipped.push(entry.id);
			continue;
		}
		const provider = JSON.parse(JSON.stringify(entry.provider));
		delete provider.apiKey;
		store.providers[newId] = provider;
		if (entry.apiKey && !(newId in auth)) auth[newId] = { type: "api_key", key: entry.apiKey };
		imported.push(newId);
	}
	if (imported.length === 0) return { imported, skipped };

	saveAuthFile(auth);
	writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2).trimEnd()}\n`, "utf8");

	// Remove the moved entries from pi's files. Both are the user's files, so
	// this only ever touches the ids they picked.
	try {
		const raw = readFileSync(PI_MODELS_PATH, "utf8");
		const piConfig = JSON.parse(raw);
		for (const id of ids) delete piConfig?.providers?.[id];
		writeFileSync(PI_MODELS_PATH, `${JSON.stringify(piConfig, null, 2).trimEnd()}\n`, "utf8");
	} catch {
		// Leave pi's file alone if it can't be read/parsed.
	}
	try {
		if (existsSync(PI_AUTH_PATH)) {
			const piAuth = JSON.parse(readFileSync(PI_AUTH_PATH, "utf8"));
			for (const id of ids) {
				if (piAuth?.[id]?.type === "api_key") delete piAuth[id];
			}
			writeFileSync(PI_AUTH_PATH, `${JSON.stringify(piAuth, null, 2).trimEnd()}\n`, "utf8");
		}
	} catch {
		// Same: the import itself already succeeded.
	}

	saveListener?.();
	return { imported, skipped };
}
