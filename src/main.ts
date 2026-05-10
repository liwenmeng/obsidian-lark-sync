import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, LarkSyncSettingTab, type LarkSyncSettings } from './settings';
import { LarkSyncer } from './syncer';

export default class LarkSyncPlugin extends Plugin {
	settings: LarkSyncSettings = { ...DEFAULT_SETTINGS };
	syncer!: LarkSyncer;

	async onload() {
		await this.loadSettings();

		const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		this.syncer = new LarkSyncer(this.settings, this.app.vault, pluginDir);

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
		const notice = new Notice('正在同步飞书文档…', 0);
		try {
			const result = await this.syncer.sync();
			notice.hide();
			new Notice(
				`同步完成 ✓  更新 ${result.synced} · 跳过 ${result.skipped} · 失败 ${result.failed}`,
				6000,
			);
		} catch (e) {
			notice.hide();
			new Notice(`同步失败：${e instanceof Error ? e.message : String(e)}`, 8000);
			console.error('[LarkSync]', e);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LarkSyncSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncer?.updateSettings(this.settings);
	}
}
