import { requestUrl } from 'obsidian';

const BASE = 'https://open.feishu.cn/open-apis';

export interface DriveFile {
	token: string;
	name: string;
	type: string;
	modified_time: string;
}

export interface DocEntry {
	token: string;
	name: string;
	type: 'docx' | 'doc';
	path: string;
	modifiedTime: string;
}

export interface FeishuElement {
	text_run?: {
		content: string;
		text_element_style?: {
			bold?: boolean;
			italic?: boolean;
			strikethrough?: boolean;
			inline_code?: boolean;
			link?: { url: string };
		};
	};
	mention_doc?: { token: string; title: string };
	mention_user?: { name?: string };
}

export interface FeishuBlock {
	block_id: string;
	block_type: number;
	parent_id: string;
	children?: string[];
	text?: { elements: FeishuElement[] };
	heading1?: { elements: FeishuElement[] };
	heading2?: { elements: FeishuElement[] };
	heading3?: { elements: FeishuElement[] };
	heading4?: { elements: FeishuElement[] };
	heading5?: { elements: FeishuElement[] };
	heading6?: { elements: FeishuElement[] };
	heading7?: { elements: FeishuElement[] };
	heading8?: { elements: FeishuElement[] };
	heading9?: { elements: FeishuElement[] };
	bullet?: { elements: FeishuElement[] };
	ordered?: { elements: FeishuElement[] };
	code?: { style: { language: number }; elements: FeishuElement[] };
	quote?: { elements: FeishuElement[] };
	todo?: { style: { done: boolean }; elements: FeishuElement[] };
	callout?: { emoji_id: string };
	image?: { token: string };
	table?: { property: { row_size: number; column_size: number } };
}

interface TokenCache {
	token: string;
	expiresAt: number;
}

interface FeishuResponse<T> {
	code: number;
	msg: string;
	data: T;
}

export class FeishuApi {
	private appId: string;
	private appSecret: string;
	private cache: TokenCache | null = null;

	constructor(appId: string, appSecret: string) {
		this.appId = appId;
		this.appSecret = appSecret;
	}

	async getToken(): Promise<string> {
		const now = Date.now();
		if (this.cache && this.cache.expiresAt > now + 60_000) {
			return this.cache.token;
		}
		const res = await requestUrl({
			url: `${BASE}/auth/v3/tenant_access_token/internal`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
		});
		const data = res.json as { code: number; msg: string; tenant_access_token: string; expire: number };
		if (data.code !== 0) throw new Error(`获取 token 失败：${data.msg}`);
		this.cache = { token: data.tenant_access_token, expiresAt: now + data.expire * 1000 };
		return this.cache.token;
	}

	private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		const token = await this.getToken();
		let url = `${BASE}${path}`;
		if (params && Object.keys(params).length > 0) {
			url += '?' + new URLSearchParams(params).toString();
		}
		const res = await requestUrl({
			url,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = res.json as FeishuResponse<T>;
		if (data.code !== 0) throw new Error(`飞书 API 错误 [${path}]：${data.msg} (code=${data.code})`);
		return data.data;
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const token = await this.getToken();
		const res = await requestUrl({
			url: `${BASE}${path}`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify(body),
		});
		const data = res.json as FeishuResponse<T>;
		if (data.code !== 0) throw new Error(`飞书 API 错误 [${path}]：${data.msg} (code=${data.code})`);
		return data.data;
	}

	async listFiles(folderToken: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const params: Record<string, string> = { folder_token: folderToken, page_size: '200' };
			if (pageToken) params['page_token'] = pageToken;
			const data = await this.get<{ files: DriveFile[]; has_more: boolean; next_page_token: string }>(
				'/drive/v1/files', params,
			);
			files.push(...(data.files ?? []));
			pageToken = data.has_more ? data.next_page_token : undefined;
		} while (pageToken);
		return files;
	}

	async getAllDocs(rootFolderToken: string): Promise<DocEntry[]> {
		const docs: DocEntry[] = [];
		await this.traverseFolder(rootFolderToken, '', docs);
		return docs;
	}

	private async traverseFolder(folderToken: string, pathPrefix: string, docs: DocEntry[]): Promise<void> {
		const files = await this.listFiles(folderToken);
		for (const f of files) {
			const itemPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
			if (f.type === 'folder') {
				await this.traverseFolder(f.token, itemPath, docs);
			} else if (f.type === 'docx' || f.type === 'doc') {
				docs.push({ token: f.token, name: f.name, type: f.type, path: itemPath, modifiedTime: f.modified_time });
			}
		}
	}

	async getDocBlocks(docToken: string): Promise<FeishuBlock[]> {
		const blocks: FeishuBlock[] = [];
		let pageToken: string | undefined;
		do {
			const params: Record<string, string> = { page_size: '500' };
			if (pageToken) params['page_token'] = pageToken;
			const data = await this.get<{ items: FeishuBlock[]; has_more: boolean; next_page_token: string }>(
				`/docx/v1/documents/${docToken}/blocks`, params,
			);
			blocks.push(...(data.items ?? []));
			pageToken = data.has_more ? data.next_page_token : undefined;
		} while (pageToken);
		return blocks;
	}

	async createExportTask(docToken: string): Promise<string> {
		const data = await this.post<{ ticket: string }>('/drive/v1/export_tasks', {
			file_extension: 'docx',
			token: docToken,
			type: 'doc',
		});
		return data.ticket;
	}

	async pollExportTask(ticket: string, docToken: string): Promise<string> {
		for (let i = 0; i < 20; i++) {
			await sleep(2000);
			const data = await this.get<{
				result: { job_status: number; file_token: string; job_error_msg: string };
			}>(`/drive/v1/export_tasks/${ticket}`, { token: docToken });
			const { job_status, file_token, job_error_msg } = data.result;
			if (job_status === 0) return file_token;
			if (job_status !== 1 && job_status !== 2) throw new Error(`导出任务失败：${job_error_msg}`);
		}
		throw new Error('导出任务超时（40 秒）');
	}

	async downloadBinary(path: string): Promise<ArrayBuffer> {
		const token = await this.getToken();
		const res = await requestUrl({
			url: `${BASE}${path}`,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		});
		return res.arrayBuffer;
	}

	async downloadMedia(fileToken: string): Promise<{ data: ArrayBuffer; ext: string }> {
		const token = await this.getToken();
		const res = await requestUrl({
			url: `${BASE}/drive/v1/medias/${fileToken}/download`,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		});
		const ct = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '') as string;
		return { data: res.arrayBuffer, ext: mimeToExt(ct) };
	}

	invalidateToken(): void {
		this.cache = null;
	}
}

function mimeToExt(mime: string): string {
	const map: Record<string, string> = {
		'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
		'image/webp': '.webp', 'image/bmp': '.bmp',
	};
	for (const [k, v] of Object.entries(map)) {
		if (mime.includes(k)) return v;
	}
	return '.png';
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
