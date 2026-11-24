import type { Segment, SegmentRole } from './types';
import { type Ctx, seg, utf8 } from './util';
import { bomLength, decode, encodingOf, fmtN, readText, tailBeyond } from './text';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'command', 'keygen', 'basefont', 'frame']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
/** open-tag → names it implicitly closes when they are the innermost open element (HTML only). */
const IMPLIED: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  thead: ['tbody', 'tfoot'],
  tbody: ['thead', 'tbody', 'tfoot'],
  tfoot: ['thead', 'tbody'],
  p: ['p'],
};
const CLOSES_P = new Set(['div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'form', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'blockquote', 'hr', 'fieldset', 'dl']);

const isNameChar = (c: number): boolean => (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 95 || c >= 128;
const isWs = (c: number | undefined): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

interface Node {
  name: string;
  start: number;
  openEnd: number;
  level: number;
  kids: Segment[];
  childCount: number;
  lastEnd: number;
}

function roleFor(kind: 'svg' | 'html' | 'xml', name: string, hasKids: boolean): SegmentRole {
  const n = name.toLowerCase();
  if (kind === 'svg') {
    if (n === 'defs' || n === 'style') return 'style';
    if (n === 'metadata' || n === 'title' || n === 'desc') return 'metadata';
    if (n === 'image') return 'media';
    if (n === 'lineargradient' || n === 'radialgradient' || n === 'pattern' || n === 'stop') return 'palette';
    if (n === 'text' || n === 'tspan') return 'text';
    return hasKids ? 'container' : 'records';
  }
  if (kind === 'html') {
    if (n === 'head') return 'header';
    if (n === 'title' || n === 'meta' || n === 'base') return 'metadata';
    if (n === 'style' || n === 'link') return 'style';
    if (n === 'script' || n === 'noscript') return 'records';
    if (['img', 'picture', 'video', 'audio', 'svg', 'canvas', 'iframe', 'embed', 'object', 'source'].includes(n)) return 'media';
    if (['html', 'body', 'div', 'section', 'article', 'main', 'nav', 'aside', 'header', 'footer', 'ul', 'ol', 'table', 'form', 'dl', 'figure'].includes(n)) return hasKids ? 'container' : 'text';
    if (['table', 'tr', 'td', 'th', 'tbody', 'thead'].includes(n)) return 'records';
    return 'text';
  }
  return hasKids ? 'container' : 'records';
}

function nameOf(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) {
    const c = b[i]!;
    if (c >= 128) return utf8(b.subarray(from, to));
    s += String.fromCharCode(c);
  }
  return s;
}

function attr(openTag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(openTag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Parse XML/SVG/HTML into a segment tree whose offsets are real UTF-8 byte offsets. */
export async function parseMarkup(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  const n = b.length;
  if (n === 0) return;
  const fmt = ctx.format === 'html' ? 'html' : ctx.format === 'svg' ? 'svg' : 'xml';
  const html = fmt === 'html';
  const top: Segment[] = [];
  const stack: Node[] = [];
  let elements = 0;
  let scripts = 0;
  let images = 0;
  let links = 0;
  let title = '';
  let rootName = '';
  let rootOpen = '';
  let sawRoot = false;

  const tagText = (from: number, to: number): string => utf8(b.subarray(from, Math.min(to, from + 1500)));

  const append = (list: Segment[], s: Segment): void => {
    // Whitespace between siblings is absorbed into the previous sibling; real text becomes its own segment.
    const last = list[list.length - 1];
    if (last && s.offset > last.offset + last.length) {
      const gs = last.offset + last.length;
      let ws = true;
      for (let i = gs; i < s.offset; i++)
        if (!isWs(b[i])) {
          ws = false;
          break;
        }
      if (ws) last.length = s.offset - last.offset;
      else {
        const t = seg('text', 'text', gs, s.offset - gs);
        const prevText = list[list.length - 1];
        if (prevText && prevText.name === 'text' && prevText.offset + prevText.length === t.offset) prevText.length += t.length;
        else list.push(t);
      }
    }
    const l = list[list.length - 1];
    if (l && l.name === s.name && l.role === s.role && l.offset + l.length === s.offset) {
      l.length += s.length;
      l.count = (l.count ?? 1) + (s.count ?? 1);
      delete l.children;
      l.detail = undefined;
    } else list.push(s);
  };

  const finishNode = (node: Node, end: number): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.childCount++;
    elements++;
    if (node.level === 0 && !sawRoot) {
      sawRoot = true;
      rootName = node.name;
      rootOpen = tagText(node.start, node.openEnd);
    }
    if (node.level > 4) return; // deeper levels are counted but not materialised
    const hasKids = node.childCount > 0;
    const open = tagText(node.start, node.openEnd);
    const id = attr(open, 'id');
    const cls = attr(open, 'class');
    const bits: string[] = [];
    if (id) bits.push(`id="${id.slice(0, 30)}"`);
    else if (cls) bits.push(`class="${cls.slice(0, 30)}"`);
    if (hasKids) bits.push(`${fmtN(node.childCount)} child element${node.childCount === 1 ? '' : 's'}`);
    let detail: string | undefined = bits.join(' · ') || undefined;
    if (fmt === 'html' && node.name === 'title') {
      title = decode(b, node.openEnd, end - (node.name.length + 3), 80);
      detail = title;
    }
    const s = seg(node.name, roleFor(fmt, node.name, hasKids), node.start, Math.max(1, end - node.start), detail, { children: node.kids });
    append(parent ? parent.kids : top, s);
  };

  const closeTop = (end: number): void => {
    const node = stack.pop()!;
    finishNode(node, end);
  };

  const pushTop = (s: Segment): void => {
    const parent = stack[stack.length - 1];
    if (parent) {
      if (parent.level + 1 <= 4) append(parent.kids, s);
    } else append(top, s);
  };

  let i = bomLength(b) === 3 ? 3 : 0;
  let stopped = -1;
  while (i < n) {
    const c = b[i]!;
    if (c !== 0x3c) {
      // text run
      const next = b.indexOf(0x3c, i);
      const e = next < 0 ? n : next;
      let hasText = false;
      for (let k = i; k < e; k++)
        if (!isWs(b[k])) {
          hasText = true;
          break;
        }
      if (hasText && stack.length === 0 && top.length === 0 && i < 4) {
        /* leading text before any markup: ignore */
      }
      i = e;
      continue;
    }
    const c1 = b[i + 1];
    // comment
    if (c1 === 0x21 && b[i + 2] === 0x2d && b[i + 3] === 0x2d) {
      const e = indexOfSeq(b, [0x2d, 0x2d, 0x3e], i + 4);
      const end = e < 0 ? n : e + 3;
      if (stack.length < 2) pushTop(seg('comment', 'metadata', i, end - i, decode(b, i + 4, end - 3, 50) || undefined));
      i = end;
      continue;
    }
    // CDATA
    if (c1 === 0x21 && b[i + 2] === 0x5b) {
      const e = indexOfSeq(b, [0x5d, 0x5d, 0x3e], i + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // PI / XML declaration
    if (c1 === 0x3f) {
      const e = indexOfSeq(b, [0x3f, 0x3e], i + 2);
      const end = e < 0 ? n : e + 2;
      if (stack.length === 0) pushTop(seg(i === bomLength(b) ? 'XML declaration' : 'processing instruction', 'header', i, end - i, decode(b, i + 2, end - 2, 70)));
      i = end;
      continue;
    }
    // DOCTYPE and other declarations
    if (c1 === 0x21) {
      let k = i + 2;
      let bracket = 0;
      let q = 0;
      while (k < n) {
        const d = b[k]!;
        if (q) {
          if (d === q) q = 0;
        } else if (d === 0x22 || d === 0x27) q = d;
        else if (d === 0x5b) bracket++;
        else if (d === 0x5d) bracket--;
        else if (d === 0x3e && bracket <= 0) break;
        k++;
      }
      const end = Math.min(n, k + 1);
      if (stack.length === 0) pushTop(seg('DOCTYPE', 'header', i, end - i, decode(b, i + 2, end - 1, 70)));
      i = end;
      continue;
    }
    // closing tag
    if (c1 === 0x2f) {
      let k = i + 2;
      while (k < n && isNameChar(b[k]!)) k++;
      const name = nameOf(b, i + 2, k);
      const gt = b.indexOf(0x3e, k);
      const end = gt < 0 ? n : gt + 1;
      const key = html ? name.toLowerCase() : name;
      let at = -1;
      // Real documents mismatch only shallowly; bounding the search keeps stray closers cheap.
      for (let s = stack.length - 1; s >= 0 && s >= stack.length - 256; s--) {
        if (stack[s]!.name === key) {
          at = s;
          break;
        }
      }
      if (at >= 0) {
        while (stack.length - 1 > at) closeTop(i);
        closeTop(end);
      }
      i = end;
      continue;
    }
    // opening tag
    if (c1 !== undefined && ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122) || c1 === 95 || c1 === 58 || c1 >= 128)) {
      let k = i + 1;
      while (k < n && isNameChar(b[k]!)) k++;
      const rawName = nameOf(b, i + 1, k);
      const name = html ? rawName.toLowerCase() : rawName;
      // find '>' honouring quotes
      let q = 0;
      let e = k;
      while (e < n) {
        const d = b[e]!;
        if (q) {
          if (d === q) q = 0;
        } else if (d === 0x22 || d === 0x27) q = d;
        else if (d === 0x3e) break;
        e++;
      }
      const openEnd = Math.min(n, e + 1);
      const selfClose = b[e - 1] === 0x2f;
      if (html) {
        const closes = IMPLIED[name];
        if (closes) while (stack.length && closes.includes(stack[stack.length - 1]!.name)) closeTop(i);
        if (CLOSES_P.has(name)) while (stack.length && stack[stack.length - 1]!.name === 'p') closeTop(i);
      }
      if (name === 'script' || (html && name === 'iframe')) scripts += name === 'script' ? 1 : 0;
      if (name === 'img' || name === 'image') images++;
      if (name === 'a' || name === 'link') links++;
      const node: Node = { name, start: i, openEnd, level: stack.length, kids: [], childCount: 0, lastEnd: openEnd };
      if (stack.length > 20_000) {
        stopped = i;
        break;
      }
      if (selfClose || (html && VOID.has(name))) {
        stack.push(node);
        closeTop(openEnd);
        i = openEnd;
        continue;
      }
      stack.push(node);
      if (html && RAW.has(name)) {
        // raw text: skip to the matching close tag (case-insensitive)
        const lower = `</${name}`;
        let found = -1;
        for (let p = openEnd; p < n; ) {
          const lt = b.indexOf(0x3c, p);
          if (lt < 0) break;
          let ok = b[lt + 1] === 0x2f;
          for (let t = 2; ok && t < lower.length; t++) {
            const ch = b[lt + t] ?? 0;
            if ((ch >= 65 && ch <= 90 ? ch + 32 : ch) !== lower.charCodeAt(t)) ok = false;
          }
          if (ok) {
            found = lt;
            break;
          }
          p = lt + 1;
        }
        if (found >= 0) {
          const gt = b.indexOf(0x3e, found);
          const end = gt < 0 ? n : gt + 1;
          closeTop(end);
          i = end;
        } else {
          i = n;
        }
        continue;
      }
      i = openEnd;
      continue;
    }
    i++; // stray '<'
  }
  while (stack.length) closeTop(stopped >= 0 ? stopped : n);

  // The document element becomes a 'container' whose children are its child elements.
  for (const s of top) {
    if (s.role !== 'container' && s.children?.length) s.role = 'container';
  }
  // Trailing whitespace/comments after the last element belong to it.
  const lastTop = top[top.length - 1];
  if (lastTop && lastTop.offset + lastTop.length < n) {
    let tailWs = true;
    for (let k = lastTop.offset + lastTop.length; k < n; k++)
      if (!isWs(b[k])) {
        tailWs = false;
        break;
      }
    if (tailWs) lastTop.length = n - lastTop.offset;
  }
  ctx.out.push(...top);
  if (ctx.out.length === 0) ctx.out.push(seg('text', 'text', 0, n, 'no markup found'));
  tailBeyond(ctx, n);

  const enc = encodingOf(b);
  if (fmt === 'svg') {
    const w = attr(rootOpen, 'width');
    const h = attr(rootOpen, 'height');
    const vb = attr(rootOpen, 'viewBox');
    ctx.summary = `SVG${w && h ? ` ${w}×${h}` : ''}${vb ? ` · viewBox ${vb}` : ''} · ${fmtN(elements)} elements${images ? ` · ${images} image${images === 1 ? '' : 's'}` : ''} · ${enc}`;
    const rootSeg = top.find((s) => s.name.toLowerCase() === 'svg');
    if (rootSeg && !rootSeg.detail) rootSeg.detail = `${w && h ? `${w}×${h}` : ''}${vb ? ` · viewBox ${vb}` : ''}`.replace(/^ · /, '') || undefined;
    else if (rootSeg && (w || vb)) rootSeg.detail = `${w && h ? `${w}×${h} · ` : ''}${vb ? `viewBox ${vb} · ` : ''}${rootSeg.detail}`;
  } else if (fmt === 'html') {
    ctx.summary = `HTML${title ? ` "${title}"` : ''} · ${fmtN(elements)} elements${scripts ? ` · ${scripts} script${scripts === 1 ? '' : 's'}` : ''}${images ? ` · ${images} image${images === 1 ? '' : 's'}` : ''}${links ? ` · ${links} link${links === 1 ? '' : 's'}` : ''} · ${enc}`;
  } else {
    ctx.summary = `XML${rootName ? ` <${rootName}>` : ''} · ${fmtN(elements)} elements · ${enc}`;
  }
}

function indexOfSeq(b: Uint8Array, seq: number[], from: number): number {
  const first = seq[0]!;
  let i = from;
  while (i < b.length) {
    i = b.indexOf(first, i);
    if (i < 0) return -1;
    let ok = true;
    for (let k = 1; k < seq.length; k++)
      if (b[i + k] !== seq[k]) {
        ok = false;
        break;
      }
    if (ok) return i;
    i++;
  }
  return -1;
}
