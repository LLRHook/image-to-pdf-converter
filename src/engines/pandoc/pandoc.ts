/**
 * pandoc-wasm driver shared by the pandoc and typst engines.
 *
 * Every conversion is two pandoc runs around the real intermediate
 * representation: reader -> pandoc JSON AST (facts and the outline preview come
 * from it), then JSON AST -> writer. Media travels alongside as plain bytes.
 *
 * The wasm bytes come through ctx.fetchAsset (byte-accurate progress, same
 * origin only); pandoc-wasm's own browser entry is never imported because it
 * would fetch the binary itself.
 */
import { createPandocInstance, type PandocInstance } from '../../../node_modules/pandoc-wasm/src/core.js';
import pandocWasmUrl from '../../../node_modules/pandoc-wasm/src/pandoc.wasm?url';
import { zipSync, type Zippable } from 'fflate';
import type { FormatId } from '../../core/formats';
import { formatInfo } from '../../core/formats';
import type { ConvertRequest, EngineContext } from '../../core/types';
import {
  analyze, decodeDataImage, hasTitle, imageNodes, imageUrl, lookupMedia, replaceImageWithAlt, sanitizeAst, setImageUrl, textToAst,
  type Analysis, type AstNode, type PandocAst,
} from './ast';
import { assertContainer } from './container';
import { LIMITS, assertDocumentSize, assertMarkdownTractable, formatBytes } from './limits';
import { fixRtfUnicodeSkip } from './rtf';
import { BUNDLE_TARGETS, DOC_NAMES } from './spec';
import { HTML_CSP, decodeText } from './text';

export type { PandocInstance };

/** Pandoc reader per source format. `txt` has none: the AST is built from the text directly. */
export const READERS: Partial<Record<FormatId, string>> = {
  docx: 'docx',
  odt: 'odt',
  rtf: 'rtf',
  epub: 'epub',
  md: 'gfm', // GitHub-flavoured: matches what people mean by .md and what `marked` renders
  html: 'html',
  tex: 'latex',
};

export type DocumentTarget = 'docx' | 'odt' | 'rtf' | 'epub' | 'md' | 'html' | 'tex' | 'txt';

interface TargetSpec {
  writer: string;
  /** Written to a file by pandoc (binary container) instead of stdout. */
  binary?: boolean;
  /** The writer reads the images and embeds them in the output itself. */
  embeds?: boolean;
}

export const TARGETS: Record<DocumentTarget, TargetSpec> = {
  docx: { writer: 'docx', binary: true, embeds: true },
  odt: { writer: 'odt', binary: true, embeds: true },
  epub: { writer: 'epub3', binary: true, embeds: true },
  rtf: { writer: 'rtf', embeds: true },
  html: { writer: 'html5', embeds: true },
  md: { writer: 'gfm-tex_math_gfm' },
  tex: { writer: 'latex' },
  txt: { writer: 'plain' },
};

export const isDocumentTarget = (f: string): f is DocumentTarget => f in TARGETS;
/** Images of these targets stay separate files: the output becomes a ZIP when there are any. */
export const canBundle = (to: FormatId): boolean => BUNDLE_TARGETS.has(to);

export async function loadPandoc(ctx: EngineContext): Promise<PandocInstance> {
  const bytes = await ctx.fetchAsset(pandocWasmUrl);
  return createPandocInstance(bytes);
}

export interface MediaItem {
  /** Unique, flat file name, e.g. "image1.png". */
  name: string;
  bytes: Uint8Array;
}

interface ImageRef {
  node: AstNode;
  media?: MediaItem;
}

export interface ReadResult {
  ast: PandocAst;
  analysis: Analysis;
  /** Images that the document really references and we hold the bytes of, in first-use order. */
  media: MediaItem[];
  images: ImageRef[];
  warnings: string[];
}

export class PandocError extends Error {}

function pandocFailure(stderr: string, what: string): PandocError {
  const msg = stderr
    .split('\n')
    .map((l) => l.replace(/^ERROR:\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
  return new PandocError(`${what}${msg ? `: ${msg}` : ''}`);
}

const warningLines = (ws: { type: string; verbosity?: string; pretty?: string; message?: string }[]) =>
  ws.filter((w) => w.verbosity === 'WARNING').map((w) => (w.pretty ?? w.message ?? w.type).split('\n')[0]!);

async function apiVersionOf(p: PandocInstance): Promise<number[]> {
  const r = await p.convert({ from: 'markdown', to: 'json' }, '', {});
  return (JSON.parse(r.stdout) as PandocAst)['pandoc-api-version'];
}

const EXT_FOR_INPUT: Partial<Record<FormatId, string>> = { tex: 'tex', md: 'md', html: 'html', docx: 'docx', odt: 'odt', rtf: 'rtf', epub: 'epub' };

export interface DocumentInput {
  bytes: Uint8Array;
  from: FormatId;
  label: string;
  /** The same bytes as a Blob (the request's input), handed to pandoc as is instead of a copy. */
  blob?: Blob;
  /** Markdown already decoded and checked by assertMarkdownTractable, so it is not done twice. */
  text?: string;
}

/**
 * Checks every pandoc-backed engine runs before downloading any wasm: input size,
 * the container really being what it claims, and Markdown that would hang the reader.
 */
export async function prepareDocument(req: ConvertRequest): Promise<DocumentInput> {
  const { from } = req;
  assertDocumentSize(req.input.size);
  const bytes = new Uint8Array(await req.input.arrayBuffer());
  assertContainer(from, bytes);
  let text: string | undefined;
  if (from === 'md') {
    text = decodeText(bytes).text;
    assertMarkdownTractable(text);
  }
  return { bytes, from, label: DOC_NAMES[from] ?? from, blob: req.input, text };
}

/** pandoc's first few warnings, into the job log. */
export function logPandocWarnings(ctx: EngineContext, warnings: readonly string[]): void {
  for (const w of warnings.slice(0, 5)) ctx.log(`pandoc: ${w}`);
}

/** The decode stage of the pandoc-backed engines: read the document, then report its facts, outline and warnings. */
export async function decodeDocument(p: PandocInstance, input: DocumentInput, ctx: EngineContext): Promise<ReadResult> {
  ctx.stage('decode');
  const read = await readDocument(p, input);
  ctx.facts(read.analysis.facts);
  ctx.preview(read.analysis.outline);
  logPandocWarnings(ctx, read.warnings);
  return read;
}

/** Run the reader and return the AST plus the images it extracted. */
export async function readDocument(p: PandocInstance, input: DocumentInput): Promise<ReadResult> {
  const { from, bytes } = input;
  let ast: PandocAst;
  let warnings: string[] = [];
  const media = new Map<string, Uint8Array>();

  if (from === 'txt') {
    ast = textToAst(decodeText(bytes).text, await apiVersionOf(p));
  } else {
    const reader = READERS[from];
    if (!reader) throw new Error(`No pandoc reader for ${from}`);
    const name = `in.${EXT_FOR_INPUT[from] ?? 'bin'}`;
    const textual = from === 'md' || from === 'html' || from === 'tex';
    let data: Blob | string;
    if (textual) {
      data = input.text ?? decodeText(bytes).text;
      if (from === 'md' && input.text === undefined) assertMarkdownTractable(data);
    } else if (from === 'rtf') {
      data = new Blob([fixRtfUnicodeSkip(bytes) as Uint8Array<ArrayBuffer>]);
    } else {
      data = input.blob ?? new Blob([bytes as Uint8Array<ArrayBuffer>]);
    }
    // Containers carry their images inside; plain-text formats reference them (or embed data: URIs, handled below).
    const container = !textual;
    const opts: Record<string, unknown> = { from: reader, to: 'json', 'input-files': [name] };
    if (container) opts['extract-media'] = '.';
    const r = await p.convert(opts, null, { [name]: data });
    if (!r.stdout) throw pandocFailure(r.stderr, `Could not read this ${input.label} file`);
    if (r.stdout.length > LIMITS.astBytes) {
      throw new Error(`This document is too large to convert here (${formatBytes(r.stdout.length)} of structure after reading).`);
    }
    ast = JSON.parse(r.stdout) as PandocAst;
    warnings = warningLines(r.warnings);

    let total = 0;
    const entries = Object.entries(r.mediaFiles);
    if (entries.length > LIMITS.images) throw new Error(`This document has more than ${LIMITS.images.toLocaleString('en')} images.`);
    for (const [path, blob] of entries) {
      total += blob.size;
      if (total > LIMITS.imageBytes) throw new Error(`The images in this document add up to more than ${formatBytes(LIMITS.imageBytes)}.`);
      media.set(path, new Uint8Array(await blob.arrayBuffer()));
    }
  }

  sanitizeAst(ast);
  const analysis = analyze(ast);
  const { images, used } = bindImages(ast, media);
  return { ast, analysis, media: used, images, warnings };
}

/** Match every Image node to the extracted bytes it points at, giving each file a unique flat name. */
function bindImages(ast: PandocAst, files: Map<string, Uint8Array>): { images: ImageRef[]; used: MediaItem[] } {
  const images: ImageRef[] = [];
  const used: MediaItem[] = [];
  const byKey = new Map<string, MediaItem>();
  const names = new Set<string>();
  let inlineBytes = 0;
  let dataImages = 0;
  for (const node of imageNodes(ast)) {
    const url = imageUrl(node);
    if (url.startsWith('data:')) {
      // An image embedded in the source (HTML/Markdown): carry it like any other media.
      const img = decodeDataImage(url, LIMITS.imageBytes);
      if (img) {
        inlineBytes += img.bytes.length;
        if (inlineBytes > LIMITS.imageBytes || ++dataImages > LIMITS.images) {
          throw new Error(`The images in this document add up to more than ${formatBytes(LIMITS.imageBytes)}.`);
        }
        let item = byKey.get(url);
        if (!item) {
          let name = `image-${dataImages}.${img.ext}`;
          while (names.has(name)) name = `image-${dataImages}-${names.size}.${img.ext}`;
          names.add(name);
          item = { name, bytes: img.bytes };
          byKey.set(url, item);
          used.push(item);
        }
        images.push({ node, media: item });
        continue;
      }
    }
    const hit = lookupMedia(files, url);
    if (!hit) {
      images.push({ node });
      continue;
    }
    let item = byKey.get(hit.key);
    if (!item) {
      const base = hit.key.split('/').pop()!.replace(/[^\w.\-]+/g, '_') || 'image';
      let name = base;
      for (let n = 2; names.has(name); n++) name = base.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
      names.add(name);
      item = { name, bytes: hit.value };
      byKey.set(hit.key, item);
      used.push(item);
    }
    images.push({ node, media: item });
  }
  return { images, used };
}

function applyImageUrls(images: ImageRef[], urlOf: (m: MediaItem) => string): void {
  for (const { node, media } of images) if (media) setImageUrl(node, urlOf(media));
}

export interface Written {
  /** The pandoc output (a text document, or a binary container). */
  bytes: Uint8Array;
  warnings: string[];
}

export interface WriteOptions {
  /** Used for the HTML <title> / EPUB title when the document has none. */
  title: string;
  /** Extra pandoc options merged last. */
  extra?: Record<string, unknown>;
  /** Extra text files for pandoc (templates, include-in-header files). */
  files?: Record<string, string>;
}

/** Run a writer over `read.ast`. Mutates the AST's image URLs for this writer. */
export async function writeDocument(
  p: PandocInstance,
  read: ReadResult,
  to: DocumentTarget,
  opts: WriteOptions,
): Promise<Written & { mediaUsed: MediaItem[] }> {
  const spec = TARGETS[to];
  const files: Record<string, Blob | string> = { ...(opts.files ?? {}) };
  let mediaUsed: MediaItem[] = [];

  if (spec.embeds) {
    applyImageUrls(read.images, (m) => m.name);
    mediaUsed = read.media;
    for (const m of mediaUsed) files[m.name] = new Blob([m.bytes as Uint8Array<ArrayBuffer>]);
  } else if (canBundle(to)) {
    applyImageUrls(read.images, (m) => `media/${m.name}`);
    mediaUsed = read.media;
  }

  const options: Record<string, unknown> = { from: 'json', to: spec.writer, standalone: true, wrap: 'none' };
  const metadata: Record<string, unknown> = {};
  if (to === 'html') {
    options['embed-resources'] = true;
    options['html-math-method'] = 'mathml';
    options['include-in-header'] = ['csp.html'];
    files['csp.html'] = HTML_CSP;
    if (!hasTitle(read.ast)) metadata.pagetitle = opts.title;
  }
  if (to === 'epub' && !hasTitle(read.ast)) metadata.title = opts.title;
  if (Object.keys(metadata).length) options.metadata = metadata;
  const outName = 'out.bin';
  if (spec.binary) options['output-file'] = outName;
  Object.assign(options, opts.extra);

  const r = await p.convert(options, JSON.stringify(read.ast), files);
  const out = spec.binary ? r.files[outName] : r.stdout;
  if (!out || (typeof out === 'string' ? out.length === 0 : out.size === 0)) {
    throw pandocFailure(r.stderr, `Could not write ${formatInfo(to).label}`);
  }
  const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : new Uint8Array(await out.arrayBuffer());
  return { bytes, warnings: warningLines(r.warnings), mediaUsed };
}

/** Pandoc AST -> Typst markup (standalone), with images as flat files for the Typst compiler. */
export async function writeTypst(
  p: PandocInstance,
  read: ReadResult,
  opts: { title: string; keepImage: (m: MediaItem) => boolean },
): Promise<{ source: string; media: MediaItem[]; warnings: string[] }> {
  const usable = read.media.filter(opts.keepImage);
  const usableSet = new Set(usable);
  // An image Typst cannot decode (or that we do not hold) would abort the whole
  // compile: show its alt text instead.
  for (const ref of read.images) {
    if (!ref.media || !usableSet.has(ref.media)) {
      replaceImageWithAlt(ref.node);
      ref.media = undefined;
    }
  }
  applyImageUrls(read.images, (m) => m.name);
  const options: Record<string, unknown> = {
    from: 'json',
    to: 'typst',
    standalone: true,
    wrap: 'none',
    variables: { papersize: 'a4', 'page-numbering': '1' },
  };
  if (!hasTitle(read.ast)) options.metadata = { pagetitle: opts.title };
  const r = await p.convert(options, JSON.stringify(read.ast), {});
  if (!r.stdout) throw pandocFailure(r.stderr, 'Could not convert this document to Typst');
  return { source: r.stdout, media: usable, warnings: warningLines(r.warnings) };
}

/** ZIP the document and its images: `<base>.<ext>` plus `media/<name>`. */
export function bundleZip(docName: string, doc: Uint8Array, media: MediaItem[]): Uint8Array {
  const entries: Zippable = { [docName]: [doc, { level: 6 }] };
  for (const m of media) entries[`media/${m.name}`] = [m.bytes, { level: 0 }];
  return zipSync(entries);
}
