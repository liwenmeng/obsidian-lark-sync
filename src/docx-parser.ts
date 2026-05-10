// Parses exported .docx (ZIP+XML) from Feishu's old doccn format.
// Uses DecompressionStream (available in Electron/Chromium) for deflate.

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function docxToMarkdown(arrayBuffer: ArrayBuffer): Promise<string> {
	const bytes = new Uint8Array(arrayBuffer);
	const xml = await extractFromZip(bytes, 'word/document.xml');
	if (!xml) return '';
	return xmlToMarkdown(xml);
}

async function extractFromZip(bytes: Uint8Array, targetPath: string): Promise<string | null> {
	const targetBytes = new TextEncoder().encode(targetPath);
	let i = 0;

	while (i + 30 < bytes.length) {
		// Local file header: PK\x03\x04
		if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes[i + 2] !== 0x03 || bytes[i + 3] !== 0x04) {
			break;
		}

		const method = readU16(bytes, i + 8);
		const compSize = readU32(bytes, i + 18);
		const fnLen = readU16(bytes, i + 26);
		const extraLen = readU16(bytes, i + 28);
		const dataStart = i + 30 + fnLen + extraLen;

		// Check filename match
		if (fnLen === targetBytes.length) {
			let match = true;
			for (let j = 0; j < fnLen; j++) {
				if (bytes[i + 30 + j] !== targetBytes[j]) { match = false; break; }
			}
			if (match) {
				const compressed = bytes.slice(dataStart, dataStart + compSize);
				if (method === 0) {
					return new TextDecoder().decode(compressed);
				} else if (method === 8) {
					const decompressed = await decompressDeflateRaw(compressed);
					return new TextDecoder().decode(decompressed);
				}
				return null;
			}
		}

		i = dataStart + compSize;
	}
	return null;
}

async function decompressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	await writer.write(data);
	await writer.close();

	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}

	const totalLen = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(totalLen);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function xmlToMarkdown(xmlContent: string): string {
	const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');
	const body = doc.getElementsByTagNameNS(W_NS, 'body').item(0);
	if (!body) return '';

	const lines: string[] = [];
	const paragraphs = Array.from(body.getElementsByTagNameNS(W_NS, 'p'));

	for (const para of paragraphs) {
		// Skip paragraphs nested inside table cells at this pass (handle inline)
		if (para.parentElement?.localName === 'tc') continue;

		const pStyle = para.getElementsByTagNameNS(W_NS, 'pStyle').item(0)
			?.getAttribute('w:val')?.toLowerCase() ?? '';
		const hasNumPr = para.getElementsByTagNameNS(W_NS, 'numPr').length > 0;

		const runs = Array.from(para.getElementsByTagNameNS(W_NS, 'r'));
		let lineText = '';
		for (const run of runs) {
			const bold = run.getElementsByTagNameNS(W_NS, 'b').length > 0;
			const italic = run.getElementsByTagNameNS(W_NS, 'i').length > 0;
			const t = run.getElementsByTagNameNS(W_NS, 't').item(0)?.textContent ?? '';
			if (!t) continue;
			let chunk = t;
			if (bold && italic) chunk = `***${chunk}***`;
			else if (bold) chunk = `**${chunk}**`;
			else if (italic) chunk = `*${chunk}*`;
			lineText += chunk;
		}

		if (!lineText.trim()) { lines.push(''); continue; }

		if (/^heading\s*[1-6]$/i.test(pStyle) || /^标题\s*[1-6]$/.test(pStyle)) {
			const level = parseInt(pStyle.replace(/\D/g, ''), 10) || 1;
			lines.push(`${'#'.repeat(Math.min(level, 6))} ${lineText}`);
		} else if (hasNumPr || pStyle.includes('listbullet') || pStyle.includes('list bullet')) {
			lines.push(`- ${lineText}`);
		} else if (pStyle.includes('listnumber') || pStyle.includes('list number')) {
			lines.push(`1. ${lineText}`);
		} else {
			lines.push(lineText);
		}
	}

	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readU16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24);
}
