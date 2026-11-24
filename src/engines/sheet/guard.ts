/**
 * Hostile-input guards for ZIP-based spreadsheets (XLSX, ODS).
 *
 * SheetJS inflates every ZIP entry fully into memory and trusts the sizes in
 * the headers, so a small "zip bomb" could exhaust memory. Before SheetJS sees
 * the file we stream-inflate it ourselves and count the REAL decompressed
 * bytes, aborting as soon as a limit is crossed. For ODS we also read
 * content.xml once to bound `number-rows-repeated` / `number-columns-repeated`
 * expansion, which SheetJS would otherwise materialise cell by cell.
 */
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';
import { LIMITS, fmtInt } from './model';

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
export const isCfb = (b: Uint8Array) =>
  b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;

export interface ZipScan {
  entries: number;
  inflatedBytes: number;
  /** content.xml of an ODS (only when requested). */
  contentXml?: string;
}

/** Entry count from the end-of-central-directory record (cheap; avoids walking a hostile directory). */
function declaredEntries(b: Uint8Array): number | null {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      const n = b[i + 10]! | (b[i + 11]! << 8);
      return n === 0xffff ? null : n;
    }
  }
  return null;
}

export interface ZipLimits {
  total: number;
  entry: number;
  entries: number;
}

export function scanZip(
  bytes: Uint8Array,
  opts: { wantContentXml?: boolean; limits?: Partial<ZipLimits> } = {},
): ZipScan {
  const lim: ZipLimits = { total: LIMITS.zipTotalBytes, entry: LIMITS.zipEntryBytes, entries: LIMITS.zipEntries, ...opts.limits };
  const tooMany = `The file contains more than ${fmtInt(lim.entries)} internal parts, which looks like a decompression bomb.`;
  const declared = declaredEntries(bytes);
  if (declared !== null && declared > lim.entries) throw new Error(tooMany);
  let total = 0;
  let entries = 0;
  let failure: string | null = null;
  const contentChunks: Uint8Array[] = [];
  let contentSize = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file: UnzipFile) => {
    if (failure) return;
    entries++;
    if (entries > lim.entries) {
      failure = tooMany;
      return;
    }
    let entryBytes = 0;
    const isContent = opts.wantContentXml && file.name === 'content.xml';
    file.ondata = (err, chunk) => {
      if (failure) return;
      if (err) {
        failure = `The file is damaged (${err.message}).`;
        return;
      }
      entryBytes += chunk.length;
      total += chunk.length;
      if (entryBytes > lim.entry || total > lim.total) {
        failure = `The file expands to more than ${fmtInt(Math.round(lim.total / 1048576))} MB when unpacked, which is too large to convert in the browser.`;
        file.terminate();
        return;
      }
      if (isContent) {
        contentChunks.push(chunk.slice());
        contentSize += chunk.length;
      }
    };
    file.start();
  };
  try {
    unzip.push(bytes, true);
  } catch (e) {
    if (e instanceof RangeError) throw new Error(tooMany);
    throw new Error(failure ?? `The file is damaged (${(e as Error).message}).`);
  }
  if (failure) throw new Error(failure);

  let contentXml: string | undefined;
  if (opts.wantContentXml && contentSize > 0) {
    const all = new Uint8Array(contentSize);
    let o = 0;
    for (const c of contentChunks) {
      all.set(c, o);
      o += c.length;
    }
    contentXml = new TextDecoder('utf-8').decode(all);
  }
  return { entries, inflatedBytes: total, contentXml };
}

/**
 * ODS repeat bomb check: a valued cell with number-columns-repeated=N inside a
 * row with number-rows-repeated=M becomes N*M cells in SheetJS. Empty cells
 * (the usual "repeat to the end of the sheet" padding) cost nothing and are
 * ignored.
 */
export function checkOdsRepeats(contentXml: string): void {
  const tag = /<table:table-row\b(?:"[^"]*"|'[^']*'|[^>"'])*>|<table:table-cell\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
  const rowRep = /table:number-rows-repeated\s*=\s*["'](\d+)["']/;
  const colRep = /table:number-columns-repeated\s*=\s*["'](\d+)["']/;
  const valued = /(?:office:value-type|office:string-value)\s*=/;
  let rep = 1;
  let cells = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(contentXml))) {
    const t = m[0];
    if (t.startsWith('<table:table-row')) {
      rep = Number(rowRep.exec(t)?.[1] ?? 1) || 1;
    } else if (valued.test(t)) {
      cells += (Number(colRep.exec(t)?.[1] ?? 1) || 1) * rep;
      if (cells > LIMITS.cells) {
        throw new Error(
          `The spreadsheet repeats cells to more than ${fmtInt(LIMITS.cells)} entries (number-rows-repeated / number-columns-repeated), which is too large to convert in the browser.`,
        );
      }
    }
  }
}
