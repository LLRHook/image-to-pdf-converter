import type { Segment, SegmentRole } from './types';
import { type Ctx, fmtBytes, latin1, pushMerged, seg } from './util';
import { bomLength, decode, encodingOf, fmtN, readText, tailBeyond } from './text';

const HEADER_DEST = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'filetbl', 'themedata', 'colorschememapping', 'latentstyles', 'xmlnstbl', 'mmathPr', 'defchp', 'defpap', 'pgdsctbl', 'expandedcolortbl', 'userprops', 'wgrffmtfilter', 'template', 'protusertbl', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'docvar', 'private', 'datastore', 'xmlopen',
]);
const BODY_START = new Set(['pard', 'plain', 'par', 'sectd', 'trowd', 'intbl', 'line', 'page']);
const DEST_INFO: Record<string, [string, SegmentRole]> = {
  fonttbl: ['font table', 'style'],
  colortbl: ['colour table', 'palette'],
  expandedcolortbl: ['expanded colour table', 'palette'],
  stylesheet: ['stylesheet', 'style'],
  info: ['info', 'metadata'],
  listtable: ['list table', 'style'],
  listoverridetable: ['list overrides', 'style'],
  generator: ['generator', 'metadata'],
  themedata: ['theme data', 'style'],
  latentstyles: ['latent styles', 'style'],
};

interface Item {
  kind: 'group' | 'ctl' | 'text';
  start: number;
  end: number;
  name: string;
}

export async function parseRtf(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  const n = b.length;
  let i = bomLength(b) === 3 ? 3 : 0;
  while (i < n && (b[i] === 32 || b[i] === 10 || b[i] === 13 || b[i] === 9)) i++;
  if (!(b[i] === 0x7b && b[i + 1] === 0x5c && b[i + 2] === 0x72 && b[i + 3] === 0x74 && b[i + 4] === 0x66)) return;
  const rootStart = i;
  const items: Item[] = [];
  const stack: number[] = [rootStart];
  const names: string[] = [''];
  let rootEnd = -1;
  let pars = 0;
  const picts: Array<{ start: number; end: number }> = [];
  const pictStack: number[] = [];
  let bodyFrom = -1;
  let p = rootStart + 1;

  const readWord = (at: number): { name: string; end: number; param: number | undefined } => {
    let k = at + 1;
    const s = k;
    while (k < n && ((b[k]! >= 65 && b[k]! <= 90) || (b[k]! >= 97 && b[k]! <= 122))) k++;
    const name = latin1(b.subarray(s, k));
    let param: number | undefined;
    let neg = false;
    if (b[k] === 0x2d) {
      neg = true;
      k++;
    }
    const ps = k;
    while (k < n && b[k]! >= 48 && b[k]! <= 57) k++;
    if (k > ps) param = (neg ? -1 : 1) * Number(latin1(b.subarray(ps, Math.min(k, ps + 9))));
    if (b[k] === 0x20) k++;
    return { name, end: k, param };
  };

  const destOf = (at: number): string => {
    // at points just after '{'
    let k = at;
    if (b[k] === 0x5c && b[k + 1] === 0x2a) k += 2;
    if (b[k] === 0x5c) {
      const w = readWord(k);
      return w.name;
    }
    return '';
  };

  while (p < n) {
    const c = b[p]!;
    const depth = stack.length;
    if (c === 0x5c) {
      const nx = b[p + 1];
      if (nx !== undefined && ((nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122))) {
        const w = readWord(p);
        if (w.name === 'par') pars++;
        if (w.name === 'bin' && w.param && w.param > 0) {
          if (depth === 1) items.push({ kind: 'ctl', start: p, end: Math.min(n, w.end + w.param), name: 'bin' });
          p = Math.min(n, w.end + w.param);
          continue;
        }
        if (depth === 1) items.push({ kind: 'ctl', start: p, end: w.end, name: w.name });
        p = w.end;
        continue;
      }
      // escapes: \'hh \{ \} \\ \~ \- \_ \* \| \: etc. (a backslash before a line break is \par)
      if (nx === 10 || nx === 13) pars++;
      const len = nx === 0x27 ? 4 : 2;
      if (depth === 1) {
        const last = items[items.length - 1];
        if (last && last.kind === 'text' && last.end === p) last.end = Math.min(n, p + len);
        else items.push({ kind: 'text', start: p, end: Math.min(n, p + len), name: '' });
      }
      p += len;
      continue;
    }
    if (c === 0x7b) {
      const dest = destOf(p + 1);
      stack.push(p);
      names.push(dest);
      if (dest === 'pict') pictStack.push(p);
      p++;
      continue;
    }
    if (c === 0x7d) {
      const start = stack.pop()!;
      const dest = names.pop()!;
      if (dest === 'pict' && pictStack.length && pictStack[pictStack.length - 1] === start) {
        pictStack.pop();
        if (picts.length < 200) picts.push({ start, end: p + 1 });
      }
      if (stack.length === 1) items.push({ kind: 'group', start, end: p + 1, name: dest });
      if (stack.length === 0) {
        rootEnd = p;
        break;
      }
      p++;
      continue;
    }
    if (c === 10 || c === 13) {
      p++;
      continue;
    }
    if (depth === 1) {
      const last = items[items.length - 1];
      if (last && last.kind === 'text' && last.end >= p - 2) last.end = p + 1;
      else items.push({ kind: 'text', start: p, end: p + 1, name: '' });
    }
    p++;
  }

  // Where does the body begin?
  for (const it of items) {
    if (it.kind === 'text' && latin1(b.subarray(it.start, it.end)).trim() === '') continue;
    if ((it.kind === 'ctl' && BODY_START.has(it.name)) || it.kind === 'text' || (it.kind === 'group' && !HEADER_DEST.has(it.name))) {
      bodyFrom = it.start;
      break;
    }
  }
  const closeAt = rootEnd >= 0 ? rootEnd : n;
  if (bodyFrom < 0) bodyFrom = closeAt;

  const out = ctx.out;
  const headerEnd = bodyFrom;
  let cursor = 0;
  const header = (to: number): void => {
    if (to > cursor) {
      let blank = true;
      for (let k = cursor; k < to; k++) {
        const ch = b[k];
        if (ch !== 10 && ch !== 13 && ch !== 32 && ch !== 9) {
          blank = false;
          break;
        }
      }
      const last = out[out.length - 1];
      if (blank && last && last.offset + last.length === cursor) last.length += to - cursor;
      else pushMerged(out, seg('header', 'header', cursor, to - cursor, undefined));
    }
    cursor = Math.max(cursor, to);
  };
  let groupsInHeader = 0;
  for (const it of items) {
    if (it.start >= headerEnd) break;
    if (it.kind !== 'group') continue;
    header(it.start);
    groupsInHeader++;
    const txt = latin1(b.subarray(it.start, Math.min(it.end, it.start + 6000)));
    const info = DEST_INFO[it.name];
    let name = info?.[0] ?? (it.name ? `\\${it.name}` : 'group');
    const role = info?.[1] ?? 'metadata';
    let detail: string | undefined;
    if (it.name === 'fonttbl') {
      const fonts = [...txt.matchAll(/\\f\d+(?:\\[a-z]+-?\d*)*\s*([^;{}\\]+);/g)].map((m) => m[1]!.trim());
      const count = (txt.match(/\\f\d+/g) ?? []).length;
      detail = `${count} font${count === 1 ? '' : 's'}${fonts.length ? ': ' + fonts.slice(0, 4).join(', ') : ''}`;
    } else if (it.name === 'colortbl' || it.name === 'expandedcolortbl') {
      const count = (txt.match(/;/g) ?? []).length;
      detail = `${count} entr${count === 1 ? 'y' : 'ies'}`;
    } else if (it.name === 'stylesheet') {
      const count = (txt.match(/\\s\d+/g) ?? []).length;
      detail = `${count} paragraph style${count === 1 ? '' : 's'}`;
    } else if (it.name === 'info') {
      const bits = ['title', 'author', 'company', 'subject'].map((k) => new RegExp(`\\{\\\\${k}\\s+([^}]*)\\}`).exec(txt)?.[1]?.trim()).filter(Boolean);
      detail = bits.join(' · ') || 'document properties';
    } else if (it.name === 'generator') {
      detail = decode(b, it.start, it.end, 60).replace(/^\{\\\*\\generator\s*/, '');
    } else if (it.name === 'listtable') {
      detail = `${(txt.match(/\\list\b/g) ?? []).length} lists`;
    }
    if (!info && it.name === '') name = 'group';
    out.push(seg(name, role, it.start, it.end - it.start, detail));
    cursor = it.end;
  }
  header(headerEnd);
  if (closeAt > bodyFrom) {
    const kids: Segment[] = picts
      .filter((q) => q.start >= bodyFrom && q.end <= closeAt)
      .map((q) => {
        const head = latin1(b.subarray(q.start, Math.min(q.end, q.start + 200)));
        const fmt = /\\(png|jpeg|emf|wmf|macpict|dibitmap|wbitmap)(?:blip|metafile)?/.exec(head)?.[1] ?? 'unknown';
        const dims = /\\picw(\d+)\\pich(\d+)/.exec(head);
        return seg('picture', 'media', q.start, q.end - q.start, `${fmt}${dims ? ` ${dims[1]}×${dims[2]} (source units)` : ''} · ${fmtBytes(q.end - q.start)}`);
      });
    out.push(seg('body', 'text', bodyFrom, closeAt - bodyFrom, `${fmtN(pars)} paragraph break${pars === 1 ? '' : 's'}${picts.length ? ` · ${picts.length} picture${picts.length === 1 ? '' : 's'}` : ''} · ${fmtBytes(closeAt - bodyFrom)}`, { children: kids }));
  }
  if (rootEnd >= 0) out.push(seg('closing brace', 'trailer', rootEnd, n - rootEnd));
  tailBeyond(ctx, n);
  const ver = /\\rtf(\d+)/.exec(latin1(b.subarray(rootStart, rootStart + 20)))?.[1] ?? '1';
  const cp = /\\ansicpg(\d+)/.exec(latin1(b.subarray(rootStart, rootStart + 400)))?.[1];
  ctx.summary = `RTF ${ver}${cp ? ` · code page ${cp}` : ''} · ${groupsInHeader} header group${groupsInHeader === 1 ? '' : 's'} · ${fmtN(pars)} paragraph breaks · ${encodingOf(b)}`;
}
