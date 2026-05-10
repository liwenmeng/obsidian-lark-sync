import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LarkSyncPlugin from './main';

export interface LarkSyncSettings {
	appId: string;
	appSecret: string;
	folderToken: string;
	syncPath: string;
	// OAuth user tokens (persisted)
	userToken: string;
	refreshToken: string;
	tokenExpiry: number; // Unix ms
}

export const DEFAULT_SETTINGS: LarkSyncSettings = {
	appId: '',
	appSecret: '',
	folderToken: '',
	syncPath: 'Lark',
	userToken: '',
	refreshToken: '',
	tokenExpiry: 0,
};

export class LarkSyncSettingTab extends PluginSettingTab {
	plugin: LarkSyncPlugin;

	constructor(app: App, plugin: LarkSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '飞书同步设置' });

		// ── App credentials ──────────────────────────────────────────────────

		new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的 App ID（开放平台 → 凭证与基础信息）')
			.addText(text => text
				.setPlaceholder('cli_xxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.appId)
				.onChange(async (value) => {
					this.plugin.settings.appId = value.trim();
					this.plugin.api.updateOptions({ appId: value.trim() });
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('App Secret')
			.setDesc('飞书应用的 App Secret')
			.addText(text => {
				text.inputEl.type = 'password';
				return text
					.setPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.appSecret)
					.onChange(async (value) => {
						this.plugin.settings.appSecret = value.trim();
						this.plugin.api.updateOptions({ appSecret: value.trim() });
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('文件夹 Token')
			.setDesc('要同步的飞书云文档文件夹 token（从文件夹 URL 路径中获取，如 fldcnxxxxxx）')
			.addText(text => text
				.setPlaceholder('fldcnxxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.folderToken)
				.onChange(async (value) => {
					this.plugin.settings.folderToken = value.trim();
					this.plugin.syncer.updateConfig(this.plugin.settings.syncPath, value.trim());
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('本地同步路径')
			.setDesc('Obsidian vault 中存放同步文档的文件夹（相对路径）')
			.addText(text => text
				.setPlaceholder('Lark')
				.setValue(this.plugin.settings.syncPath)
				.onChange(async (value) => {
					const path = value.trim() || 'Lark';
					this.plugin.settings.syncPath = path;
					this.plugin.syncer.updateConfig(path, this.plugin.settings.folderToken);
					await this.plugin.saveSettings();
				}));

		// ── OAuth authorization ───────────────────────────────────────────────

		containerEl.createEl('h3', { text: '飞书账号授权' });

		const authStatus = this.plugin.api.isAuthorized
			? `✓ 已授权（token 有效期至 ${new Date(this.plugin.settings.tokenExpiry).toLocaleString()}）`
			: '✗ 未授权';

		new Setting(containerEl)
			.setName('授权状态')
			.setDesc(authStatus);

		new Setting(containerEl)
			.setName('授权飞书账号')
			.setDesc('点击后会打开浏览器完成飞书 OAuth 授权，授权成功后回到 Obsidian 即可。redirect URI 需在飞书应用里配置为 http://localhost:8080/callback')
			.addButton(btn => {
				btn.setButtonText('授权飞书账号').setCta();
				btn.onClick(async () => {
					btn.setButtonText('等待授权…').setDisabled(true);
					try {
						await this.plugin.api.startOAuth();
						new Notice('✓ 飞书授权成功！');
						this.display(); // refresh to show updated status
					} catch (e) {
						new Notice(`✗ 授权失败：${e instanceof Error ? e.message : String(e)}`);
					} finally {
						btn.setButtonText('授权飞书账号').setDisabled(false);
					}
				});
			});

		// ── Test & sync ───────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: '测试' });

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('验证授权和文件夹 token 是否正确，列出可访问的文档数量')
			.addButton(btn => {
				btn.setButtonText('立即测试').setCta();
				btn.onClick(async () => {
					btn.setButtonText('测试中…').setDisabled(true);
					try {
						const count = await this.plugin.syncer.testConnection();
						new Notice(`✓ 连接成功，共发现 ${count} 个文档`);
					} catch (e) {
						new Notice(`✗ 连接失败：${e instanceof Error ? e.message : String(e)}`);
					} finally {
						btn.setButtonText('立即测试').setDisabled(false);
					}
				});
			});
	}
}
