import type { FormatId } from '../formats';
import type { ByteSource, FileStructure } from './types';
import { type Ctx, finalize, newCtx, pushUnknown } from './util';
import { parsePng } from './png';
import { parseJpeg } from './jpg';
import { parseGif } from './gif';
import { parseRiff } from './riff';
import { parseBmp } from './bmp';
import { parseIco } from './ico';
import { parseTiff } from './tiff';
import { parseIsobmff } from './isobmff';
import { parseEbml } from './ebml';
import { parseMp3 } from './mp3';
import { parseFlac } from './flac';
import { parseOgg } from './ogg';
import { parseZip } from './zip';
import { parsePdf } from './pdf';
import { parsePsd } from './psd';
import { parseJxl } from './jxl';
import { parseTxt } from './plain';
import { parseMarkdown } from './markdown';
import { parseTex } from './tex';
import { parseDelimited } from './delimited';
import { parseJson } from './json';
import { parseYaml } from './yaml';
import { parseMarkup } from './markup';
import { parseRtf } from './rtf';
import { parseOle2 } from './ole2';
import { id3v2Length, isAdts, parseAdts } from './mp3';

export type { ByteSource, FileStructure, Segment, SegmentRole } from './types';
export { blobSource, bytesSource } from './types';

/**
 * parseStructure(source, format) describes the real byte layout of a file for the loading animation.
 *
 * - Random access only (ByteSource); a parse reads at most ~8 MB (plus a ≤256 KB reserve for trailer
 *   reads once that is spent) and sets `truncated` whenever a cap is hit.
 * - Segment lists are capped at 2,000 entries, nesting at 4 child levels below a top-level segment,
 *   and the whole tree at 20,000 nodes. Long runs of same-named neighbours are merged with `count`.
 * - Never throws: damaged input yields what was parsed plus an 'unknown' segment for the rest, and the
 *   top level always covers the whole file.
 */
export interface ParseOptions {
  /** Cap on bytes read from the source (default 8 MB). */
  maxBytes?: number;
}

type Parser = (ctx: Ctx) => Promise<void>;

/** M4A is normally ISOBMFF, but a bare .aac stream (ADTS) is also filed under it. */
async function parseM4a(ctx: Ctx): Promise<void> {
  const h = await ctx.r.read(0, 10);
  const adts = isAdts(h, 0) || (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 && (await id3Then(ctx)));
  return adts ? parseAdts(ctx) : parseIsobmff(ctx);
}

async function id3Then(ctx: Ctx): Promise<boolean> {
  const len = await id3v2Length(ctx.r, 0);
  const b = await ctx.r.read(len, 4);
  return len > 0 && isAdts(b, 0);
}

const PARSERS: Record<FormatId, Parser> = {
  png: parsePng,
  jpg: parseJpeg,
  webp: parseRiff,
  avif: parseIsobmff,
  heic: parseIsobmff,
  jxl: parseJxl,
  gif: parseGif,
  tiff: parseTiff,
  bmp: parseBmp,
  ico: parseIco,
  psd: parsePsd,
  svg: parseMarkup,
  pdf: parsePdf,
  docx: parseZip,
  odt: parseZip,
  rtf: parseRtf,
  epub: parseZip,
  md: parseMarkdown,
  html: parseMarkup,
  tex: parseTex,
  txt: parseTxt,
  xlsx: parseZip,
  xls: parseOle2,
  ods: parseZip,
  csv: parseDelimited,
  tsv: parseDelimited,
  json: parseJson,
  yaml: parseYaml,
  xml: parseMarkup,
  mp3: parseMp3,
  wav: parseRiff,
  flac: parseFlac,
  ogg: parseOgg,
  m4a: parseM4a,
  mp4: parseIsobmff,
  webm: parseEbml,
  mov: parseIsobmff,
  mkv: parseEbml,
  zip: parseZip,
};

/**
 * Describe the real on-disk layout of `source` as `format`. Never throws: on
 * malformed input it returns whatever was parsed plus an 'unknown' segment.
 */
export async function parseStructure(source: ByteSource, format: FormatId, options: ParseOptions = {}): Promise<FileStructure> {
  const ctx = newCtx(source, format, options.maxBytes);
  // Typed as exhaustive, but `format` can come from untrusted runtime data.
  const parser = (PARSERS as Partial<Record<string, Parser>>)[format];
  if (parser) {
    try {
      await parser(ctx);
    } catch {
      ctx.truncated = true;
    }
  }
  if (ctx.out.length === 0 && ctx.r.size > 0) {
    pushUnknown(ctx.out, 0, ctx.r.size, parser ? 'unrecognised data' : 'unparsed data');
    if (!ctx.summary) ctx.summary = `${format.toUpperCase()} · layout not recognised`;
  }
  return finalize(ctx, ctx.r.size === 0 ? `${format.toUpperCase()} · empty file` : `${format.toUpperCase()} · ${ctx.r.size.toLocaleString('en-US')} bytes`);
}
