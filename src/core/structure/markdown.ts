import { type Ctx, seg } from './util';
import { bomLength, buildSections, countWords, decode, encodingOf, fmtN, isBlankLine, lineStarts, readText, tailBeyond, type Heading } from './text';

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

export async function parseMarkdown(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  const starts = lineStarts(b);
  const lineEnd = (i: number): number => (i + 1 < starts.length ? starts[i + 1]! : b.length);
  const lineText = (i: number): string => {
    let to = lineEnd(i);
    while (to > starts[i]! && (b[to - 1] === 10 || b[to - 1] === 13)) to--;
    // ASCII-compatible decode is enough for markers; titles are decoded separately.
    let s = '';
    for (let k = starts[i]!; k < Math.min(to, starts[i]! + 400); k++) s += String.fromCharCode(b[k] ?? 0);
    return s;
  };

  // YAML front matter
  let first = 0;
  const bom = bomLength(b);
  let fmEnd = -1;
  if (starts.length > 2 && lineText(0).slice(bom).replace(/\s+$/, '') === '---') {
    for (let i = 1; i < Math.min(starts.length, 500); i++) {
      const t = lineText(i).replace(/\s+$/, '');
      if (t === '---' || t === '...') {
        fmEnd = i + 1;
        break;
      }
    }
  }
  const out = ctx.out;
  if (fmEnd > 0) {
    const to = fmEnd < starts.length ? starts[fmEnd]! : b.length;
    out.push(seg('front matter', 'metadata', 0, to, `YAML · ${fmEnd - 2} lines`));
    first = fmEnd;
  }

  const heads: Heading[] = [];
  const fence: number[] = new Array(starts.length + 1).fill(0);
  let inFence = false;
  let fenceChar = '';
  let fences = 0;
  for (let i = first; i < starts.length; i++) {
    const t = lineText(i);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(t);
    if (f) {
      const ch = f[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fences++;
      } else if (ch === fenceChar) inFence = false;
      fence[i + 1] = fences;
      continue;
    }
    fence[i + 1] = fences;
    if (inFence) continue;
    const m = ATX.exec(t);
    if (m) {
      const title = decode(b, starts[i]! + t.indexOf('#') + m[1]!.length, lineEnd(i), 70) || '(untitled)';
      heads.push({ level: m[1]!.length, start: starts[i]!, name: `${m[1]} ${title.replace(/\s+#+$/, '')}` });
      continue;
    }
    // Setext: a text line followed by === or ---
    if (i + 1 < starts.length && !isBlankLine(b, starts[i]!, lineEnd(i))) {
      const u = lineText(i + 1);
      if (/^ {0,3}=+[ \t]*$/.test(u) || /^ {0,3}-{2,}[ \t]*$/.test(u)) {
        const lvl = u.trim()[0] === '=' ? 1 : 2;
        // not a list item / table / hr context
        if (!/^\s*([-*+]\s|\d+[.)]\s|>|\|)/.test(t)) {
          heads.push({ level: lvl, start: starts[i]!, name: `${'#'.repeat(lvl)} ${decode(b, starts[i]!, lineEnd(i), 70)}` });
          fence[i + 2] = fences;
          i++;
        }
      }
    }
  }

  const bodyStart = first > 0 ? (first < starts.length ? starts[first]! : b.length) : 0;
  const firstHead = heads[0];
  if (firstHead && firstHead.start > bodyStart && !isBlankLine(b, bodyStart, firstHead.start)) {
    out.push(seg('preface', 'text', bodyStart, firstHead.start - bodyStart, `${fmtN(countWords(b, bodyStart, firstHead.start))} words before the first heading`));
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const sections = buildSections(heads, b.length, 'text', (from, to, kids) => {
    const l0 = lineAt(from);
    const l1 = lineAt(Math.max(from, to - 1)) + 1;
    const code = Math.ceil(((fence[l1] ?? 0) - (fence[l0] ?? 0)) / 2);
    return `${fmtN(l1 - l0)} lines · ${fmtN(countWords(b, from, to))} words${code > 0 ? ` · ${code} code block${code === 1 ? '' : 's'}` : ''}${kids ? ` · ${kids} subsection${kids === 1 ? '' : 's'}` : ''}`;
  });
  out.push(...sections);
  if (!heads.length && b.length > bodyStart) {
    out.push(seg('body', 'text', bodyStart, b.length - bodyStart, `${fmtN(starts.length - first)} lines · ${fmtN(countWords(b, bodyStart, b.length))} words · no headings`));
  }
  tailBeyond(ctx, b.length);
  ctx.summary = `Markdown · ${fmtN(heads.length)} heading${heads.length === 1 ? '' : 's'} · ${fmtN(starts.length)} lines · ${fmtN(countWords(b, 0, b.length))} words${fences ? ` · ${Math.ceil(fences / 2)} code blocks` : ''}${fmEnd > 0 ? ' · front matter' : ''} · ${encodingOf(b)}`;
}
