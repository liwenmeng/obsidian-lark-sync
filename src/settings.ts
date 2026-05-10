import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LarkSyncPlugin from './main';

export interface LarkSyncSettings {
	appId: string;
	appSecret: string;
	folderToken: string;
	syncPath: string;
}

export const DEFAULT_SETTINGS: LarkSyncSettings = {
	appId: '',
	appSecret: '',
	folderToken: '',
	syncPath: 'Lark',
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

		new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的 App ID（开放平台 → 凭证与基础信息）')
			.addText(text => text
				.setPlaceholder('cli_xxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.appId)
				.onChange(async (value) => {
					this.plugin.settings.appId = value.trim();
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
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('本地同步路径')
			.setDesc('Obsidian vault 中存放同步文档的文件夹（相对路径）')
			.addText(text => text
				.setPlaceholder('Lark')
				.setValue(this.plugin.settings.syncPath)
				.onChange(async (value) => {
					this.plugin.settings.syncPath = value.trim() || 'Lark';
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: '连接测试' });

		new Setting(containerEl)
			.setName('测试飞书连接')
			.setDesc('验证配置是否正确，并列出可访问的文档数量')
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
