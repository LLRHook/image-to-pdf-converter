import type { FormatId } from '../core/formats';
import type { SegmentRole } from '../core/structure/types';

/**
 * The grammar of each output format: the sections an encoder writes, in
 * order. While the encoder runs, the loading screen draws this as a ghost
 * ("expected layout"); once the real output exists it is parsed and the ghost
 * morphs into the true segments with their real sizes. Weights only decide
 * ghost widths and are never presented as sizes.
 */
export interface GhostPart {
  name: string;
  role: SegmentRole;
  weight: number;
}

const g = (name: string, role: SegmentRole, weight = 1): GhostPart => ({ name, role, weight });
const BODY = 20;

const T: Partial<Record<FormatId, GhostPart[]>> = {
  png: [g('signature', 'signature'), g('IHDR', 'header'), g('IDAT', 'pixels', BODY), g('IEND', 'trailer')],
  jpg: [g('SOI', 'signature'), g('APP0', 'metadata'), g('DQT', 'header'), g('SOF', 'header'), g('DHT', 'header'), g('SOS scan', 'pixels', BODY), g('EOI', 'trailer')],
  webp: [g('RIFF', 'container'), g('VP8X', 'header'), g('VP8/VP8L', 'pixels', BODY)],
  avif: [g('ftyp', 'header'), g('meta', 'index', 2), g('mdat', 'pixels', BODY)],
  heic: [g('ftyp', 'header'), g('meta', 'index', 2), g('mdat', 'pixels', BODY)],
  jxl: [g('signature', 'signature'), g('codestream', 'pixels', BODY)],
  gif: [g('GIF89a', 'signature'), g('screen + palette', 'palette', 2), g('frames', 'pixels', BODY), g('trailer', 'trailer')],
  tiff: [g('header', 'header'), g('IFD', 'index', 2), g('strips', 'pixels', BODY)],
  bmp: [g('BITMAPFILEHEADER', 'header'), g('DIB header', 'header'), g('pixel array', 'pixels', BODY)],
  ico: [g('ICONDIR', 'index'), g('image', 'pixels', BODY)],
  psd: [g('header', 'header'), g('resources', 'metadata', 2), g('layers', 'pixels', BODY), g('image data', 'pixels', BODY / 2)],
  svg: [g('<svg>', 'header'), g('elements', 'text', BODY)],
  pdf: [g('%PDF', 'signature'), g('catalog + pages', 'index', 2), g('content + resources', 'text', BODY), g('xref', 'index', 2), g('trailer', 'trailer')],
  docx: [g('[Content_Types]', 'index'), g('word/document.xml', 'text', BODY), g('styles', 'style', 3), g('docProps', 'metadata'), g('central directory', 'index'), g('EOCD', 'trailer')],
  odt: [g('mimetype', 'signature'), g('content.xml', 'text', BODY), g('styles.xml', 'style', 3), g('meta.xml', 'metadata'), g('central directory', 'index'), g('EOCD', 'trailer')],
  epub: [g('mimetype', 'signature'), g('container.xml', 'index'), g('content.opf', 'index'), g('chapters', 'text', BODY), g('central directory', 'index'), g('EOCD', 'trailer')],
  xlsx: [g('[Content_Types]', 'index'), g('worksheets', 'records', BODY), g('sharedStrings', 'records', 4), g('styles', 'style', 2), g('central directory', 'index'), g('EOCD', 'trailer')],
  ods: [g('mimetype', 'signature'), g('content.xml', 'records', BODY), g('styles.xml', 'style', 2), g('central directory', 'index'), g('EOCD', 'trailer')],
  zip: [g('entries', 'media', BODY), g('central directory', 'index'), g('EOCD', 'trailer')],
  rtf: [g('{\\rtf1', 'header'), g('font + colour tables', 'style', 2), g('body', 'text', BODY)],
  tex: [g('preamble', 'header', 2), g('document', 'text', BODY)],
  md: [g('sections', 'text', BODY)],
  html: [g('<head>', 'header', 2), g('<body>', 'text', BODY)],
  txt: [g('text', 'text', BODY)],
  csv: [g('header row', 'header'), g('rows', 'records', BODY)],
  tsv: [g('header row', 'header'), g('rows', 'records', BODY)],
  json: [g('values', 'records', BODY)],
  yaml: [g('mappings', 'records', BODY)],
  xml: [g('<?xml', 'header'), g('elements', 'records', BODY)],
  mp4: [g('ftyp', 'header'), g('moov', 'index', 3), g('mdat', 'samples', BODY)],
  mov: [g('ftyp', 'header'), g('moov', 'index', 3), g('mdat', 'samples', BODY)],
  m4a: [g('ftyp', 'header'), g('moov', 'index', 2), g('mdat', 'samples', BODY)],
  webm: [g('EBML', 'header'), g('Info + Tracks', 'header', 2), g('Clusters', 'samples', BODY), g('Cues', 'index', 2)],
  mkv: [g('EBML', 'header'), g('Info + Tracks', 'header', 2), g('Clusters', 'samples', BODY), g('Cues', 'index', 2)],
  mp3: [g('ID3v2', 'metadata', 2), g('MPEG frames', 'samples', BODY)],
  wav: [g('RIFF', 'container'), g('fmt', 'header'), g('data', 'samples', BODY)],
  flac: [g('fLaC', 'signature'), g('STREAMINFO', 'header'), g('frames', 'samples', BODY)],
  ogg: [g('header pages', 'header', 2), g('audio pages', 'samples', BODY)],
};

export function ghostFor(format: FormatId): GhostPart[] {
  return T[format] ?? [g('data', 'unknown', BODY)];
}
