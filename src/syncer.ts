import { Notice, TFile, Vault } from 'obsidian';
import { FeishuApi, type DocEntry } from './feishu-api';
import { blocksToMarkdown, extractImageTokens, replaceImageTokens } from './converter';
import { docxToMarkdown } from './docx-parser';
import {
	loadSyncRecord, saveSyncRecord,
	markSynced, needsSync, toSafeName,
	type SyncRecord,
} from './sync-record';
import type { LarkSyncSettings } from './settings';

export interface SyncResult {
	synced: number;
	skipped: number;
	failed: number;
}

export class LarkSyncer {
	private settings: LarkSyncSettings;
	private vault: Vault;
	private pluginDir: string;

	constructor(settings: LarkSyncSettings, vault: Vault, pluginDir: string) {
		this.settings = settings;
		this.vault = vault;
		this.pluginDir = pluginDir;
	}

	updateSettings(settings: LarkSyncSettings): void {
		this.settings = settings;
	}

	private getApi(): FeishuApi {
		return new FeishuApi(this.settings.appId, this.settings.appSecret);
	}

	async testConnection(): Promise<number> {
		const { appId, appSecret, folderToken } = this.settings;
		if (!appId || !appSecret || !folderToken) {
			throw new Error('请先填写 App ID、App Secret 和文件夹 Token');
		}
		const api = this.getApi();
		await api.getToken();
		const docs = await api.getAllDocs(folderToken);
		return docs.length;
	}

	async sync(): Promise<SyncResult> {
		const { appId, appSecret, folderToken } = this.settings;
		if (!appId || !appSecret || !folderToken) {
			throw new Error('请先在设置中填写飞书 App ID、App Secret 和文件夹 Token');
		}

		const api = this.getApi();
		const record = await loadSyncRecord(this.pluginDir, this.vault);

		new Notice('正在获取飞书文档列表…');
		const docs = await api.getAllDocs(folderToken);
		new Notice(`发现 ${docs.length} 个文档，开始同步…`);

		let synced = 0, skipped = 0, failed = 0;

		for (const doc of docs) {
			if (!needsSync(doc.token, doc.modifiedTime, record)) {
				skipped++;
				continue;
			}
			try {
				await this.syncOne(doc, api, record);
				synced++;
			} catch (e) {
				failed++;
				console.error(`[LarkSync] 同步失败 "${doc.name}":`, e);
			}
		}

		await saveSyncRecord(this.pluginDir, this.vault, record);
		return { synced, skipped, failed };
	}

	private async syncOne(doc: DocEntry, api: FeishuApi, record: SyncRecord): Promise<void> {
		const safeName = toSafeName(doc.name);
		const pathParts = doc.path.split('/').map(toSafeName);
		const folderPath = [this.settings.syncPath, ...pathParts.slice(0, -1)].join('/');
		const filePath = `${this.settings.syncPath}/${pathParts.join('/')}.md`;

		let markdown: string;
		if (doc.type === 'docx') {
			const blocks = await api.getDocBlocks(doc.token);
			markdown = blocksToMarkdown(blocks);
			markdown = await this.processImages(markdown, safeName, api);
		} else {
			// Old doccn format: export → download → parse
			const ticket = await api.createExportTask(doc.token);
			const fileToken = await api.pollExportTask(ticket, doc.token);
			const buf = await api.downloadBinary(`/drive/v1/export_tasks/file/${fileToken}/download`);
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

		markSynced(doc.token, {
			name: doc.name, safeName, path: doc.path, modifiedTime: doc.modifiedTime,
		}, record);
	}

	private async processImages(markdown: string, docSafeName: string, api: FeishuApi): Promise<string> {
		const tokens = extractImageTokens(markdown);
		if (!tokens.length) return markdown;

		const replacements = new Map<string, string>();
		const attachDir = `${this.settings.syncPath}/attachments/${docSafeName}`;
		await this.ensureFolderExists(attachDir);

		for (const token of tokens) {
			try {
				const { data, ext } = await api.downloadMedia(token);
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
