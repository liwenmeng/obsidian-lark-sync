import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { requestUrl } from 'obsidian';

const BASE = 'https://open.feishu.cn/open-apis';
const CALLBACK_PORT = 8080;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const OAUTH_SCOPES = [
	'docs:doc:readonly',
	'docx:document:readonly',
	'drive:drive:readonly',
	'drive:file:readonly',
	'drive:export:readonly',
].join(' ');

// ── Public types ──────────────────────────────────────────────────────────────

export interface UserTokens {
	userToken: string;
	refreshToken: string;
	expiresAt: number; // Unix ms
}

export interface FeishuApiOptions {
	appId: string;
	appSecret: string;
	tokens: UserTokens | null;
	onTokensUpdate: (tokens: UserTokens) => Promise<void>;
}

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
	/** Folder path within the root, without trailing slash, never includes the doc name. */
	folderPath: string;
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

interface FeishuResponse<T> {
	code: number;
	msg: string;
	data: T;
}

// ── FeishuApi class ───────────────────────────────────────────────────────────

export class FeishuApi {
	private appId: string;
	private appSecret: string;
	private tokens: UserTokens | null;
	private onTokensUpdate: (tokens: UserTokens) => Promise<void>;

	constructor(options: FeishuApiOptions) {
		this.appId = options.appId;
		this.appSecret = options.appSecret;
		this.tokens = options.tokens;
		this.onTokensUpdate = options.onTokensUpdate;
	}

	updateOptions(options: Partial<FeishuApiOptions>): void {
		if (options.appId !== undefined) this.appId = options.appId;
		if (options.appSecret !== undefined) this.appSecret = options.appSecret;
		if (options.tokens !== undefined) this.tokens = options.tokens;
		if (options.onTokensUpdate !== undefined) this.onTokensUpdate = options.onTokensUpdate;
	}

	get isAuthorized(): boolean {
		return this.tokens !== null && this.tokens.userToken !== '';
	}

	// ── Auth: app_access_token (used only for OAuth exchange) ─────────────────

	private async getAppToken(): Promise<string> {
		const res = await requestUrl({
			url: `${BASE}/auth/v3/app_access_token/internal`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
		});
		const data = res.json as { code: number; msg: string; app_access_token: string };
		if (data.code !== 0) throw new Error(`获取 app_access_token 失败：${data.msg}`);
		return data.app_access_token;
	}

	// ── Auth: OAuth flow ──────────────────────────────────────────────────────

	/** Opens browser for OAuth, starts local callback server, stores user token. */
	async startOAuth(): Promise<void> {
		if (!this.appId || !this.appSecret) {
			throw new Error('请先填写 App ID 和 App Secret');
		}

		const appToken = await this.getAppToken();

		const params = new URLSearchParams({
			app_id: this.appId,
			redirect_uri: REDIRECT_URI,
			scope: OAUTH_SCOPES,
			state: Math.random().toString(36).slice(2),
		});
		const authUrl = `${BASE}/authen/v1/authorize?${params.toString()}`;

		// Open in system browser via Electron shell
		openInBrowser(authUrl);

		// Wait for callback on localhost
		const code = await waitForCallback(CALLBACK_PORT);

		// Exchange code → user_access_token
		const tokens = await this.exchangeCode(code, appToken);
		this.tokens = tokens;
		await this.onTokensUpdate(tokens);
	}

	private async exchangeCode(code: string, appToken: string): Promise<UserTokens> {
		const res = await requestUrl({
			url: `${BASE}/authen/v1/oidc/access_token`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${appToken}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify({ grant_type: 'authorization_code', code }),
		});
		const resp = res.json as FeishuResponse<{
			access_token: string; refresh_token: string; expires_in: number;
		}>;
		if (resp.code !== 0) throw new Error(`OAuth 换取 token 失败：${resp.msg}`);
		return {
			userToken: resp.data.access_token,
			refreshToken: resp.data.refresh_token,
			expiresAt: Date.now() + resp.data.expires_in * 1000,
		};
	}

	async refreshAccessToken(): Promise<void> {
		if (!this.tokens?.refreshToken) throw new Error('没有 refresh_token，请重新授权');
		const appToken = await this.getAppToken();
		const res = await requestUrl({
			url: `${BASE}/authen/v1/oidc/refresh_access_token`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${appToken}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken }),
		});
		const resp = res.json as FeishuResponse<{
			access_token: string; refresh_token: string; expires_in: number;
		}>;
		if (resp.code !== 0) throw new Error(`刷新 token 失败：${resp.msg}`);
		this.tokens = {
			userToken: resp.data.access_token,
			refreshToken: resp.data.refresh_token,
			expiresAt: Date.now() + resp.data.expires_in * 1000,
		};
		await this.onTokensUpdate(this.tokens);
	}

	/** Returns a valid user_access_token, refreshing automatically if needed. */
	async getUserToken(): Promise<string> {
		if (!this.tokens) throw new Error('未授权，请先点击"授权飞书账号"');
		// Refresh 5 minutes before expiry
		if (this.tokens.expiresAt < Date.now() + 300_000) {
			await this.refreshAccessToken();
		}
		return this.tokens.userToken;
	}

	// ── HTTP helpers ──────────────────────────────────────────────────────────

	private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		const token = await this.getUserToken();
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
		const token = await this.getUserToken();
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

	// ── Drive API ─────────────────────────────────────────────────────────────

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
				docs.push({ token: f.token, name: f.name, type: f.type, path: itemPath, folderPath: pathPrefix, modifiedTime: f.modified_time });
			}
		}
	}

	// ── Docx block API ────────────────────────────────────────────────────────

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

	// ── Export API (old doccn format) ─────────────────────────────────────────

	async createExportTask(docToken: string): Promise<string> {
		const data = await this.post<{ ticket: string }>('/drive/v1/export_tasks', {
			file_extension: 'docx', token: docToken, type: 'doc',
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

	// ── Binary downloads ──────────────────────────────────────────────────────

	async downloadBinary(path: string): Promise<ArrayBuffer> {
		const token = await this.getUserToken();
		const res = await requestUrl({
			url: `${BASE}${path}`,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		});
		return res.arrayBuffer;
	}

	async downloadMedia(fileToken: string): Promise<{ data: ArrayBuffer; ext: string }> {
		const token = await this.getUserToken();
		const res = await requestUrl({
			url: `${BASE}/drive/v1/medias/${fileToken}/download`,
			method: 'GET',
			headers: { Authorization: `Bearer ${token}` },
		});
		const ct = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '') as string;
		return { data: res.arrayBuffer, ext: mimeToExt(ct) };
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function openInBrowser(url: string): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const electron = (require as (m: string) => any)('electron') as {
			shell: { openExternal: (u: string) => void };
		};
		electron.shell.openExternal(url);
	} catch {
		window.open(url, '_blank');
	}
}

function waitForCallback(port: number): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			try {
				const raw = req.url ?? '/';
				const url = new URL(raw, `http://localhost:${port}`);
				if (url.pathname !== '/callback') {
					res.writeHead(404).end();
					return;
				}
				const code = url.searchParams.get('code');
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<h1 style="font-family:sans-serif;padding:2rem">飞书授权成功！请关闭此窗口，回到 Obsidian 继续。</h1>');
				server.close();
				if (code) resolve(code);
				else reject(new Error('回调 URL 中缺少 code 参数'));
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});

		// Listen without explicit host so Node.js binds dual-stack (:: on macOS/Linux,
		// 0.0.0.0 on Windows), accepting both 127.0.0.1 and ::1 — necessary because
		// macOS resolves 'localhost' to ::1 (IPv6) which would miss an IPv4-only bind.
		server.listen(port, () => {
			console.log(`[LarkSync] OAuth 回调服务器监听 http://localhost:${port}/callback`);
		});

		server.on('error', (e: Error) => {
			reject(new Error(`端口 ${port} 被占用，请关闭占用该端口的程序后重试：${e.message}`));
		});

		const timer = setTimeout(() => {
			server.close();
			reject(new Error('OAuth 授权超时（120 秒），请重试'));
		}, 120_000);

		server.on('close', () => clearTimeout(timer));
	});
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
