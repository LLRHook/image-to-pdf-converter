import type { FormatId } from '../../core/formats';
import type { EdgeSpec, StageSpec } from '../../core/types';

/**
 * Structured text: JSON <-> YAML <-> XML, all six directions.
 * (JSON -> CSV/TSV/XLSX/ODS belongs to the sheet engine, not here.)
 *
 * XML <-> JSON/YAML mapping (fast-xml-parser conventions, documented in the notes below):
 *   <item id="1">A</item>   ->  { "item": { "@_id": "1", "#text": "A" } }
 *   <item>A</item>          ->  { "item": "A" }              element with only text
 *   <e/>                    ->  { "e": "" }                  empty element
 *   <i>1</i><i>2</i>        ->  { "i": ["1", "2"] }          repeated siblings become an array
 *   attributes              ->  "@_name" keys, listed first
 *   all values stay strings (XML has no types); the root element is the single top-level key
 * JSON/YAML -> XML: a single top-level key becomes the root element, anything else is wrapped in
 * <root> (arrays become <item> children); "@_x" keys become attributes and "#text" the text.
 * Dropped by design: comments, processing instructions, DTDs, and the order of differently
 * named siblings / text mixed between elements.
 */

const NAMES: Record<string, string> = { json: 'JSON', yaml: 'YAML', xml: 'XML' };
const DECODE: Record<string, string> = {
  json: 'Parse JSON document',
  yaml: 'Parse YAML documents',
  xml: 'Parse XML elements and attributes',
};
const ENCODE: Record<string, string> = { json: 'Write JSON text', yaml: 'Write YAML text', xml: 'Write XML text' };

export function stagesFor(from: FormatId, to: FormatId): StageSpec[] {
  const out: StageSpec[] = [
    { id: 'read', label: `Read ${NAMES[from]} file` },
    { id: 'decode', label: DECODE[from]! },
  ];
  if (to === 'xml') out.push({ id: 'transform', label: 'Map data to XML elements' });
  out.push({ id: 'encode', label: ENCODE[to]! });
  return out;
}

const XML_TO_DATA =
  'Attributes become @_name keys, text beside attributes becomes #text, repeated elements become arrays and every value stays text. Comments and element order across different names are not kept.';
const DATA_TO_XML =
  'A single top-level key becomes the root element, otherwise the data is wrapped in <root>. Keys starting with @_ become attributes and #text the element text.';

export const edges: EdgeSpec[] = [
  {
    from: ['json', 'yaml', 'xml'],
    to: ['json', 'yaml', 'xml'],
    cost: 1,
    fidelity: (from, to) => (from === 'xml' || to === 'xml' ? 'semantic' : 'lossless'),
    stages: stagesFor,
    note: (from, to) => {
      const notes: string[] = [];
      if (from === 'yaml') notes.push('YAML comments are dropped, anchors are expanded and several documents become an array.');
      if (from === 'xml') notes.push(XML_TO_DATA);
      if (to === 'xml') notes.push(DATA_TO_XML);
      return notes.length ? notes.join(' ') : undefined;
    },
  },
];
