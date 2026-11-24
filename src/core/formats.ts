/**
 * The format catalog. Every format the app knows about lives here, whether or
 * not any engine can read or write it yet. Engines declare edges between these
 * ids; the planner (graph.ts) decides what is actually reachable.
 */

export const FAMILIES = ['image', 'document', 'data', 'audio', 'video', 'archive'] as const;
export type Family = (typeof FAMILIES)[number];

export interface FormatInfo {
  readonly id: string;
  readonly label: string;
  readonly family: Family;
  /** File extensions, first one is the canonical output extension. */
  readonly exts: readonly string[];
  readonly mime: string;
}

const f = (id: string, label: string, family: Family, exts: string[], mime: string): FormatInfo => ({
  id,
  label,
  family,
  exts,
  mime,
});

export const FORMATS = [
  // Images
  f('png', 'PNG', 'image', ['png'], 'image/png'),
  f('jpg', 'JPEG', 'image', ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/jpeg'),
  f('webp', 'WebP', 'image', ['webp'], 'image/webp'),
  f('avif', 'AVIF', 'image', ['avif'], 'image/avif'),
  f('heic', 'HEIC', 'image', ['heic', 'heif'], 'image/heic'),
  f('jxl', 'JPEG XL', 'image', ['jxl'], 'image/jxl'),
  f('gif', 'GIF', 'image', ['gif'], 'image/gif'),
  f('tiff', 'TIFF', 'image', ['tiff', 'tif'], 'image/tiff'),
  f('bmp', 'BMP', 'image', ['bmp', 'dib'], 'image/bmp'),
  f('ico', 'ICO', 'image', ['ico'], 'image/x-icon'),
  f('psd', 'Photoshop', 'image', ['psd'], 'image/vnd.adobe.photoshop'),
  f('svg', 'SVG', 'image', ['svg'], 'image/svg+xml'),
  // Documents
  f('pdf', 'PDF', 'document', ['pdf'], 'application/pdf'),
  f('docx', 'Word', 'document', ['docx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  f('odt', 'OpenDocument Text', 'document', ['odt'], 'application/vnd.oasis.opendocument.text'),
  f('rtf', 'Rich Text', 'document', ['rtf'], 'application/rtf'),
  f('epub', 'EPUB', 'document', ['epub'], 'application/epub+zip'),
  f('md', 'Markdown', 'document', ['md', 'markdown'], 'text/markdown'),
  f('html', 'HTML', 'document', ['html', 'htm'], 'text/html'),
  f('tex', 'LaTeX', 'document', ['tex'], 'application/x-tex'),
  f('txt', 'Plain text', 'document', ['txt', 'text'], 'text/plain'),
  // Data
  f('xlsx', 'Excel', 'data', ['xlsx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  f('xls', 'Excel 97', 'data', ['xls'], 'application/vnd.ms-excel'),
  f('ods', 'OpenDocument Sheet', 'data', ['ods'], 'application/vnd.oasis.opendocument.spreadsheet'),
  f('csv', 'CSV', 'data', ['csv'], 'text/csv'),
  f('tsv', 'TSV', 'data', ['tsv', 'tab'], 'text/tab-separated-values'),
  f('json', 'JSON', 'data', ['json'], 'application/json'),
  f('yaml', 'YAML', 'data', ['yaml', 'yml'], 'application/yaml'),
  f('xml', 'XML', 'data', ['xml'], 'application/xml'),
  // Audio
  f('mp3', 'MP3', 'audio', ['mp3'], 'audio/mpeg'),
  f('wav', 'WAV', 'audio', ['wav', 'wave'], 'audio/wav'),
  f('flac', 'FLAC', 'audio', ['flac'], 'audio/flac'),
  f('ogg', 'Ogg', 'audio', ['ogg', 'oga', 'opus'], 'audio/ogg'),
  f('m4a', 'AAC (M4A)', 'audio', ['m4a', 'aac'], 'audio/mp4'),
  // Video
  f('mp4', 'MP4', 'video', ['mp4', 'm4v'], 'video/mp4'),
  f('webm', 'WebM', 'video', ['webm'], 'video/webm'),
  f('mov', 'QuickTime', 'video', ['mov', 'qt'], 'video/quicktime'),
  f('mkv', 'Matroska', 'video', ['mkv'], 'video/x-matroska'),
  // Archive (used for multi-file outputs such as one PNG per PDF page)
  f('zip', 'ZIP', 'archive', ['zip'], 'application/zip'),
] as const satisfies readonly FormatInfo[];

export type FormatId = (typeof FORMATS)[number]['id'];

const BY_ID = new Map<string, FormatInfo>(FORMATS.map((x) => [x.id, x]));
const BY_EXT = new Map<string, FormatInfo>();
for (const x of FORMATS) for (const e of x.exts) if (!BY_EXT.has(e)) BY_EXT.set(e, x);

export function formatInfo(id: FormatId): FormatInfo {
  const info = BY_ID.get(id);
  if (!info) throw new Error(`Unknown format: ${id}`);
  return info;
}

export function isFormatId(id: string): id is FormatId {
  return BY_ID.has(id);
}

export function formatFromExtension(filename: string): FormatId | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return BY_EXT.get(filename.slice(dot + 1).toLowerCase())?.id as FormatId | undefined;
}

export function outputName(inputName: string, ext: string): string {
  const dot = inputName.lastIndexOf('.');
  const base = (dot > 0 ? inputName.slice(0, dot) : inputName) || 'converted';
  return `${base}.${ext}`;
}
