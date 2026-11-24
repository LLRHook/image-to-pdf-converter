import type { FormatId } from '../../core/formats';
import type { EdgeSpec, StageSpec } from '../../core/types';

/**
 * Spreadsheet / table conversions (SheetJS, PapaParse, fflate).
 *
 * Inputs : xlsx, xls (read only), ods, csv, tsv, json
 * Outputs: xlsx, ods, csv, tsv, json
 *
 * Conventions (also asserted by the unit tests):
 *  - Workbook -> CSV/TSV writes one file per non-empty sheet; with several sheets the
 *    result is a ZIP (`mayBundle`). Workbook -> JSON is an array of row objects for one
 *    sheet, an object keyed by sheet name for several.
 *  - CSV/JSON -> XLSX/ODS never creates formulas: text such as "=1+1" is stored as text.
 *  - CSV output is RFC 4180 (CRLF, minimal quoting); a UTF-8 BOM is added only when the
 *    text contains non-ASCII characters, which is exactly when Excel needs it to pick
 *    UTF-8 (override with options.bom = true | false). TSV uses LF and never gets a BOM.
 *  - Dates become ISO 8601 text (2024-01-15, 2024-01-15T12:30:00, 12:30:00) in CSV/TSV/JSON.
 */

const SHEET_IN = ['xlsx', 'xls', 'ods'] as const;
const TEXT_IN = ['csv', 'tsv'] as const;
type In = FormatId;

const isBook = (f: In) => f === 'xlsx' || f === 'xls' || f === 'ods';
const isText = (f: In) => f === 'csv' || f === 'tsv';
const isJson = (f: In) => f === 'json';

const READ: Record<string, string> = { xlsx: 'XLSX', xls: 'XLS', ods: 'ODS', csv: 'CSV', tsv: 'TSV', json: 'JSON' };
const DECODE: Record<string, string> = {
  xlsx: 'Parse XLSX workbook',
  xls: 'Parse XLS workbook',
  ods: 'Parse ODS workbook',
  csv: 'Parse CSV rows',
  tsv: 'Parse TSV rows',
  json: 'Parse JSON records',
};
const ENCODE: Record<string, string> = {
  xlsx: 'Write XLSX workbook',
  ods: 'Write ODS workbook',
  csv: 'Write CSV text',
  tsv: 'Write TSV text',
  json: 'Write JSON text',
};

export function stagesFor(from: In, to: In): StageSpec[] {
  const out: StageSpec[] = [
    { id: 'read', label: `Read ${READ[from]} file` },
    { id: 'decode', label: DECODE[from]! },
  ];
  const toBook = to === 'xlsx' || to === 'ods';
  if (isBook(from) && !toBook) out.push({ id: 'transform', label: 'Read cell values and dates' });
  else if (isText(from) && (toBook || to === 'json')) out.push({ id: 'transform', label: 'Detect number and boolean cells' });
  else if (isJson(from)) out.push({ id: 'transform', label: 'Flatten records into columns' });
  out.push({ id: 'encode', label: ENCODE[to]! });
  if ((isBook(from) || isJson(from)) && (to === 'csv' || to === 'tsv')) out.push({ id: 'package', label: 'Package sheet files' });
  return out;
}

export const edges: EdgeSpec[] = [
  // Workbook -> workbook: formulas, values, number formats and merges carry over.
  {
    from: SHEET_IN,
    to: ['xlsx', 'ods'],
    cost: 2,
    fidelity: 'semantic',
    stages: stagesFor,
    note: () => 'Cell styling, charts and images are not carried over; values, formulas and number formats are.',
  },
  // Workbook -> CSV / TSV: one file per sheet, bundled as a ZIP when there are several.
  {
    from: SHEET_IN,
    to: ['csv', 'tsv'],
    cost: 2,
    fidelity: 'semantic',
    mayBundle: true,
    stages: stagesFor,
    note: () => 'Formulas become their saved result and dates become ISO text. Several sheets are returned as a ZIP, one file each.',
  },
  // Workbook -> JSON.
  {
    from: SHEET_IN,
    to: ['json'],
    cost: 2,
    fidelity: 'semantic',
    stages: stagesFor,
    note: () => 'The first row becomes the keys. Several sheets become an object keyed by sheet name.',
  },
  // CSV / TSV -> workbook: typed cells, nothing becomes a formula.
  {
    from: TEXT_IN,
    to: ['xlsx', 'ods'],
    cost: 2,
    fidelity: 'lossless',
    stages: stagesFor,
    note: () => 'Plain numbers and TRUE/FALSE become typed cells; text such as 007 or =1+1 stays text.',
  },
  // CSV <-> TSV.
  {
    from: TEXT_IN,
    to: ['csv', 'tsv'],
    cost: 1,
    fidelity: 'lossless',
    stages: stagesFor,
  },
  // CSV / TSV -> JSON.
  {
    from: TEXT_IN,
    to: ['json'],
    cost: 1.5,
    fidelity: 'lossless',
    stages: stagesFor,
    note: () => 'The first row becomes the keys. Plain numbers and TRUE/FALSE are typed; empty cells become null.',
  },
  // JSON -> workbook / CSV / TSV. (json <-> yaml <-> xml lives in the datatree engine.)
  {
    from: ['json'],
    to: ['xlsx', 'ods'],
    cost: 2,
    fidelity: 'lossless',
    stages: stagesFor,
    note: () => 'Expects an array of records, or an object of arrays (one sheet each). Nested values are stored as JSON text.',
  },
  {
    from: ['json'],
    to: ['csv', 'tsv'],
    cost: 2,
    fidelity: 'semantic',
    mayBundle: true,
    stages: stagesFor,
    note: () => 'Expects an array of records, or an object of arrays (one file each, as a ZIP). Nested values are stored as JSON text.',
  },
];
