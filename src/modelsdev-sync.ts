// Auto-update for providers whose model list mirrors a models.dev catalog
// entry (the "Add provider → From models.dev catalog" path).
//
// The catalog is the source of truth for these providers: a sync adds models
// published since the last run, refreshes the metadata fields the catalog
// carries (context / max-out / image / reasoning / cost), and drops models the
// catalog no longer lists. Two sets of ids keep that safe:
//
//   ownedIds   — catalog ids this provider mirrors. Only these are ever
//                removed by a sync, so hand-added models survive.
//   suppressed — catalog ids the user deselected when adding the provider, or
//                deleted afterwards. Never re-added, so a sync can't resurrect
//                a model the user got rid of.
//
// State lives in custom-provider-sync.json next to custom-providers.json; the
// models themselves stay in custom-providers.json, so nothing here is needed
// to make a provider work.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchModelMetadata } from "model-probe";
import { AGENT_DIR, loadModelsConfig, saveModelsConfig } from "./config.ts";
import { applyModelMetadata, buildModelEntry, modelIdOf, modelOptionsFromProbe } from "./model-entry.ts";

export const SYNC_STATE_PATH = join(AGENT_DIR, "custom-provider-sync.json");

export type ManagedProvider = {
	/** models.dev catalog provider id this provider mirrors. */
	modelsDevProviderId: string;
	/** Catalog ids the mirror owns — a sync removes these when the catalog drops them. */
	ownedIds: string[];
	/** Catalog ids the user removed on purpose; never re-added. */
	suppressed: string[];
};

type SyncState = { autoUpdate?: Record<string, ManagedProvider> };

export function loadSyncState(): SyncState {
	try {
		if (!existsSync(SYNC_STATE_PATH)) return {};
		const raw = readFileSync(SYNC_STATE_PATH, "utf8").trim();
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as SyncState) : {};
	} catch {
		return {};
	}
}

function saveSyncState(state: SyncState): void {
	writeFileSync(SYNC_STATE_PATH, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
}

export function managedProvider(providerId: string): ManagedProvider | undefined {
	return loadSyncState().autoUpdate?.[providerId];
}

// Start mirroring a catalog provider. `selectedIds` is what the user kept in
// the picker (those become the mirror's own models); every other catalog id is
// recorded as suppressed so a later sync won't add what they deselected.
export function markManaged(
	providerId: string,
	modelsDevProviderId: string,
	selectedIds: string[],
	catalogIds: string[],
): void {
	const state = loadSyncState();
	state.autoUpdate ||= {};
	const selected = new Set(selectedIds);
	const catalog = new Set(catalogIds);
	state.autoUpdate[providerId] = {
		modelsDevProviderId,
		ownedIds: [...selected].filter((id) => catalog.has(id)),
		suppressed: [...catalog].filter((id) => !selected.has(id)),
	};
	saveSyncState(state);
}

export function unmarkManaged(providerId: string): void {
	const state = loadSyncState();
	if (!state.autoUpdate?.[providerId]) return;
	delete state.autoUpdate[providerId];
	saveSyncState(state);
}

export function renameManaged(oldId: string, newId: string): void {
	const state = loadSyncState();
	const managed = state.autoUpdate?.[oldId];
	if (!managed) return;
	delete state.autoUpdate![oldId];
	state.autoUpdate![newId] = managed;
	saveSyncState(state);
}

// Remember models the user deleted from a mirrored provider so the next sync
// doesn't bring them back. No-op for providers without auto-update.
export function suppressModels(providerId: string, modelIds: string[]): void {
	const state = loadSyncState();
	const managed = state.autoUpdate?.[providerId];
	if (!managed) return;
	const drop = new Set(modelIds);
	managed.ownedIds = managed.ownedIds.filter((id) => !drop.has(id));
	managed.suppressed = [...new Set([...managed.suppressed, ...modelIds])];
	saveSyncState(state);
}

export type SyncResult = { added: number; updated: number; removed: number };

// One provider's sync. Returns null when the provider isn't mirrored (or has
// disappeared), and throws when the catalog can't be reached so callers can
// decide how loud to be.
export async function syncProvider(providerId: string): Promise<SyncResult | null> {
	const managed = managedProvider(providerId);
	if (!managed) return null;

	// Only sync against the live catalog (or this machine's own recent copy of
	// it). Offline, the catalog falls back to a published snapshot that can be
	// months older than the store — syncing against that would delete models
	// released since, and resurrect ones the user never chose. Throws instead,
	// which callers treat as "try again next session".
	const { infoById: catalog } = await fetchModelMetadata([], { catalogProviderId: managed.modelsDevProviderId, requireLiveCatalog: true });
	const config = loadModelsConfig();
	const provider = config.providers?.[providerId];
	if (managedProvider(providerId)?.modelsDevProviderId !== managed.modelsDevProviderId) return null;
	if (!provider) {
		unmarkManaged(providerId);
		return null;
	}

	const suppressed = new Set(managed.suppressed);
	const owned = new Set(managed.ownedIds);
	const models: any[] = Array.isArray(provider.models) ? provider.models : [];
	const result: SyncResult = { added: 0, updated: 0, removed: 0 };

	// Remove mirrored models the catalog dropped; hand-added ones are untouched
	// because they were never in ownedIds.
	for (let i = models.length - 1; i >= 0; i--) {
		const id = modelIdOf(models[i]);
		if (!id) continue;
		if (owned.has(id) && !catalog.has(id)) {
			models.splice(i, 1);
			result.removed++;
		}
	}

	for (const [id, info] of catalog) {
		if (suppressed.has(id)) continue;
		const index = models.findIndex((m) => modelIdOf(m) === id);
		if (index === -1) {
			// Same defaults as the add-from-catalog flow: thinking models get the
			// top reasoning ceiling, image input follows the catalog.
			models.push(buildModelEntry(id, modelOptionsFromProbe(info, { reasoning: "xhigh", image: true })));
			result.added++;
			continue;
		}
		const entry = typeof models[index] === "string" ? { id } : models[index];
		if (applyModelMetadata(entry, info)) {
			models[index] = entry;
			result.updated++;
		}
	}

	provider.models = models;
	// The mirror now owns exactly the catalog ids the user hasn't suppressed.
	managed.ownedIds = [...catalog.keys()].filter((id) => !suppressed.has(id));
	const state = loadSyncState();
	state.autoUpdate ||= {};
	state.autoUpdate[providerId] = managed;
	saveSyncState(state);

	if (result.added > 0 || result.updated > 0 || result.removed > 0) saveModelsConfig(config);
	return result;
}

// Sync every mirrored provider. Catalog failures are swallowed: startup must
// never be blocked (or noisy) because models.dev is unreachable.
export async function syncAllManaged(): Promise<Array<{ providerId: string; result: SyncResult }>> {
	const state = loadSyncState();
	const ids = Object.keys(state.autoUpdate ?? {});
	const changed: Array<{ providerId: string; result: SyncResult }> = [];
	for (const providerId of ids) {
		try {
			const result = await syncProvider(providerId);
			if (result && (result.added > 0 || result.updated > 0 || result.removed > 0)) changed.push({ providerId, result });
		} catch {
			// Offline / catalog down — try again next session.
		}
	}
	return changed;
}

export function describeSyncResult(result: SyncResult): string {
	const parts: string[] = [];
	if (result.added > 0) parts.push(`added ${result.added}`);
	if (result.updated > 0) parts.push(`updated ${result.updated}`);
	if (result.removed > 0) parts.push(`removed ${result.removed}`);
	return parts.join(", ");
}
