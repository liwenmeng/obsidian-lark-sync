import { Notice, TFile, Vault } from 'obsidian';
import { FeishuApi, type DocEntry } from './feishu-api';
import { blocksToMarkdown, extractImageTokens, replaceImageTokens } from './converter';
import { docxToMarkdown } from './docx-parser';
import {
	loadSyncRecord, saveSyncRecord,
	markSynced, needsSync, toSafeName,
	type SyncRecord,
} from './sync-record';

export interface SyncResult {
	synced: number;
	skipped: number;
	failed: number;
}

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

	async sync(): Promise<SyncResult> {
		if (!this.folderToken) throw new Error('请先在设置中填写文件夹 Token');
		if (!this.api.isAuthorized) throw new Error('请先点击"授权飞书账号"完成 OAuth 授权');

		const record = await loadSyncRecord(this.pluginDir, this.vault);

		new Notice('正在获取飞书文档列表…');
		const docs = await this.api.getAllDocs(this.folderToken);
		new Notice(`发现 ${docs.length} 个文档，开始同步…`);

		let synced = 0, skipped = 0, failed = 0;

		for (const doc of docs) {
			if (!needsSync(doc.token, doc.modifiedTime, record)) {
				skipped++;
				continue;
			}
			try {
				await this.syncOne(doc, record);
				synced++;
			} catch (e) {
				failed++;
				console.error(`[LarkSync] 同步失败 "${doc.name}":`, e);
			}
		}

		await saveSyncRecord(this.pluginDir, this.vault, record);
		return { synced, skipped, failed };
	}

	private async syncOne(doc: DocEntry, record: SyncRecord): Promise<void> {
		const safeName = toSafeName(doc.name);
		const pathParts = doc.path.split('/').map(toSafeName);
		const folderPath = [this.syncPath, ...pathParts.slice(0, -1)].join('/');
		const filePath = `${this.syncPath}/${pathParts.join('/')}.md`;

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
