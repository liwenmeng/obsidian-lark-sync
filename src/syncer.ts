import { Notice, TFile, Vault } from 'obsidian';
import { FeishuApi, type DocEntry } from './feishu-api';
import { blocksToMarkdown, extractImageTokens, replaceImageTokens } from './converter';
import { docxToMarkdown } from './docx-parser';
import {
	loadSyncRecord, saveSyncRecord,
	markSynced, needsSync, toSafeName,
	type SyncRecord,
} from './sync-record';

export interface SyncError {
	name: string;
	token: string;
	type: string;
	error: string;
}

export interface SyncResult {
	synced: number;
	skipped: number;
	failed: number;
	errors: SyncError[];
}

export interface SyncProgress {
	current: number;  // docs processed so far (all types)
	total: number;
	synced: number;   // successfully synced (made network calls)
	failed: number;   // failed (made network calls)
	elapsed: number;  // ms since sync started
}

export type SyncProgressCallback = (p: SyncProgress) => void;

export class LarkSyncer {
	private api: FeishuApi;
	private vault: Vault;
	private pluginDir: string;
	private syncPath: string;
	private folderToken: string;

	constructor(api: FeishuApi, vault: Vault, pluginDir: string, syncPath: string, folderToken: string) {
		this.api = api;
		this.vault = vault;
		this.pluginDir = pluginDir;
		this.syncPath = syncPath;
		this.folderToken = folderToken;
	}

	updateConfig(syncPath: string, folderToken: string): void {
		this.syncPath = syncPath;
		this.folderToken = folderToken;
	}

	async testConnection(): Promise<number> {
		if (!this.folderToken) throw new Error('请先填写文件夹 Token');
		if (!this.api.isAuthorized) throw new Error('请先点击"授权飞书账号"完成授权');
		const docs = await this.api.getAllDocs(this.folderToken);
		return docs.length;
	}

	async sync(onProgress?: SyncProgressCallback): Promise<SyncResult> {
		if (!this.folderToken) throw new Error('请先在设置中填写文件夹 Token');
		if (!this.api.isAuthorized) throw new Error('请先点击"授权飞书账号"完成 OAuth 授权');

		const record = await loadSyncRecord(this.pluginDir, this.vault);

		new Notice('正在获取飞书文档列表…');
		const docs = await this.api.getAllDocs(this.folderToken);

		let synced = 0, skipped = 0, failed = 0;
		const errors: SyncError[] = [];
		const startTime = Date.now();

		for (let i = 0; i < docs.length; i++) {
			const doc = docs[i]!;
			if (!needsSync(doc.token, doc.modifiedTime, record)) {
				skipped++;
			} else {
				try {
					await this.syncOne(doc, record);
					synced++;
					await saveSyncRecord(this.pluginDir, this.vault, record);
				} catch (e) {
					failed++;
					const errMsg = e instanceof Error ? e.message : String(e);
					errors.push({ name: doc.name, token: doc.token, type: doc.type, error: errMsg });
					console.error(`[LarkSync] 同步失败 "${doc.name}" (${doc.token}):`, e);
				}
			}
			onProgress?.({ current: i + 1, total: docs.length, synced, failed, elapsed: Date.now() - startTime });
		}

		await saveSyncRecord(this.pluginDir, this.vault, record);

		// Write error log so failures can be inspected without DevTools
		if (errors.length > 0) {
			const logPath = `${this.pluginDir}/sync-errors.json`;
			await this.vault.adapter.write(
				logPath,
				JSON.stringify({ timestamp: new Date().toISOString(), errors }, null, 2),
			);
		}

		return { synced, skipped, failed, errors };
	}

	private async syncOne(doc: DocEntry, record: SyncRecord): Promise<void> {
		// Use token as filename fallback when name is empty or becomes empty after sanitisation
		const safeName = toSafeName(doc.name) || doc.token;
		const folderParts = doc.folderPath
			? doc.folderPath.split('/').filter(Boolean).map(toSafeName)
			: [];
		const folderPath = [this.syncPath, ...folderParts].join('/');
		const filePath = folderParts.length > 0
			? `${this.syncPath}/${folderParts.join('/')}/${safeName}.md`
			: `${this.syncPath}/${safeName}.md`;

		let markdown: string;
		if (doc.type === 'docx') {
			const blocks = await this.api.getDocBlocks(doc.token);
			markdown = blocksToMarkdown(blocks);
			markdown = await this.processImages(markdown, safeName);
		} else {
			const ticket = await this.api.createExportTask(doc.token);
			const fileToken = await this.api.pollExportTask(ticket, doc.token);
			const buf = await this.api.downloadBinary(`/drive/v1/export_tasks/file/${fileToken}/download`);
			markdown = await docxToMarkdown(buf);
		}

		const frontmatter = [
			'---',
			`feishu_token: ${doc.token}`,
			`feishu_type: ${doc.type}`,
			`modified_time: ${doc.modifiedTime}`,
			`last_sync: ${new Date().toISOString()}`,
			'---',
			'',
			'',
		].join('\n');

		await this.ensureFolderExists(folderPath);
		await this.writeFile(filePath, frontmatter + markdown);

		markSynced(doc.token, { name: doc.name, safeName, path: doc.path, modifiedTime: doc.modifiedTime }, record);
	}

	private async processImages(markdown: string, docSafeName: string): Promise<string> {
		const tokens = extractImageTokens(markdown);
		if (!tokens.length) return markdown;

		const replacements = new Map<string, string>();
		const attachDir = `${this.syncPath}/attachments/${docSafeName}`;
		await this.ensureFolderExists(attachDir);

		for (const token of tokens) {
			try {
				const { data, ext } = await this.api.downloadMedia(token);
				const filename = `${token}${ext}`;
				await this.vault.adapter.writeBinary(`${attachDir}/${filename}`, data);
				replacements.set(token, `![[attachments/${docSafeName}/${filename}]]`);
			} catch (e) {
				console.warn(`[LarkSync] 图片下载失败 ${token}:`, e);
			}
		}

		return replaceImageTokens(markdown, replacements);
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const parts = folderPath.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				try { await this.vault.createFolder(current); } catch { /* already exists */ }
			}
		}
	}

	private async writeFile(path: string, content: string): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modify(existing, content);
		} else {
			await this.vault.create(path, content);
		}
	}
}
