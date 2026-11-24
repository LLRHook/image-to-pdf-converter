/** Human names for engine ids (directory names under src/engines). */
const NAMES: Record<string, string> = {
  magick: 'ImageMagick',
  resvg: 'resvg',
  mupdf: 'MuPDF',
  pandoc: 'pandoc',
  doclite: 'marked',
  typst: 'pandoc + Typst',
  sheet: 'SheetJS',
  datatree: 'YAML · XML parser',
  mediabunny: 'WebCodecs',
  ffmpeg: 'FFmpeg',
};

export function engineName(id: string): string {
  return NAMES[id] ?? id;
}
