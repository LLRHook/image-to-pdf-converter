import type { Segment } from './types';
import { type Ctx, seg } from './util';
import { bomLength, encodingOf, fmtN, groups, readText, tailBeyond } from './text';

/** Quote-aware record scan: row start offsets plus per-row field counts. */
function scanRows(b: Uint8Array, delim: number): { starts: number[]; fields: number[]; minF: number; maxF: number } {
  const starts: number[] = [];
  const fields: number[] = [];
  let i = bomLength(b) === 3 ? 3 : 0;
  const n = b.length;
  let rowStart = 0;
  let f = 1;
  let inQuote = false;
  let fieldStart = true;
  let minF = Infinity;
  let maxF = 0;
  const endRow = (next: number): void => {
    starts.push(rowStart);
    fields.push(f);
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
    rowStart = next;
    f = 1;
    fieldStart = true;
  };
  for (; i < n; i++) {
    const c = b[i]!;
    if (inQuote) {
      if (c === 0x22) {
        if (b[i + 1] === 0x22) i++;
        else inQuote = false;
      }
      continue;
    }
    if (c === 0x22 && fieldStart) {
      inQuote = true;
      fieldStart = false;
    } else if (c === delim) {
      f++;
      fieldStart = true;
    } else if (c === 10 || c === 13) {
      if (c === 13 && b[i + 1] === 10) i++;
      if (i + 1 < n) endRow(i + 1);
      else {
        // final newline: close the row without opening an empty one
        starts.push(rowStart);
        fields.push(f);
        if (f < minF) minF = f;
        if (f > maxF) maxF = f;
        rowStart = n;
        f = 0;
      }
    } else fieldStart = false;
  }
  if (rowStart < n || starts.length === 0) {
    starts.push(rowStart);
    fields.push(f);
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
  }
  return { starts, fields, minF: Number.isFinite(minF) ? minF : 0, maxF };
}

function pickDelimiter(b: Uint8Array, forced?: number): number {
  if (forced !== undefined) return forced;
  const counts = new Map<number, number>([
    [0x2c, 0],
    [0x3b, 0],
    [0x09, 0],
    [0x7c, 0],
  ]);
  let inQ = false;
  for (let i = 0; i < Math.min(b.length, 8192); i++) {
    const c = b[i]!;
    if (c === 0x22) inQ = !inQ;
    else if (!inQ && c === 10) break;
    else if (!inQ && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  let best = 0x2c;
  let bestN = 0;
  for (const [d, nn] of counts) {
    if (nn > bestN) {
      best = d;
      bestN = nn;
    }
  }
  return best;
}

const NAMES: Record<number, string> = { 0x2c: 'comma', 0x3b: 'semicolon', 0x09: 'tab', 0x7c: 'pipe' };

export async function parseDelimited(ctx: Ctx): Promise<void> {
  const b = await readText(ctx);
  if (b.length === 0) return;
  const delim = pickDelimiter(b, ctx.format === 'tsv' ? 0x09 : undefined);
  const { starts, fields, minF, maxF } = scanRows(b, delim);
  const rows = starts.length;
  const end = b.length;
  const rowEnd = (i: number): number => (i + 1 < rows ? starts[i + 1]! : end);

  // Header row: first row, with its real column names.
  const headEnd = rowEnd(0);
  const names: string[] = [];
  {
    // split the header on the delimiter, quote-aware
    let cur = '';
    let q = false;
    const raw = b.subarray(starts[0]!, headEnd);
    const s = new TextDecoder().decode(raw.subarray(0, Math.min(raw.length, 2000)));
    for (let i = 0; i < s.length && names.length < 8; i++) {
      const ch = s[i]!;
      if (q) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === String.fromCharCode(delim)) {
        names.push(cur);
        cur = '';
      } else if (ch === '\n' || ch === '\r') break;
      else cur += ch;
    }
    if (names.length < 8) names.push(cur);
  }
  const cols = fields[0] ?? 0;
  ctx.out.push(seg('header row', 'header', 0, headEnd, `${fmtN(cols)} column${cols === 1 ? '' : 's'}: ${names.slice(0, 6).map((x) => x.trim() || '∅').join(', ')}${cols > 6 ? ', …' : ''}`));
  const dataRows = rows - 1;
  if (dataRows > 0) {
    const blocks: Segment[] = [];
    for (const [g0, g1] of groups(dataRows, 64)) {
      const i0 = g0 + 1;
      const i1 = g1 + 1; // exclusive row index
      const from = starts[i0]!;
      const to = i1 < rows ? starts[i1]! : end;
      const n = g1 - g0;
      let fmin = Infinity;
      let fmax = 0;
      for (let k = i0; k < i1; k++) {
        const fc = fields[k]!;
        if (fc < fmin) fmin = fc;
        if (fc > fmax) fmax = fc;
      }
      blocks.push(seg(n === 1 ? `row ${i0 + 1}` : `rows ${i0 + 1}–${i1}`, 'records', from, to - from, `${fmtN(n)} row${n === 1 ? '' : 's'} × ${fmin === fmax ? fmtN(fmax) : `${fmin}–${fmax}`} columns`, { count: n }));
    }
    ctx.out.push(...blocks);
  }
  tailBeyond(ctx, b.length);
  const ragged = minF !== maxF ? ` · ragged rows (${minF}–${maxF} columns)` : '';
  ctx.summary = `${ctx.format === 'tsv' ? 'TSV' : 'CSV'} · ${fmtN(dataRows)} data row${dataRows === 1 ? '' : 's'} × ${fmtN(cols)} column${cols === 1 ? '' : 's'} · ${NAMES[delim] ?? 'custom'}-delimited${ragged} · ${encodingOf(b)}`;
}
