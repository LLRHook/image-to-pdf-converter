import type { Segment } from './types';
import { type Ctx, seg } from './util';
import { decode, encodingOf, fmtN, groups, lineStarts, readText, tailBeyond } from './text';

const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#\-?:&*!|>'"%@`{}[\],][^:#]*?|[-?][^\s:][^:#]*?)):(?:[ \t]|$)/;

interface Entry {
  start: number; // line index
  name: string;
  kind: 'key' | 'item';
}

export async function parseYaml(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  const starts = lineStarts(b);
  const n = starts.length;
  const lineEnd = (i: number): number => (i + 1 < n ? starts[i + 1]! : b.length);
  const raw = (i: number): string => {
    let s = '';
    const to = Math.min(lineEnd(i), starts[i]! + 300);
    for (let k = starts[i]!; k < to; k++) s += String.fromCharCode(b[k] ?? 0);
    return s.replace(/[\r\n]+$/, '');
  };

  // Documents separated by '---' (and optionally closed by '...').
  const docStarts: number[] = [];
  for (let i = 0; i < n; i++) if (/^---(\s|$)/.test(raw(i).replace(/^�|^\xEF\xBB\xBF/, ''))) docStarts.push(i);
  const multi = docStarts.length > 1;

  const parseRange = (l0: number, l1: number): Segment[] => {
    const entries: Entry[] = [];
    for (let i = l0; i < l1; i++) {
      const t = raw(i);
      if (t === '' || /^\s/.test(t) || t.startsWith('#') || /^(---|\.\.\.)(\s|$)/.test(t) || t.startsWith('%')) continue;
      if (/^-(\s|$)/.test(t)) {
        entries.push({ start: i, name: 'item', kind: 'item' });
        continue;
      }
      const m = KEY.exec(t);
      if (m) entries.push({ start: i, name: (m[1] ?? m[2] ?? m[3] ?? '').trim(), kind: 'key' });
    }
    const out: Segment[] = [];
    if (!entries.length) {
      const from = starts[l0]!;
      const to = l1 < n ? starts[l1]! : b.length;
      if (to > from) out.push(seg('flow or scalar content', 'records', from, to - from, decode(b, from, to, 50)));
      return out;
    }
    // Pull each entry's start back over directly attached full-line comments.
    const begin = entries.map((e) => {
      let s = e.start;
      while (s - 1 >= l0 && raw(s - 1).startsWith('#')) s--;
      return s;
    });
    // Preamble before the first entry
    const firstFrom = starts[l0]!;
    const firstEntryStart = starts[begin[0]!]!;
    if (firstEntryStart > firstFrom) out.push(seg('preamble', 'metadata', firstFrom, firstEntryStart - firstFrom, 'directives / comments'));
    const segs: Segment[] = [];
    let itemNo = 0;
    const describeEntry = (i: number): string => {
      const e = entries[i]!;
      const from = e.start;
      const to = i + 1 < entries.length ? begin[i + 1]! : l1;
      const t = raw(from);
      let inline = '';
      if (e.kind === 'key') {
        const m = KEY.exec(t);
        inline = m ? t.slice(m[0].length).replace(/\s+#.*$/, '').trim() : '';
      } else inline = t.slice(1).trim();
      if (inline && !/^[|>][-+0-9]*$/.test(inline)) return inline.length > 50 ? inline.slice(0, 49) + '…' : inline;
      if (/^[|>]/.test(inline)) return `block scalar · ${fmtN(to - from - 1)} lines`;
      // Nested content: find the first indented content line
      let k = from + 1;
      while (k < to && (raw(k) === '' || /^\s*#/.test(raw(k)))) k++;
      if (k >= to) return e.kind === 'key' ? 'null / empty' : 'empty';
      const lt = raw(k);
      const indent = lt.length - lt.trimStart().length;
      if (/^\s*-(\s|$)/.test(lt)) {
        let cnt = 0;
        const itemRe = new RegExp(`^ {${indent}}-(\\s|$)`);
        for (let q = k; q < to; q++) if (itemRe.test(raw(q))) cnt++;
        return `sequence · ${fmtN(cnt)} item${cnt === 1 ? '' : 's'}`;
      }
      let cnt = 0;
      for (let q = k; q < to; q++) {
        const tt = raw(q);
        if (tt.length - tt.trimStart().length === indent && KEY.test(tt.trimStart())) cnt++;
      }
      return `mapping · ${fmtN(cnt)} key${cnt === 1 ? '' : 's'}`;
    };
    const per = groups(entries.length, 500);
    for (const [g0, g1] of per) {
      const from = starts[g0 === 0 ? begin[0]! : begin[g0]!]!;
      const to = g1 < entries.length ? starts[begin[g1]!]! : l1 < n ? starts[l1]! : b.length;
      const cnt = g1 - g0;
      if (cnt === 1) {
        const e = entries[g0]!;
        segs.push(seg(e.kind === 'key' ? e.name || '""' : `item ${++itemNo}`, 'records', from, to - from, describeEntry(g0)));
      } else {
        itemNo += entries.slice(g0, g1).filter((e) => e.kind === 'item').length;
        const isKeys = entries[g0]!.kind === 'key';
        segs.push(seg(isKeys ? `keys ${entries[g0]!.name} … ${entries[g1 - 1]!.name}` : `items ${g0 + 1}–${g1}`, 'records', from, to - from, `${fmtN(cnt)} ${isKeys ? 'keys' : 'items'}`, { count: cnt }));
      }
    }
    return [...out, ...segs];
  };

  const out = ctx.out;
  if (multi) {
    const bounds = docStarts.map((d, k) => [d, k + 1 < docStarts.length ? docStarts[k + 1]! : n] as const);
    if (docStarts[0]! > 0) {
      const from = 0;
      const to = starts[docStarts[0]!]!;
      if (to > from) out.push(seg('preamble', 'metadata', from, to - from, 'directives / comments'));
    }
    bounds.forEach(([a, z], k) => {
      const from = starts[a]!;
      const to = z < n ? starts[z]! : b.length;
      const kids = parseRange(a + 1, z);
      out.push(seg(`document ${k + 1}`, 'container', from, to - from, `${fmtN(z - a)} lines`, { children: kids }));
    });
  } else {
    out.push(...parseRange(0, n));
  }
  tailBeyond(ctx, b.length);
  const docs = Math.max(1, docStarts.length);
  const top = out.reduce((a, s) => a + (s.count ?? 1), 0);
  ctx.summary = `YAML · ${fmtN(docs)} document${docs === 1 ? '' : 's'} · ${fmtN(n)} lines · ${multi ? '' : `${fmtN(top)} top-level entries · `}${encodingOf(b)}`;
}
