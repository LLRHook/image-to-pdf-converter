/** Plain-text helpers shared by the document engines. No DOM, no wasm. */

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Decode a text file. Honours a BOM (UTF-8, UTF-16 LE/BE); otherwise strict
 * UTF-8, falling back to windows-1252 for legacy files. Rejects binary data.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  let encoding = 'utf-8';
  let view = bytes;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    view = bytes.subarray(3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    view = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    view = bytes.subarray(2);
  } else {
    // NUL bytes in the first 8 KB of a non-UTF-16 file mean it is not text.
    const head = bytes.subarray(0, 8192);
    let nul = 0;
    for (const b of head) if (b === 0) nul++;
    if (nul > 0) throw new Error('This file looks like binary data, not text.');
  }
  if (encoding === 'utf-8') {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding };
    } catch {
      return { text: new TextDecoder('windows-1252').decode(view), encoding: 'windows-1252' };
    }
  }
  return { text: new TextDecoder(encoding).decode(view), encoding };
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Group lines into blank-line separated blocks (a blank line is empty or whitespace only). */
export function paragraphsOf(text: string): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of splitLines(text)) {
    if (line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

/**
 * True when a block's whitespace is part of its meaning (indented code, ASCII
 * tables and art): two or more indented lines, or a run of 3+ inner spaces/tabs.
 */
export function isPreformatted(lines: string[]): boolean {
  let indented = 0;
  for (const l of lines) {
    if (/^(?: {2,}|\t)/.test(l)) indented++;
    if (/\S(?: {3,}|\t)\S/.test(l)) return true;
  }
  return indented >= 2;
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function baseNameOf(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const name = slash >= 0 ? filename.slice(slash + 1) : filename;
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) || 'document';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Blocks scripts, frames and forms in generated HTML even if the source embedded raw HTML. */
export const HTML_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:">`;
