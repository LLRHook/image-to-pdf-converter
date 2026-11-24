import type { EdgeSpec, Fidelity, StageSpec } from '../../core/types';
import type { FormatId } from '../../core/formats';
import {
  ALPHA_SOURCES,
  ICO_MAX,
  JPEG_QUALITY,
  MULTI_FRAME_SOURCES,
  MULTI_FRAME_TARGETS,
  READABLE,
  TRANSFORM_TARGETS,
  WRITABLE,
  lossless,
} from './meta';

const DECODE: Record<string, string> = {
  png: 'Decode PNG',
  jpg: 'Decode JPEG',
  webp: 'Decode WebP',
  avif: 'Decode AVIF',
  jxl: 'Decode JPEG XL',
  gif: 'Decode GIF frames',
  tiff: 'Decode TIFF',
  bmp: 'Decode BMP',
  ico: 'Decode ICO (largest size)',
  heic: 'Decode HEIC (HEVC)',
  psd: 'Decode Photoshop (flattened composite)',
};

const TRANSFORM: Record<string, string> = {
  jpg: 'Flatten transparency onto white',
  bmp: 'Flatten transparency onto white',
  pdf: 'Flatten transparency, size pages',
  ico: `Fit within ${ICO_MAX} × ${ICO_MAX}`,
};

function encodeLabel(from: FormatId, to: FormatId): string {
  const exact = lossless(from);
  switch (to) {
    case 'png':
      return 'Encode PNG';
    case 'jpg':
      return `Encode JPEG (quality ${JPEG_QUALITY})`;
    case 'webp':
      return exact ? 'Encode WebP (lossless)' : `Encode WebP (quality ${JPEG_QUALITY})`;
    case 'avif':
      return exact ? 'Encode AVIF (4:4:4, quality 100)' : `Encode AVIF (quality ${JPEG_QUALITY})`;
    case 'jxl':
      return exact ? 'Encode JPEG XL (lossless)' : `Encode JPEG XL (quality ${JPEG_QUALITY})`;
    case 'gif':
      return 'Encode GIF (256 colors)';
    case 'tiff':
      return 'Encode TIFF (Deflate)';
    case 'bmp':
      return 'Encode BMP (24-bit)';
    case 'ico':
      return 'Encode ICO';
    default:
      return exact ? 'Write PDF pages (Flate)' : `Write PDF pages (JPEG ${JPEG_QUALITY})`;
  }
}

function fidelity(from: FormatId, to: FormatId): Fidelity {
  switch (to) {
    case 'png':
    case 'tiff':
    case 'bmp': // transparency is flattened; see note()
      return 'lossless';
    case 'webp':
    case 'jxl':
    case 'pdf':
      return lossless(from) ? 'lossless' : 'lossy';
    default: // jpg, gif (256 colors), ico (may shrink), avif (near-lossless at best)
      return 'lossy';
  }
}

function note(from: FormatId, to: FormatId): string | undefined {
  const parts: string[] = [];
  if (MULTI_FRAME_SOURCES.has(from) && !MULTI_FRAME_TARGETS.has(to)) parts.push('Only the first frame is kept');
  if (to === 'ico') parts.push(`Fits within ${ICO_MAX}×${ICO_MAX} px as a single icon size`);
  if (to === 'gif') parts.push('Limited to 256 colors per frame, transparency is on/off');
  if (to === 'avif') parts.push('Not bit-exact; near-lossless at best');
  if ((to === 'jpg' || to === 'bmp' || to === 'pdf') && ALPHA_SOURCES.has(from)) parts.push('Transparent areas become white');
  if (to === 'pdf') parts.push('One page per frame, sized to the image');
  if (from === 'psd') parts.push('Uses the flattened preview saved in the file');
  if (from === 'ico') parts.push('Uses the largest size in the icon');
  if (from === 'heic') parts.push('Only the primary image is converted');
  return parts.length ? parts.join('. ') : undefined;
}

function stages(from: FormatId, to: FormatId): StageSpec[] {
  const list: StageSpec[] = [
    { id: 'load', label: 'Load ImageMagick 7.1' },
    { id: 'decode', label: DECODE[from] ?? 'Decode image' },
  ];
  if (TRANSFORM_TARGETS.has(to)) list.push({ id: 'transform', label: TRANSFORM[to]! });
  list.push({ id: 'encode', label: encodeLabel(from, to) });
  return list;
}

export const edges: EdgeSpec[] = [
  {
    from: READABLE,
    to: WRITABLE,
    cost: 6, // 15 MB wasm download + a worker boot; browsers' own canvas codecs are cheaper
    fidelity,
    stages,
    note,
  },
];
