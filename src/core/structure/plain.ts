import type { Ctx } from './util';
import { bucketSegments, countWords, encodingOf, fmtN, isBlankLine, lineStarts, readText, tailBeyond } from './text';

export async function parseTxt(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  const starts = lineStarts(b);
  // Paragraphs are runs of non-blank lines; blank lines stay attached to the paragraph before them.
  const paraStarts: number[] = [];
  let inPara = false;
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : b.length;
    const blank = isBlankLine(b, from, to);
    if (!blank && !inPara) {
      paraStarts.push(paraStarts.length === 0 ? 0 : from);
      inPara = true;
    } else if (blank) inPara = false;
  }
  const words = countWords(b, 0, b.length);
  const enc = encodingOf(b);
  let segs;
  let unit: string;
  if (paraStarts.length >= 2) {
    unit = 'paragraph';
    segs = bucketSegments(paraStarts, b.length, 64, 'paragraph', 'text', (_i0, _i1, from, to) => {
      let lines = 0;
      for (let k = 0; k < starts.length; k++) if (starts[k]! >= from && starts[k]! < to) lines++;
      return `${fmtN(lines)} line${lines === 1 ? '' : 's'} · ${fmtN(countWords(b, from, to))} words`;
    });
  } else {
    unit = 'line';
    segs = bucketSegments(starts, b.length, 64, 'line', 'text', (i0, i1, from, to) => `${fmtN(i1 - i0)} line${i1 - i0 === 1 ? '' : 's'} · ${fmtN(countWords(b, from, to))} words`);
  }
  // Bucketed detail scans lines per bucket; keep it linear for big files.
  ctx.out.push(...segs);
  tailBeyond(ctx, b.length);
  const paras = paraStarts.length;
  ctx.summary = `Plain text · ${fmtN(starts.length)} line${starts.length === 1 ? '' : 's'} · ${fmtN(words)} words${unit === 'paragraph' ? ` · ${fmtN(paras)} paragraphs` : ''} · ${enc}`;
}
