/**
 * XML <-> plain data, on top of fast-xml-parser. See edges.ts for the mapping.
 */
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { LIMITS, isObj, type Json } from './tree';

const ATTR = '@_';
const TEXT = '#text';

/** Only the five predefined XML entities are named; `htmlEntities` being truthy is what makes the parser decode &#65; / &#x41;. */
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Entity safety, checked on the raw text before parsing: no external or parameter
 * entities, no entity defined in terms of another (the "billion laughs" shape).
 * The parser additionally caps count, size and total expansion.
 */
export function checkEntities(xml: string): void {
  if (!xml.includes('<!ENTITY')) return;
  if (/<!ENTITY\s+%/.test(xml)) throw new Error('This XML declares parameter entities, which are not supported.');
  if (/<!ENTITY\s+[^\s>]+\s+(?:SYSTEM|PUBLIC)\b/i.test(xml)) {
    throw new Error('This XML declares external entities (SYSTEM/PUBLIC). They are never loaded, so the file cannot be converted.');
  }
  const names = new Set<string>();
  const values: string[] = [];
  for (const m of xml.matchAll(/<!ENTITY\s+([^\s>]+)\s+(?:"([^"]*)"|'([^']*)')/g)) {
    names.add(m[1]!);
    values.push(m[2] ?? m[3] ?? '');
  }
  if (names.size > 100) throw new Error('This XML declares more than 100 entities.');
  for (const v of values) {
    for (const ref of v.matchAll(/&([A-Za-z_][\w.\-]*);/g)) {
      if (names.has(ref[1]!)) throw new Error('This XML defines an entity in terms of another entity (possible "billion laughs" attack), which is not supported.');
    }
  }
}

export function parseXml(xml: string): Json {
  checkEntities(xml);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const e = valid.err;
    throw new Error(`This is not valid XML: ${e.msg}${e.line ? ` (line ${e.line}${e.col ? `, column ${e.col}` : ''})` : ''}`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    textNodeName: TEXT,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    // The typings say boolean, but the parser accepts a name -> text map here (see XML_ENTITIES).
    htmlEntities: XML_ENTITIES as unknown as boolean,
    processEntities: { enabled: true, maxEntitySize: 10_000, maxExpansionDepth: 1, maxTotalExpansions: 1000, maxExpandedLength: 1_000_000, maxEntityCount: 100 },
    maxNestedTags: LIMITS.depth,
  });
  let raw: Json;
  try {
    raw = parser.parse(xml);
  } catch (e) {
    throw new Error(`This XML cannot be converted: ${(e as Error).message}`);
  }
  return tidy(raw, 0);
}

/** Order keys as attributes, text, children (the parser lists attributes last). */
function tidy(v: Json, depth: number): Json {
  if (Array.isArray(v)) return v.map((x) => tidy(x, depth + 1));
  if (!isObj(v)) return v;
  if (depth > LIMITS.depth) throw new Error(`The data is nested more than ${LIMITS.depth} levels deep, which is not supported.`);
  const out: Record<string, Json> = Object.create(null);
  const keys = Object.keys(v);
  for (const k of keys) if (k.startsWith(ATTR)) out[k] = v[k];
  if (TEXT in v) out[TEXT] = v[TEXT];
  for (const k of keys) if (!k.startsWith(ATTR) && k !== TEXT) out[k] = tidy(v[k], depth + 1);
  return out;
}

/* ------------------------------------------------------------------ output */

const NAME_START = /[\p{L}_]/u;
const NAME_CHAR = /[\p{L}\p{N}_.\-:·̀-ͯ]/u;

/** A legal XML name: illegal characters become "_", and a leading digit/dash/dot gets a "_" prefix. */
export function xmlName(raw: string): string {
  let out = '';
  for (const ch of raw) out += NAME_CHAR.test(ch) ? ch : '_';
  if (!out) return '_';
  if (!NAME_START.test(out[0]!) || out[0] === ':') out = '_' + out;
  return out;
}

const BAD_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function xmlText(s: string): string {
  const m = BAD_XML_CHAR.exec(s);
  if (m) {
    const cp = m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`A text value contains the character U+${cp}, which XML 1.0 cannot represent.`);
  }
  return s;
}

export interface XmlBuild {
  xml: string;
  root: string;
  wrapped: boolean;
  renamed: number;
}

export function buildXml(data: Json, rootName: string, onNodes: (n: number) => void): XmlBuild {
  let renamed = 0;
  let pending = 0;
  const tick = () => {
    if (++pending === 4096) {
      onNodes(pending);
      pending = 0;
    }
  };
  const name = (raw: string) => {
    const n = xmlName(raw);
    if (n !== raw) renamed++;
    return n;
  };
  const scalar = (v: Json): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return xmlText(v);
    if (typeof v === 'object') return xmlText(JSON.stringify(v));
    return String(v);
  };

  const content = (v: Json): Json => {
    tick();
    if (Array.isArray(v)) {
      if (v.length === 0) return ''; // an empty array is kept as an empty element, not dropped
      return v.map((x) => (Array.isArray(x) ? { item: x.length ? x.map(content) : '' } : content(x)));
    }
    if (isObj(v)) {
      const out: Record<string, Json> = Object.create(null);
      for (const [k, val] of Object.entries(v)) {
        if (k === TEXT) {
          out[TEXT] = scalar(val);
          tick();
        } else if (k.startsWith(ATTR)) {
          let a = ATTR + name(k.slice(ATTR.length));
          for (let i = 2; a in out; i++) a = `${ATTR}${xmlName(k.slice(ATTR.length))}_${i}`;
          out[a] = scalar(val);
          tick();
        } else {
          let e = name(k);
          for (let i = 2; e in out; i++) e = `${xmlName(k)}_${i}`;
          out[e] = content(val);
        }
      }
      return Object.keys(out).length === 0 ? '' : out;
    }
    return scalar(v);
  };

  let root = xmlName(rootName);
  let body: Json;
  let wrapped = true;
  const keys = isObj(data) ? Object.keys(data) : [];
  if (isObj(data) && keys.length === 1 && !keys[0]!.startsWith(ATTR) && keys[0] !== TEXT && !Array.isArray(data[keys[0]!])) {
    root = name(keys[0]!);
    body = content(data[keys[0]!]);
    wrapped = false;
  } else if (Array.isArray(data)) {
    body = data.length === 0 ? '' : { item: data.map((x) => (Array.isArray(x) ? { item: x.length ? x.map(content) : '' } : content(x))) };
  } else {
    body = content(data);
  }
  if (pending) onNodes(pending);

  const doc: Record<string, Json> = Object.create(null);
  doc[root] = body;
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    textNodeName: TEXT,
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    processEntities: true,
    suppressBooleanAttributes: false,
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
  return { xml: xml.endsWith('\n') ? xml : xml + '\n', root, wrapped, renamed };
}
