import type { SegmentRole } from '../core/structure/types';

/**
 * Two themes, chosen by the system colour scheme:
 *   light - "Cloud Glass": pale sky, frosted panels, pastel segments
 *   dark  - "Aurora Mesh": deep night, luminous segments, glowing packets
 *
 * Role colours are grouped by meaning in both themes so a file reads at a glance:
 * structure (warm), payload (cool), metadata (violet), embedded media (rose),
 * neutral containers and padding.
 */
export interface Theme {
  name: 'light' | 'dark';
  role: Record<SegmentRole, string>;
  ink: string;
  muted: string;
  faint: string;
  /** Text drawn on top of a filled segment. */
  onSegment: string;
  panelFill: string;
  panelStroke: string;
  track: string;
  accent: string;
  /** Gradient stops for progress, titles and the output fill. */
  flow: [string, string, string];
  danger: string;
  notice: string;
  /** Packets add light on dark backgrounds; on light ones they cast a soft shadow. */
  additive: boolean;
  title: (px: number) => string;
  mono: (px: number, weight?: number) => string;
}

const MONO = '"Geist Mono Variable", ui-monospace, Menlo, monospace';

export const LIGHT: Theme = {
  name: 'light',
  role: {
    signature: '#6b7a99',
    header: '#ff9b6a',
    index: '#ffb45e',
    trailer: '#eebf86',
    metadata: '#b08aff',
    palette: '#ff8fb8',
    style: '#9a8cff',
    pixels: '#5fb2ff',
    samples: '#43cbbd',
    text: '#6fcf97',
    records: '#4fc9a3',
    media: '#ff7d8f',
    container: '#c3cee0',
    padding: '#dfe6f1',
    unknown: '#d0d8e6',
  },
  ink: '#0d1626',
  muted: '#5d6b84',
  faint: '#9aa7bd',
  onSegment: 'rgba(13,22,38,0.78)',
  panelFill: 'rgba(255,255,255,0.58)',
  panelStroke: 'rgba(255,255,255,0.95)',
  track: 'rgba(110,135,180,0.12)',
  accent: '#3d7bff',
  flow: ['#3d7bff', '#8f6bff', '#ff8fb1'],
  danger: '#e5484d',
  notice: '#c0399a',
  additive: false,
  title: (px) => `500 ${px}px "Geist Variable", system-ui, sans-serif`,
  mono: (px, w = 450) => `${w} ${px}px ${MONO}`,
};

export const DARK: Theme = {
  name: 'dark',
  role: {
    signature: '#ece8ff',
    header: '#ffb07a',
    index: '#ff8a5c',
    trailer: '#ffd2a6',
    metadata: '#c58bff',
    palette: '#ff7ab6',
    style: '#a78bfa',
    pixels: '#7dd3fc',
    samples: '#34e5b4',
    text: '#a5f3c4',
    records: '#6ee7b7',
    media: '#fb7185',
    container: '#3d4160',
    padding: '#25283b',
    unknown: '#4b4f69',
  },
  ink: '#f3f1ff',
  muted: 'rgba(243,241,255,0.62)',
  faint: 'rgba(243,241,255,0.32)',
  onSegment: 'rgba(8,8,14,0.82)',
  panelFill: 'rgba(14,14,24,0.52)',
  panelStroke: 'rgba(255,255,255,0.10)',
  track: 'rgba(255,255,255,0.05)',
  accent: '#7dffd6',
  flow: ['#10e0a8', '#8b6dff', '#ff8a4c'],
  danger: '#ff6b7a',
  notice: '#ff9bd0',
  additive: true,
  title: (px) => `700 ${px}px "Bricolage Grotesque Variable", system-ui, sans-serif`,
  mono: (px, w = 450) => `${w} ${px}px ${MONO}`,
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

export function currentTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

/** Parse #rrggbb to [r,g,b]. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** #rrggbb (or an rgba() string, returned with its own alpha scaled) at alpha a. */
export function rgba(color: string, a: number): string {
  if (color.startsWith('rgba(')) {
    const parts = color.slice(5, -1).split(',');
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${(Number(parts[3]) * a).toFixed(3)})`;
  }
  const [r, g, b] = rgb(color);
  return `rgba(${r},${g},${b},${a})`;
}
