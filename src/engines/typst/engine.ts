import { formatInfo } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import { decodeDocument, loadPandoc, prepareDocument, writeTypst } from '../pandoc/pandoc';
import { baseNameOf } from '../pandoc/text';
import { inspectPdf, isTypstImage, loadTypst, typeset } from './compile';

/** Unicode scripts the bundled Latin/Greek/Cyrillic fonts cannot draw. */
const UNSUPPORTED_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Ethiopic}\p{Extended_Pictographic}]/u;

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { to } = req;
  if (to !== 'pdf') throw new Error(`typst cannot write ${to}`);
  const input = await prepareDocument(req);

  ctx.stage('load');
  const [pandoc, typst] = await Promise.all([loadPandoc(ctx), loadTypst(ctx)]);

  const read = await decodeDocument(pandoc, input, ctx);

  ctx.stage('transform');
  const typ = await writeTypst(pandoc, read, { title: baseNameOf(req.name), keepImage: (m) => isTypstImage(m.bytes) });
  const dropped = read.images.length - typ.media.length;
  if (dropped > 0) ctx.log(`${dropped} image(s) could not be placed (unsupported format or not embedded in the file); their descriptions are shown instead.`);
  if (UNSUPPORTED_SCRIPTS.test(typ.source)) {
    ctx.log('Some characters (CJK, Arabic, Indic scripts or emoji) have no glyph in the bundled fonts and will be blank in the PDF.');
  }
  const files = new Map(typ.media.map((m) => [m.name, m.bytes] as const));
  const compiled = typeset(typst, typ.source, files);

  ctx.stage('encode');
  const pdf = compiled.exportPdf();
  const info = inspectPdf(pdf);
  ctx.facts({ kind: 'pages', pages: info.pages, width: info.width, height: info.height });

  return { output: pdf, ext: 'pdf', mime: formatInfo('pdf').mime };
}

export default { convert } satisfies Engine;
