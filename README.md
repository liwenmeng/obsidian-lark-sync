# Lark Sync

Sync documents from your [Feishu (Lark)](https://www.feishu.cn) cloud drive into your Obsidian vault. Supports incremental updates, image attachments, and both new (`docx`) and legacy (`doc`) document formats.

> **Desktop only.** This plugin uses a local OAuth callback server and requires the Obsidian desktop app.

---

## Features

- **One-click sync** — ribbon icon or command palette entry triggers a full sync
- **Incremental updates** — only documents modified since the last sync are downloaded
- **Image attachments** — embedded images are downloaded and stored as local files with Obsidian wiki-links
- **Both document formats** — native `docx` blocks API and legacy `doc` export API are both supported
- **Real-time progress** — the notification shows `Syncing… 12/180 · est. 8 min remaining` while syncing
- **Error log** — failed documents are saved to `sync-errors.json` in the plugin folder for easy inspection
- **Feishu OAuth** — authenticates with your personal Feishu account via OAuth 2.0; no password is ever stored

---

## Prerequisites

Before installing the plugin you need a Feishu custom app with the correct permissions.

### 1. Create a Feishu app

1. Go to [Feishu Open Platform](https://open.feishu.cn/) and log in.
2. Click **Create App** → choose **Custom App**.
3. In **Permissions & Scopes**, enable at minimum:
   - `docs:doc:readonly`
   - `docx:document:readonly`
   - `drive:drive:readonly`
   - `drive:file:readonly`
   - `drive:export:readonly`
4. In **Security Settings → Redirect URLs**, add exactly:
   ```
   http://localhost:8080/callback
   ```
5. Publish the app (it only needs to be available to yourself).
6. Copy the **App ID** and **App Secret** from **Credentials & Basic Info**.

---

## Installation

The plugin is not yet in the Obsidian community plugin list. Install it manually:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/liwenmeng/obsidian-lark-sync/releases).
2. Create the folder `<your-vault>/.obsidian/plugins/obsidian-lark-sync/`.
3. Copy both files into that folder.
4. In Obsidian, go to **Settings → Community Plugins**, disable Safe Mode, and enable **Lark Sync**.

---

## Configuration

Open **Settings → Lark Sync**.

| Field | Description |
|---|---|
| **App ID** | The App ID from your Feishu custom app. |
| **App Secret** | The App Secret from your Feishu custom app. |
| **Feishu Folder URL** | Paste the full URL of the Feishu folder you want to sync, e.g. `https://xxx.feishu.cn/drive/folder/fldcnXXXXX`. The folder token is extracted automatically. |
| **Local Sync Path** | The folder inside your vault where documents will be saved (default: `Lark`). |

### Authorize your Feishu account

After filling in the credentials, click **Authorize Feishu Account**. Your browser will open the Feishu OAuth page. Log in and approve the permissions. Once the browser shows the success message, return to Obsidian — the plugin stores your access token automatically.

Authorization lasts approximately 2 hours. The plugin refreshes it silently when it is about to expire.

---

## Usage

### Sync now

- Click the **↻** ribbon icon on the left sidebar, **or**
- Open the command palette (`Ctrl/Cmd + P`) and run **Lark Sync: Sync now**, **or**
- Open **Settings → Lark Sync** and click the **Sync Now** button.

The notification in the top-right corner shows live progress. When finished, a summary appears:

```
Sync complete ✓  Updated 5 · Skipped 174 · Failed 0
```

### File layout

Documents are saved under your configured sync path, mirroring the folder structure in Feishu:

```
Lark/
├── Project Alpha/
│   ├── Meeting Notes.md
│   └── Spec.md
└── Personal/
    └── Reading List.md
```

Images are saved to `<sync-path>/attachments/<document-name>/` and referenced with Obsidian wiki-links.

Each file includes YAML front matter with the Feishu token and modification time so the plugin can detect changes without re-downloading unchanged documents.

---

## FAQ

**Q: Can I sync only a subfolder?**  
Paste the URL of that subfolder in the **Feishu Folder URL** field. The plugin syncs the entire subtree under whatever folder you point it at.

**Q: Will my existing notes be overwritten?**  
Only files that were previously synced by this plugin (identified by the `feishu_token` front matter field) are updated. Unrelated notes in the same vault are never touched.

**Q: My sync shows failures. How do I see the details?**  
After any sync with failures, a `sync-errors.json` file is written to `.obsidian/plugins/obsidian-lark-sync/`. Open it to see the document name, token, and error message for each failure.

**Q: Does the plugin work on mobile?**  
No. The OAuth flow requires a local HTTP server (`http://localhost:8080/callback`) which is only available on the desktop app.

**Q: The authorization expired and sync fails. What do I do?**  
Go to **Settings → Lark Sync** and click **Authorize Feishu Account** again to get a fresh token.

**Q: Can I use this with a Lark (non-Chinese) account?**  
Yes. Feishu and Lark share the same Open Platform API. The plugin works with both.

---

## Development

```bash
git clone https://github.com/liwenmeng/obsidian-lark-sync.git
cd obsidian-lark-sync
npm install
npm run dev          # watch mode
npm run build        # production build
```

Copy `main.js` and `manifest.json` to your vault's plugin folder to test.

---

## License

MIT — see [LICENSE](LICENSE).
