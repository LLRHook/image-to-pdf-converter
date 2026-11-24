import type { SegmentRole } from '../core/structure/types';

/**
 * Role colours. Grouped by meaning so a file reads at a glance:
 *   structure (amber family) - signature, header, index, trailer
 *   payload   (cyan/green)   - pixels, samples, text, records
 *   metadata  (magenta)      - metadata, palette, style
 *   embedded  (coral)        - media
 *   neutral   (graphite)     - container, padding, unknown
 */
export const ROLE_COLOR: Record<SegmentRole, string> = {
  signature: '#f3ede2',
  header: '#ffb547',
  index: '#ff8a3d',
  trailer: '#e8c88f',
  metadata: '#e46bff',
  palette: '#ff6fa5',
  style: '#b59cff',
  pixels: '#4fd1ff',
  samples: '#36e0c2',
  text: '#a3ef7a',
  records: '#7ff0ae',
  media: '#ff6b5e',
  container: '#4a4f59',
  padding: '#2b2f36',
  unknown: '#565b66',
};

export const ROLE_LABEL: Record<SegmentRole, string> = {
  signature: 'Signature',
  header: 'Header',
  index: 'Index',
  trailer: 'Trailer',
  metadata: 'Metadata',
  palette: 'Colour table',
  style: 'Styles / fonts',
  pixels: 'Pixel data',
  samples: 'Media samples',
  text: 'Body text',
  records: 'Records',
  media: 'Embedded media',
  container: 'Container',
  padding: 'Padding',
  unknown: 'Other bytes',
};

export const INK = '#ece7dd';
export const MUTED = '#8c887f';
export const FAINT = '#4a4740';
export const LINE = '#24252a';
export const BG = '#0c0d0f';
export const PANEL = '#121317';
export const ACCENT = '#ffb547';

export const MONO = '"Martian Mono Variable", ui-monospace, Menlo, monospace';
export const SERIF = '"Instrument Serif", "Iowan Old Style", Georgia, serif';

/** Parse #rrggbb to [r,g,b]. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
