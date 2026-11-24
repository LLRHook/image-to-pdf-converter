import { formatInfo, outputName } from '../../core/formats';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import {
  bundleZip, canBundle, decodeDocument, isDocumentTarget, loadPandoc, logPandocWarnings, prepareDocument, writeDocument,
} from './pandoc';
import { baseNameOf } from './text';

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { to } = req;
  if (!isDocumentTarget(to)) throw new Error(`pandoc cannot write ${to}`);
  // Fail on the wrong kind of file before downloading 16 MB of wasm.
  const input = await prepareDocument(req);

  ctx.stage('load');
  const pandoc = await loadPandoc(ctx);

  const read = await decodeDocument(pandoc, input, ctx);

  ctx.stage('encode');
  const title = baseNameOf(req.name);
  const written = await writeDocument(pandoc, read, to, { title });
  logPandocWarnings(ctx, written.warnings);

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
