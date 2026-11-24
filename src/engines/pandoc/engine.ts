import { formatInfo, outputName, type FormatId } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import { assertContainer } from './container';
import { LIMITS, assertMarkdownTractable, formatBytes } from './limits';
import { bundleZip, isDocumentTarget, loadPandoc, readDocument, writeDocument, canBundle } from './pandoc';
import { DOC_NAMES } from './spec';
import { baseNameOf, decodeText } from './text';

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { from, to } = req;
  if (!isDocumentTarget(to)) throw new Error(`pandoc cannot write ${to}`);
  if (req.input.size > LIMITS.inputBytes) {
    throw new Error(`This file is ${formatBytes(req.input.size)}; the limit for document conversion is ${formatBytes(LIMITS.inputBytes)}.`);
  }
  const bytes = new Uint8Array(await req.input.arrayBuffer());
  // Fail on the wrong kind of file before downloading 16 MB of wasm.
  assertContainer(from, bytes);
  if (from === 'md') assertMarkdownTractable(decodeText(bytes).text);

  ctx.stage('load');
  const pandoc = await loadPandoc(ctx);

  ctx.stage('decode');
  const read = await readDocument(pandoc, { bytes, from, label: DOC_NAMES[from as FormatId] ?? from });
  ctx.facts(read.analysis.facts);
  ctx.preview(read.analysis.outline);
  for (const w of read.warnings.slice(0, 5)) ctx.log(`pandoc: ${w}`);

  ctx.stage('encode');
  const title = baseNameOf(req.name);
  const written = await writeDocument(pandoc, read, to, { title });
  for (const w of written.warnings.slice(0, 5)) ctx.log(`pandoc: ${w}`);

  const info = formatInfo(to);
  if (canBundle(to)) {
    ctx.stage('package');
    if (written.mediaUsed.length > 0) {
      const zip = bundleZip(outputName(req.name, info.exts[0]!), written.bytes, written.mediaUsed);
      return {
        output: zip,
        ext: 'zip',
        mime: formatInfo('zip').mime,
        bundle: { count: 1 + written.mediaUsed.length, ext: info.exts[0]! },
      };
    }
  }
  return { output: written.bytes, ext: info.exts[0]!, mime: info.mime };
}

export default { convert } satisfies Engine;
