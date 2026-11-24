/**
 * Pandoc JSON AST helpers. The AST is the real intermediate representation of
 * every pandoc-based conversion, so facts and the outline preview are derived
 * from it. Traversals are iterative: a hostile document can nest thousands of
 * levels deep and must not overflow the stack.
 */
import type { Facts, Preview } from '../../core/types';
import { isPreformatted, paragraphsOf, truncate } from './text';

export interface PandocAst {
  'pandoc-api-version': number[];
  meta: Record<string, unknown>;
  blocks: AstNode[];
}

export interface AstNode {
  t: string;
  c?: unknown;
}

const BLOCK_TAGS = new Set([
  'Plain', 'Para', 'LineBlock', 'CodeBlock', 'RawBlock', 'BlockQuote', 'OrderedList',
  'BulletList', 'DefinitionList', 'Header', 'HorizontalRule', 'Table', 'Figure', 'Div',
]);

const isNode = (v: unknown): v is AstNode =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as AstNode).t === 'string';

export interface Analysis {
  facts: Extract<Facts, { kind: 'document' }>;
  outline: Extract<Preview, { kind: 'outline' }>;
}

/** Visit every AST node in document order. `visit` returns false to skip a node's children. */
export function walk(root: unknown, visit: (n: AstNode) => boolean | void): void {
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (typeof v === 'object' && v !== null) {
      if (isNode(v)) {
        if (visit(v) === false) continue;
        if (v.c !== undefined) stack.push(v.c);
      } else {
        const vals = Object.values(v);
        for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
      }
    }
  }
}

/** Plain text of an inline/block subtree, cut off at `limit` characters. */
export function textOf(root: unknown, limit = 200): string {
  let out = '';
  walk(root, (n) => {
    if (out.length >= limit) return false;
    switch (n.t) {
      case 'Str':
        out += n.c as string;
        break;
      case 'Space':
      case 'SoftBreak':
      case 'LineBreak':
        out += ' ';
        break;
      case 'Code':
        out += (n.c as [unknown, string])[1];
        return false;
      case 'Math':
        out += (n.c as [unknown, string])[1];
        return false;
      case 'Image':
        // Alt text only: skip the target.
        out += textOf((n.c as unknown[])[1], limit);
        return false;
      case 'RawInline':
      case 'RawBlock':
        return false;
      default:
    }
    return true;
  });
  return out;
}

export function analyze(ast: PandocAst): Analysis {
  let blocks = 0;
  let headings = 0;
  let images = 0;
  let tables = 0;
  let words = 0;
  let inWord = false;
  const tokens = (s: string) => (s.match(/\S+/g) ?? []).length;
  walk(ast.blocks, (n) => {
    if (BLOCK_TAGS.has(n.t)) {
      blocks++;
      inWord = false;
    }
    switch (n.t) {
      case 'Header':
        headings++;
        break;
      case 'Image':
        images++;
        return false; // alt text is not document text
      case 'Table':
        tables++;
        break;
      case 'Str':
        if ((n.c as string).length > 0 && !inWord) {
          words++;
          inWord = true;
        }
        break;
      case 'Space':
      case 'SoftBreak':
      case 'LineBreak':
        inWord = false;
        break;
      case 'Code':
        words += tokens((n.c as [unknown, string])[1]);
        inWord = false;
        return false;
      case 'CodeBlock':
        words += tokens((n.c as [unknown, string])[1]);
        return false;
      case 'Math':
        words++;
        inWord = false;
        return false;
      case 'RawBlock':
      case 'RawInline':
        return false;
      default:
    }
    return true;
  });
  return { facts: { kind: 'document', blocks, headings, images, words, tables }, outline: outlineOf(ast) };
}

function tableShape(n: AstNode): string {
  // Table = [attr, caption, colspecs, head, bodies, foot]
  const c = n.c as unknown[];
  const cols = (c[2] as unknown[]).length;
  let rows = 0;
  const head = c[3] as [unknown, unknown[]];
  rows += head[1].length;
  for (const body of c[4] as [unknown, number, unknown[], unknown[]][]) rows += body[2].length + body[3].length;
  const foot = c[5] as [unknown, unknown[]];
  rows += foot[1].length;
  return `Table: ${rows} row${rows === 1 ? '' : 's'} × ${cols} column${cols === 1 ? '' : 's'}`;
}

/** First ~40 blocks, flattened out of containers: heading level, or 0 for body blocks. */
export function outlineOf(ast: PandocAst, maxItems = 40): Analysis['outline'] {
  const items: { level: number; text: string }[] = [];
  const queue: { node: AstNode; depth: number }[] = [];
  const pushAll = (nodes: unknown, depth: number) => {
    if (!Array.isArray(nodes)) return;
    for (let i = nodes.length - 1; i >= 0; i--) if (isNode(nodes[i])) queue.push({ node: nodes[i] as AstNode, depth });
  };
  pushAll(ast.blocks, 0);
  while (queue.length && items.length < maxItems) {
    const { node, depth } = queue.pop()!;
    const c = node.c as unknown[];
    switch (node.t) {
      case 'Header':
        items.push({ level: c[0] as number, text: truncate(textOf(c[2]), 80) });
        break;
      case 'Para':
      case 'Plain': {
        const text = truncate(textOf(node.c), 80);
        if (text) items.push({ level: 0, text });
        break;
      }
      case 'CodeBlock': {
        const first = String((c as [unknown, string])[1]).split('\n', 1)[0] ?? '';
        items.push({ level: 0, text: truncate(first, 80) || '(code block)' });
        break;
      }
      case 'LineBlock': {
        const text = truncate(textOf(node.c), 80);
        if (text) items.push({ level: 0, text });
        break;
      }
      case 'Table':
        items.push({ level: 0, text: tableShape(node) });
        break;
      case 'BlockQuote':
      case 'Div':
        if (depth < 6) pushAll(node.t === 'Div' ? c[1] : node.c, depth + 1);
        break;
      case 'Figure':
        if (depth < 6) pushAll(c[2], depth + 1);
        break;
      case 'BulletList':
      case 'OrderedList': {
        const list = (node.t === 'OrderedList' ? c[1] : node.c) as unknown[][];
        if (depth < 6) for (let i = list.length - 1; i >= 0; i--) pushAll(list[i], depth + 1);
        break;
      }
      case 'DefinitionList':
        for (const [term, defs] of (node.c as [unknown, unknown[][]][]).slice(0, maxItems)) {
          if (items.length >= maxItems) break;
          const text = truncate(textOf(term), 80);
          if (text) items.push({ level: 0, text });
          void defs;
        }
        break;
      default: // HorizontalRule, RawBlock: nothing to show
    }
  }
  return { kind: 'outline', items: items.slice(0, maxItems) };
}

/* ------------------------------------------------------------------ images */

const normUrl = (u: string) => u.replace(/^\.\//, '');

/** Image nodes in document order. */
export function imageNodes(ast: PandocAst): AstNode[] {
  const out: AstNode[] = [];
  walk(ast.blocks, (n) => {
    if (n.t === 'Image') out.push(n);
    else if (n.t === 'RawBlock' || n.t === 'RawInline') return false;
    return true;
  });
  return out;
}

export function imageUrl(n: AstNode): string {
  return (n.c as [unknown, unknown, [string, string]])[2][0];
}

export function setImageUrl(n: AstNode, url: string): void {
  (n.c as [unknown, unknown, [string, string]])[2][0] = url;
}

/** Find the media entry an image URL refers to (pandoc may URL-encode or prefix `./`). */
export function lookupMedia<T>(map: Map<string, T>, url: string): { key: string; value: T } | undefined {
  for (const k of [url, normUrl(url)]) {
    const v = map.get(k);
    if (v !== undefined) return { key: k, value: v };
  }
  try {
    const d = normUrl(decodeURIComponent(url));
    const v = map.get(d);
    if (v !== undefined) return { key: d, value: v };
  } catch {
    // malformed escape: not a local file reference
  }
  return undefined;
}

/** Replace an Image node (in place) by its alt text, e.g. "[image: logo]". */
export function replaceImageWithAlt(n: AstNode): void {
  const alt = textOf((n.c as unknown[])[1], 120).trim();
  const label = alt ? `[image: ${alt}]` : '[image]';
  const words = label.split(' ');
  const inlines: AstNode[] = [];
  words.forEach((w, i) => {
    if (i) inlines.push({ t: 'Space' });
    inlines.push({ t: 'Str', c: w });
  });
  (n as AstNode).t = 'Emph';
  n.c = inlines;
}

/* ---------------------------------------------------------- plain text AST */

/**
 * Build a pandoc AST from plain text without interpreting any markup: blank
 * lines separate paragraphs, line breaks inside a paragraph are kept, and
 * whitespace-significant blocks (indented code, ASCII tables) become code blocks.
 */
export function textToAst(text: string, apiVersion: number[]): PandocAst {
  const blocks: AstNode[] = [];
  for (const lines of paragraphsOf(text)) {
    if (isPreformatted(lines)) {
      blocks.push({ t: 'CodeBlock', c: [['', [], []], lines.map((l) => l.replace(/\s+$/, '').replace(/\t/g, '    ')).join('\n')] });
      continue;
    }
    const inlines: AstNode[] = [];
    lines.forEach((line, li) => {
      if (li) inlines.push({ t: 'LineBreak' });
      const words = line.split(/[ \t]+/).filter(Boolean);
      words.forEach((w, wi) => {
        if (wi) inlines.push({ t: 'Space' });
        inlines.push({ t: 'Str', c: w });
      });
    });
    blocks.push({ t: 'Para', c: inlines });
  }
  return { 'pandoc-api-version': apiVersion, meta: {}, blocks };
}

export function hasTitle(ast: PandocAst): boolean {
  return 'title' in ast.meta;
}

/* ------------------------------------------------------------ sanitising */

const KEEP_ATTRS = new Set(['width', 'height', 'lang', 'dir', 'custom-style']);

const isAttr = (a: unknown): a is [string, string[], [string, string][]] =>
  Array.isArray(a) &&
  a.length === 3 &&
  typeof a[0] === 'string' &&
  Array.isArray(a[1]) &&
  a[1].every((x) => typeof x === 'string') &&
  Array.isArray(a[2]) &&
  a[2].every((kv) => Array.isArray(kv) && kv.length === 2 && typeof kv[0] === 'string' && typeof kv[1] === 'string');

/** Tags and handlers that can run code or load active content when the HTML is rendered. */
const ACTIVE_HTML = /<\s*(?:script|iframe|frame|object|embed|applet|link|meta|base|form|style|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:/i;
const BAD_URL = /^\s*(?:javascript|vbscript|data:(?!image\/))/i;

/**
 * Defence in depth for hostile documents, applied to the AST before any writer
 * sees it: keep only inert attributes (no style, no event handlers), drop raw
 * HTML that could run code, and neutralise script-bearing link targets.
 */
export function sanitizeAst(ast: PandocAst): void {
  const stack: unknown[] = [ast.blocks, ast.meta];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      if (isAttr(v)) v[2] = v[2].filter(([k]) => KEEP_ATTRS.has(k));
      for (const x of v) if (typeof x === 'object' && x !== null) stack.push(x);
    } else if (typeof v === 'object' && v !== null) {
      const n = v as AstNode;
      if (typeof n.t === 'string' && Array.isArray(n.c)) {
        const c = n.c as unknown[];
        if ((n.t === 'RawBlock' || n.t === 'RawInline') && typeof c[0] === 'string' && /^html/i.test(c[0]) && ACTIVE_HTML.test(String(c[1]))) {
          c[0] = 'removed';
        } else if ((n.t === 'Link' || n.t === 'Image') && Array.isArray(c[2]) && typeof c[2][0] === 'string' && BAD_URL.test(c[2][0])) {
          c[2][0] = '#';
        }
      }
      for (const x of Object.values(v)) if (typeof x === 'object' && x !== null) stack.push(x);
    }
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
};

/** Decode an `data:image/...` URL into bytes, or undefined when it is not one we handle. */
export function decodeDataImage(url: string, maxBytes: number): { bytes: Uint8Array; ext: string } | undefined {
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9=._-]+)*?)(;base64)?,/i.exec(url);
  if (!m) return undefined;
  const ext = MIME_EXT[m[1]!.toLowerCase()];
  if (!ext) return undefined;
  const payload = url.slice(m[0].length);
  if (payload.length > maxBytes * 1.4) throw new Error('An embedded image is larger than this tool will convert.');
  try {
    if (m[3]) {
      const bin = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, ext };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), ext };
  } catch {
    return undefined;
  }
}
