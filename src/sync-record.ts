import type { Vault } from 'obsidian';

export interface SyncRecordEntry {
	name: string;
	safeName: string;
	path: string;
	modifiedTime: string;
	lastSync: string;
}

export type SyncRecord = Record<string, SyncRecordEntry>;

export function needsSync(token: string, modifiedTime: string, record: SyncRecord): boolean {
	const entry = record[token];
	return !entry || entry.modifiedTime !== modifiedTime;
}

export function markSynced(
	token: string,
	entry: Omit<SyncRecordEntry, 'lastSync'>,
	record: SyncRecord,
): void {
	record[token] = { ...entry, lastSync: new Date().toISOString() };
}

export function toSafeName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim();
}

export async function loadSyncRecord(pluginDir: string, vault: Vault): Promise<SyncRecord> {
	const path = `${pluginDir}/sync-record.json`;
	try {
		const content = await vault.adapter.read(path);
		return JSON.parse(content) as SyncRecord;
	} catch {
		return {};
	}
}

export async function saveSyncRecord(pluginDir: string, vault: Vault, record: SyncRecord): Promise<void> {
	await vault.adapter.write(`${pluginDir}/sync-record.json`, JSON.stringify(record, null, 2));
}
