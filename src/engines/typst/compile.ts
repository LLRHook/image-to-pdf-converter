/**
 * Typst compiler driver. Uses the wasm bindings of @myriaddreamin/typst-ts-web-compiler
 * directly (not the typst.ts wrapper): the wrapper downloads fonts from jsdelivr by
 * default and builds helper code with `new Function`, neither of which is acceptable
 * here. The compiler wasm and every font arrive through ctx.fetchAsset.
 *
 * The web-compiler build has NO embedded fonts, so text only renders when font
 * files exist in ./fonts (see fonts/README.md).
 */
import initTypst, { TypstCompilerBuilder, TypstFontResolverBuilder, type TypstCompiler } from '@myriaddreamin/typst-ts-web-compiler';
import typstWasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import type { EngineContext } from '../../core/types';

const fontModules = import.meta.glob<string>('./fonts/*.{otf,ttf}', { query: '?url', import: 'default', eager: true });
/** Font file URLs, in a stable order. Empty until the fonts listed in fonts/README.md are added. */
export const FONT_URLS: string[] = Object.entries(fontModules)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([, url]) => url);

export interface TypstRuntime {
  compiler: TypstCompiler;
  fonts: number;
}

export async function loadTypst(ctx: EngineContext): Promise<TypstRuntime> {
  if (FONT_URLS.length === 0) {
    throw new Error('PDF output is not available: no fonts are bundled with this build.');
  }
  const [wasm, fontBytes] = await Promise.all([
    ctx.fetchAsset(typstWasmUrl),
    Promise.all(FONT_URLS.map((u) => ctx.fetchAsset(u))),
  ]);
  await initTypst({ module_or_path: wasm as Uint8Array<ArrayBuffer> });
  const fontBuilder = new TypstFontResolverBuilder();
  for (const f of fontBytes) fontBuilder.add_raw_font(f);
  const resolver = await fontBuilder.build();
  const builder = new TypstCompilerBuilder();
  // No file system: the only files are the ones we map in ourselves.
  builder.set_dummy_access_model();
  const compiler = await builder.build();
  compiler.set_fonts(resolver);
  return { compiler, fonts: fontBytes.length };
}

export class TypstError extends Error {}

/** Diagnostics come back as "path:line:col: error: message" lines (diagnostics format 2). */
function describe(diags: unknown): string {
  const lines = (Array.isArray(diags) ? diags : [diags]).map(String).filter(Boolean);
  const errors = lines.filter((l) => /\berror\b/.test(l));
  return (errors.length ? errors : lines).slice(0, 3).join('; ').replace(/\/main\.typ:/g, 'line ');
}

export interface Compiled {
  /** Run once layout has succeeded. */
  exportPdf(): Uint8Array;
}

/** Lay the document out. Throws a TypstError with the compiler's message when it fails. */
export function typeset(rt: TypstRuntime, source: string, files: ReadonlyMap<string, Uint8Array>): Compiled {
  const c = rt.compiler;
  c.reset_shadow();
  for (const [name, bytes] of files) c.map_shadow(`/${name}`, bytes);
  c.add_source('/main.typ', source);
  const world = c.snapshot('/', '/main.typ', undefined);
  const r = world.compile(0, 2) as { hasError: boolean; diagnostics?: unknown };
  if (r.hasError) throw new TypstError(`Typst could not typeset this document: ${describe(r.diagnostics)}`);
  return {
    exportPdf() {
      const a = world.get_artifact(1, 2) as { result?: Uint8Array; diagnostics?: unknown } | undefined;
      if (!a?.result) throw new TypstError(`Typst could not write the PDF: ${describe(a?.diagnostics)}`);
      return a.result;
    },
  };
}

/** Real page count and size read back from the PDF Typst produced. */
export function inspectPdf(pdf: Uint8Array): { pages: number; width?: number; height?: number } {
  const text = new TextDecoder('latin1').decode(pdf);
  const count = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/s.exec(text)?.[1];
  const pages = count ? Number(count) : (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  return {
    pages,
    width: box ? Math.round((Number(box[3]) - Number(box[1])) * 10) / 10 : undefined,
    height: box ? Math.round((Number(box[4]) - Number(box[2])) * 10) / 10 : undefined,
  };
}

/** Formats Typst can decode. Anything else would abort the whole compile. */
export function isTypstImage(bytes: Uint8Array): boolean {
  const b = bytes;
  if (b.length < 12) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; // WebP
  const head = new TextDecoder().decode(b.subarray(0, 512));
  return /<svg[\s>]/i.test(head);
}
