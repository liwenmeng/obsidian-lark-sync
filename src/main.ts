import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, LarkSyncSettingTab, type LarkSyncSettings } from './settings';
import { FeishuApi, type UserTokens } from './feishu-api';
import { LarkSyncer, type SyncProgress } from './syncer';

export default class LarkSyncPlugin extends Plugin {
	settings: LarkSyncSettings = { ...DEFAULT_SETTINGS };
	api!: FeishuApi;
	syncer!: LarkSyncer;
	isSyncing = false;

	async onload() {
		await this.loadSettings();

		const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;

		// Build initial UserTokens from persisted settings
		const storedTokens: UserTokens | null = this.settings.userToken
			? {
				userToken: this.settings.userToken,
				refreshToken: this.settings.refreshToken,
				expiresAt: this.settings.tokenExpiry,
			}
			: null;

		// Single FeishuApi instance shared across settings tab and syncer
		this.api = new FeishuApi({
			appId: this.settings.appId,
			appSecret: this.settings.appSecret,
			tokens: storedTokens,
			onTokensUpdate: async (tokens: UserTokens) => {
				this.settings.userToken = tokens.userToken;
				this.settings.refreshToken = tokens.refreshToken;
				this.settings.tokenExpiry = tokens.expiresAt;
				await this.saveSettings();
			},
		});

		this.syncer = new LarkSyncer(
			this.api,
			this.app.vault,
			pluginDir,
			this.settings.syncPath,
			this.settings.folderToken,
		);

		this.addRibbonIcon('refresh-cw', '立即同步飞书文档', () => this.runSync());

		this.addCommand({
			id: 'lark-sync-now',
			name: '立即同步飞书文档',
			callback: () => this.runSync(),
		});

		this.addSettingTab(new LarkSyncSettingTab(this.app, this));
	}

	onunload() {}

	async runSync(): Promise<void> {
		if (this.isSyncing) {
			new Notice('同步正在进行中，请稍候…', 3000);
			return;
		}
		this.isSyncing = true;
		const notice = new Notice('正在同步飞书文档…', 0);
		try {
			const result = await this.syncer.sync((p) => {
				notice.setMessage(buildProgressMsg(p));
			});
			notice.hide();

			this.settings.lastSyncTime = new Date().toISOString();
			await this.saveSettings();

			let msg = `同步完成 ✓  更新 ${result.synced} · 跳过 ${result.skipped} · 失败 ${result.failed}`;
			if (result.errors.length > 0) {
				msg += '\n\n失败文档：';
				for (const err of result.errors) {
					msg += `\n• ${err.name}：${err.error}`;
				}
				msg += '\n\n（详情见插件目录 sync-errors.json）';
			}
			new Notice(msg, result.errors.length > 0 ? 0 : 6000);
		} catch (e) {
			notice.hide();
			new Notice(`同步失败：${e instanceof Error ? e.message : String(e)}`, 8000);
			console.error('[LarkSync]', e);
		} finally {
			this.isSyncing = false;
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LarkSyncSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep syncer config in sync when syncPath or folderToken changes
		this.syncer?.updateConfig(this.settings.syncPath, this.settings.folderToken);
	}
}

// ── Progress helpers ──────────────────────────────────────────────────────────

function buildProgressMsg(p: SyncProgress): string {
	const base = `正在同步… ${p.current}/${p.total}`;
	const networkDone = p.synced + p.failed;
	if (networkDone < 5 || p.elapsed === 0) return base;
	const remaining = p.total - p.current;
	if (remaining <= 0) return base;
	const etaMs = (p.elapsed / networkDone) * remaining;
	return `${base} · 预计剩余 ${formatEta(etaMs)}`;
}

function formatEta(ms: number): string {
	const totalMin = Math.round(ms / 60_000);
	if (totalMin < 1) return '不到1分钟';
	if (totalMin < 60) return `${totalMin} 分钟`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}
