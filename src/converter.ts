import type { FeishuBlock, FeishuElement } from './feishu-api';

const CODE_LANG: Record<number, string> = {
	1: '', 7: 'bash', 8: 'csharp', 9: 'cpp', 10: 'c', 12: 'css',
	13: 'coffeescript', 18: 'dockerfile', 22: 'go', 24: 'html', 28: 'json',
	29: 'java', 30: 'javascript', 32: 'kotlin', 38: 'makefile',
	39: 'markdown', 43: 'php', 46: 'powershell', 49: 'python', 50: 'r',
	52: 'ruby', 53: 'rust', 55: 'scss', 56: 'sql', 57: 'scala',
	60: 'shell', 61: 'swift', 63: 'typescript', 66: 'xml', 67: 'yaml',
	68: 'cmake', 69: 'diff', 71: 'graphql', 75: 'toml',
};

function renderInline(elements: FeishuElement[]): string {
	const parts: string[] = [];
	for (const el of elements) {
		if (el.text_run) {
			const { content, text_element_style: s = {} } = el.text_run;
			if (s.inline_code) {
				parts.push(`\`${content}\``);
				continue;
			}
			let text = content;
			if (s.bold) text = `**${text}**`;
			if (s.italic) text = `*${text}*`;
			if (s.strikethrough) text = `~~${text}~~`;
			if (s.link?.url) {
				try { text = `[${text}](${decodeURIComponent(s.link.url)})`; }
				catch { text = `[${text}](${s.link.url})`; }
			}
			parts.push(text);
		} else if (el.mention_doc) {
			const { token, title } = el.mention_doc;
			if (title) parts.push(`[${title}](feishu-doc://${token})`);
		} else if (el.mention_user?.name) {
			parts.push(`@${el.mention_user.name}`);
		}
	}
	return parts.join('');
}

function getHeadingElements(block: FeishuBlock, level: number): FeishuElement[] {
	switch (level) {
		case 1: return block.heading1?.elements ?? [];
		case 2: return block.heading2?.elements ?? [];
		case 3: return block.heading3?.elements ?? [];
		case 4: return block.heading4?.elements ?? [];
		case 5: return block.heading5?.elements ?? [];
		default: return block.heading6?.elements ?? [];
	}
}

function renderKids(ids: string[], byId: Map<string, FeishuBlock>, depth: number): string {
	const parts: string[] = [];
	for (const id of ids) {
		const b = byId.get(id);
		if (b) parts.push(renderBlock(b, byId, depth));
	}
	const sep = depth > 0 ? '\n' : '\n\n';
	return parts.filter(p => p !== '').join(sep);
}

function renderTable(block: FeishuBlock, byId: Map<string, FeishuBlock>): string {
	const prop = block.table?.property;
	const cellIds = block.children ?? [];
	if (!prop || !cellIds.length) return '';
	const { row_size: rows, column_size: cols } = prop;
	if (!rows || !cols) return '';

	const grid: string[][] = [];
	for (let r = 0; r < rows; r++) {
		const row: string[] = [];
		for (let c = 0; c < cols; c++) {
			const idx = r * cols + c;
			const cellId = cellIds[idx];
			const cell = cellId ? byId.get(cellId) : undefined;
			const text = cell ? renderKids(cell.children ?? [], byId, 0) : '';
			row.push(text.replace(/\n/g, ' ').replace(/\|/g, '\\|'));
		}
		grid.push(row);
	}

	const firstRow = grid[0];
	if (!firstRow) return '';
	const lines = [
		'| ' + firstRow.join(' | ') + ' |',
		'| ' + Array(cols).fill('---').join(' | ') + ' |',
		...grid.slice(1).map(row => '| ' + row.join(' | ') + ' |'),
	];
	return lines.join('\n');
}

function renderBlock(block: FeishuBlock, byId: Map<string, FeishuBlock>, depth: number): string {
	const t = block.block_type;
	const children = block.children ?? [];

	if (t === 1) return renderKids(children, byId, 0);
	if (t === 2) return renderInline(block.text?.elements ?? []);

	if (t >= 3 && t <= 11) {
		const level = Math.min(t - 2, 6);
		return `${'#'.repeat(level)} ${renderInline(getHeadingElements(block, level))}`;
	}

	if (t === 12 || t === 13) {
		const isBullet = t === 12;
		const node = isBullet ? block.bullet : block.ordered;
		const marker = isBullet ? '- ' : '1. ';
		const indent = '  '.repeat(depth);
		let result = `${indent}${marker}${renderInline(node?.elements ?? [])}`;
		if (children.length) result += '\n' + renderKids(children, byId, depth + 1);
		return result;
	}

	if (t === 14) {
		const lang = CODE_LANG[block.code?.style.language ?? 1] ?? '';
		const text = (block.code?.elements ?? []).map(el => el.text_run?.content ?? '').join('');
		return `\`\`\`${lang}\n${text}\n\`\`\``;
	}

	if (t === 15) return `> ${renderInline(block.quote?.elements ?? [])}`;

	if (t === 16) {
		const done = block.todo?.style.done ?? false;
		return `- [${done ? 'x' : ' '}] ${renderInline(block.todo?.elements ?? [])}`;
	}

	if (t === 18) {
		const emoji = block.callout?.emoji_id ?? '';
		const childMd = renderKids(children, byId, 0);
		const quoted = childMd.split('\n').map(l => `> ${l}`).join('\n');
		return (emoji ? `> ${emoji}\n` : '') + quoted;
	}

	if (t === 19) return '---';

	if (t === 27) {
		const imgToken = block.image?.token ?? '';
		return imgToken ? `![](feishu-image://${imgToken})` : '';
	}

	if (t === 28) return renderTable(block, byId);

	if (t === 31) {
		const childMd = renderKids(children, byId, 0);
		return childMd.split('\n').map(l => `> ${l}`).join('\n');
	}

	return children.length ? renderKids(children, byId, depth) : '';
}

export function blocksToMarkdown(blocks: FeishuBlock[]): string {
	if (!blocks.length) return '';
	const byId = new Map(blocks.map(b => [b.block_id, b]));
	const root = blocks.find(b => b.block_type === 1);
	return root ? renderBlock(root, byId, 0) : '';
}

export function extractImageTokens(markdown: string): string[] {
	const tokens: string[] = [];
	const re = /!\[\]\(feishu-image:\/\/([^)]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		const tok = m[1];
		if (tok) tokens.push(tok);
	}
	return tokens;
}

export function replaceImageTokens(markdown: string, replacements: Map<string, string>): string {
	return markdown.replace(/!\[\]\(feishu-image:\/\/([^)]+)\)/g, (full, token: string) => {
		return replacements.get(token) ?? full;
	});
}
