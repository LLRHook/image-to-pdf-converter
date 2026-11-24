/**
 * Datatree engine: JSON <-> YAML <-> XML (all six directions).
 *
 * Pipeline per job (stages match edges.ts): read -> decode -> [transform: data -> XML] -> encode.
 * Options (optional): `rootName` (string, default "root") names the wrapper element
 * when JSON/YAML data has no single top-level key.
 */
import YAML from 'yaml';
import { formatInfo } from '../../core/formats';
import { fmtN } from '../../core/structure/text';
import type { ConvertRequest, ConvertResult, Engine, EngineContext } from '../../core/types';
import { assertInputSize, decodeText, readBlob } from '../shared/io';
import { LIMITS, analyze, outline, type Json } from './tree';
import { buildXml, parseXml } from './xmlmap';

function parseJson(text: string): Json {
  if (!text.trim()) throw new Error('The file is empty.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`This is not valid JSON: ${(e as Error).message}`);
  }
}

function parseYaml(text: string, ctx: EngineContext): Json {
  if (!text.trim()) throw new Error('The file is empty.');
  const docs = YAML.parseAllDocuments(text, {
    merge: true, // honour << merge keys, as docker-compose / CI configs expect
    uniqueKeys: true,
    prettyErrors: true,
  });
  if (docs.length > LIMITS.yamlDocuments) throw new Error(`The YAML has more than ${fmtN(LIMITS.yamlDocuments)} documents.`);
  const values: Json[] = [];
  for (const doc of docs) {
    const err = doc.errors[0];
    if (err) {
      const where = err.linePos?.[0] ? ` (line ${err.linePos[0].line}, column ${err.linePos[0].col})` : '';
      const msg = err.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '');
      if (/call stack/i.test(err.message)) throw new Error('The YAML is nested too deeply to convert.');
      throw new Error(`This is not valid YAML: ${msg}${where}`);
    }
    if (doc.warnings[0]) ctx.log(`YAML: ${doc.warnings[0].message.split('\n')[0]}`);
    try {
      values.push(doc.toJS({ maxAliasCount: LIMITS.yamlAliasCount }));
    } catch (e) {
      if (e instanceof ReferenceError || /alias/i.test((e as Error).message)) {
        throw new Error('The YAML expands its aliases far too aggressively (a "billion laughs" style attack), so it was not converted.');
      }
      throw e;
    }
  }
  if (values.length > 1) {
    ctx.log(`The YAML has ${values.length} documents; they become one array.`);
    return values;
  }
  return values.length === 1 ? values[0] : null;
}

/** XML may declare a legacy encoding; honour it when the bytes are not UTF-8/UTF-16 with a BOM. */
function decodeXml(bytes: Uint8Array): string {
  const bom = bytes[0] === 0xef || bytes[0] === 0xff || bytes[0] === 0xfe;
  if (!bom) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
    const label = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
    if (label && !/^utf-?8$/i.test(label)) {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        /* unknown label: fall through to UTF-8 */
      }
    }
  }
  return decodeText(bytes).text;
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  const { from, to } = req;
  assertInputSize(req.input.size, LIMITS.inputBytes);
  try {
    return await run(req, ctx, from, to);
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message)) throw new Error('The data is nested too deeply to convert.');
    if (e instanceof RangeError && /string length|allocation/i.test(e.message)) throw new Error('The result is too large to build in the browser. Try a smaller file.');
    throw e;
  }
}

async function run(req: ConvertRequest, ctx: EngineContext, from: string, to: string): Promise<ConvertResult> {
  ctx.stage('read');
  const bytes = await readBlob(req.input, ctx);

  ctx.stage('decode');
  let data: Json;
  if (from === 'xml') data = parseXml(decodeXml(bytes));
  else if (from === 'yaml') data = parseYaml(decodeText(bytes).text, ctx);
  else data = parseJson(decodeText(bytes).text);

  const stats = analyze(data);
  ctx.facts({ kind: 'tree', nodes: stats.nodes, depth: stats.depth });
  ctx.preview({ kind: 'outline', items: outline(data) });
  if (stats.unsafeInts > 0) {
    ctx.log(`${fmtN(stats.unsafeInts)} integer(s) are larger than 2^53 and may have lost precision when read.`);
  }

  const info = formatInfo(to as 'json' | 'yaml' | 'xml');
  let text: string;
  if (to === 'xml') {
    ctx.stage('transform');
    let done = 0;
    const rootName = typeof req.options.rootName === 'string' && req.options.rootName ? req.options.rootName : 'root';
    const built = buildXml(data, rootName, (n) => {
      done += n;
      ctx.progress(Math.min(1, done / stats.nodes));
    });
    if (built.wrapped) ctx.log(`The data has no single top-level key, so it is wrapped in <${built.root}>.`);
    if (built.renamed > 0) ctx.log(`${fmtN(built.renamed)} key(s) were renamed to valid XML names.`);
    ctx.stage('encode');
    text = built.xml;
  } else if (to === 'yaml') {
    ctx.stage('encode');
    // YAML 1.1 mode quotes strings such as yes/no/on/off and 2001-12-14 so PyYAML-style readers keep them as text.
    text = YAML.stringify(data, { indent: 2, lineWidth: 0, version: '1.1' });
  } else {
    ctx.stage('encode');
    text = JSON.stringify(data, null, 2) + '\n';
  }
  return { output: new Blob([text], { type: info.mime }), ext: info.exts[0]!, mime: info.mime };
}

export default { convert } satisfies Engine;
