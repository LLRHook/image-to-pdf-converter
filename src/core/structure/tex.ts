import type { Segment } from './types';
import { type Ctx, pushMerged, seg } from './util';
import { buildSections, decode, encodingOf, fmtN, lineStarts, readText, tailBeyond, type Heading } from './text';

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

/** The line without any unescaped % comment, as ASCII-ish text. */
function stripComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '%') return s.slice(0, i);
  }
  return s;
}

export async function parseTex(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  const starts = lineStarts(b);
  const lineEnd = (i: number): number => (i + 1 < starts.length ? starts[i + 1]! : b.length);
  const text = (i: number): string => {
    let s = '';
    const to = Math.min(lineEnd(i), starts[i]! + 500);
    for (let k = starts[i]!; k < to; k++) s += String.fromCharCode(b[k] ?? 0);
    return stripComment(s);
  };

  let beginLine = -1;
  let endLine = -1;
  for (let i = 0; i < starts.length; i++) {
    const t = text(i);
    if (beginLine < 0 && /\\begin\s*\{document\}/.test(t)) beginLine = i;
    else if (beginLine >= 0 && /\\end\s*\{document\}/.test(t)) endLine = i;
  }
  const out = ctx.out;
  const bodyFrom = beginLine >= 0 ? starts[beginLine]! : 0;

  // Preamble
  if (beginLine > 0) {
    const kids: Segment[] = [];
    let pkgs = 0;
    for (let i = 0; i < beginLine; i++) {
      const t = text(i).trim();
      const from = starts[i]!;
      const len = lineEnd(i) - from;
      let name = 'preamble';
      let role: Segment['role'] = 'records';
      let detail: string | undefined;
      if (t === '') {
        name = 'blank / comments';
        role = 'padding';
      } else if (/^\\documentclass/.test(t)) {
        name = 'documentclass';
        role = 'header';
        detail = t.slice(0, 80);
      } else if (/^\\(usepackage|RequirePackage)/.test(t)) {
        name = 'usepackage';
        role = 'style';
        pkgs++;
      } else if (/^\\(newcommand|renewcommand|providecommand|def|let|newenvironment|renewenvironment|DeclareMathOperator|newtheorem|setlength|geometry|setcounter|newcounter|theoremstyle)/.test(t)) {
        name = 'definitions';
        role = 'style';
      } else if (/^\\(title|author|date|thanks|address|email)/.test(t)) {
        name = 'title block';
        role = 'metadata';
        detail = decode(b, from, from + len, 60);
      }
      pushMerged(kids, seg(name, role, from, len, detail));
    }
    for (const k of kids) {
      if (k.count && k.count > 1) k.detail = `${k.count} lines`;
    }
    out.push(seg('preamble', 'container', 0, bodyFrom, `${fmtN(beginLine)} lines · ${pkgs} package${pkgs === 1 ? '' : 's'}`, { children: kids }));
  }

  // Body
  const bodyEndOffset = endLine >= 0 ? lineEnd(endLine) : b.length;
  const heads: Heading[] = [];
  for (let i = beginLine >= 0 ? beginLine + 1 : 0; i < (endLine >= 0 ? endLine : starts.length); i++) {
    const m = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(text(i));
    if (!m) continue;
    const level = LEVELS[m[1]!]!;
    const from = starts[i]!;
    const afterBrace = from + (m.index ?? 0) + m[0].length;
    heads.push({ level, start: from, name: `\\${m[1]}{${decode(b, afterBrace, lineEnd(i), 60).replace(/\}.*$/, '')}}` });
  }
  // Binary search keeps per-section line counts O(log n) even with tens of thousands of sections.
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const bodyKids = buildSections(heads, endLine >= 0 ? starts[endLine]! : b.length, 'text', (f, t, kids) => `${fmtN(lineAt(t) - lineAt(f))} lines${kids ? ` · ${kids} subsection${kids === 1 ? '' : 's'}` : ''}`);
  const bodyStartOffset = bodyFrom;
  const bodyLen = bodyEndOffset - bodyStartOffset;
  const firstHead = heads[0];
  const kids: Segment[] = [];
  const innerStart = beginLine >= 0 ? lineEnd(beginLine) : 0;
  if (firstHead && firstHead.start > innerStart) kids.push(seg('introduction', 'text', innerStart, firstHead.start - innerStart, 'before the first sectioning command'));
  kids.push(...bodyKids);
  if (bodyLen > 0) {
    if (beginLine >= 0) out.push(seg('document', 'container', bodyStartOffset, bodyLen, `\\begin{document} … \\end{document} · ${heads.length} sectioning command${heads.length === 1 ? '' : 's'}`, { children: kids }));
    else out.push(...kids.length ? kids : [seg('body', 'text', 0, b.length, `${fmtN(starts.length)} lines`)]);
  }
  if (bodyEndOffset < b.length) out.push(seg('after \\end{document}', 'trailer', bodyEndOffset, b.length - bodyEndOffset));
  tailBeyond(ctx, b.length);
  ctx.summary = `LaTeX · ${beginLine >= 0 ? 'full document' : 'fragment (no \\begin{document})'} · ${fmtN(starts.length)} lines · ${heads.length} section${heads.length === 1 ? '' : 's'} · ${encodingOf(b)}`;
}
