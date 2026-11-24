import type { FormatId } from '../formats';

/**
 * The real on-disk layout of a file, as the loading screen draws it.
 * Every segment is a byte range that exists in the file; nothing is invented.
 */

export type SegmentRole =
  | 'signature' // magic bytes / file signature
  | 'header' // format header: dimensions, codec config, EBML header, ftyp
  | 'metadata' // EXIF, ID3, XMP, tEXt, docProps, tags
  | 'index' // xref, central directory, moov/stbl sample tables, cues, seek tables
  | 'palette' // colour tables, ICC profiles
  | 'pixels' // compressed or raw image data (IDAT, SOS scan, mdat for images)
  | 'samples' // audio frames / video frames / mdat for media
  | 'text' // document body text (word/document.xml, content streams)
  | 'style' // styles, fonts, themes
  | 'media' // embedded images/media inside a document or archive
  | 'records' // rows, cells, objects, elements in data formats
  | 'container' // structural wrapper with children (RIFF, moov, Segment, zip entry)
  | 'padding' // free space, filler, alignment
  | 'trailer' // IEND, EOI, %%EOF, trailer, end of central directory
  | 'unknown';

export interface Segment {
  /** The name the format itself uses: 'IDAT', 'APP1 (Exif)', 'moov', 'word/document.xml', '12 0 obj'. */
  name: string;
  role: SegmentRole;
  /** Byte offset of the segment in the file. */
  offset: number;
  /** Byte length on disk (compressed size for zip entries). */
  length: number;
  /** Optional real detail: '1920×1080 RGBA 8-bit', 'avc1 video, 30 fps', 'deflate 41 KB → 180 KB'. */
  detail?: string;
  /** How many consecutive same-named segments were merged into this one (e.g. 312 IDAT chunks). */
  count?: number;
  children?: Segment[];
}

export interface FileStructure {
  format: FormatId;
  size: number;
  /** Top-level segments in file order. Contiguous ranges should cover the file; gaps are allowed. */
  segments: Segment[];
  /** One-line summary of what the parser learned, e.g. 'PNG 1920×1080, 8-bit RGBA, 312 IDAT chunks'. */
  summary?: string;
  /** True if the parser hit a limit (segment cap, depth cap, read budget) and stopped early. */
  truncated?: boolean;
}

/** Random-access reads so large media files are never fully loaded just to be drawn. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    },
  };
}
