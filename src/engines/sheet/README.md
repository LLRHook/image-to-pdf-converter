# sheet engine

xlsx · xls (read only) · ods · csv · tsv · json  →  xlsx · ods · csv · tsv · json
(SheetJS CE 0.20.3, PapaParse, fflate; everything runs in the worker, nothing is stored.)

## Decisions

| Topic | Behaviour |
|---|---|
| Types | CSV/TSV text becomes typed cells only when it survives a round trip: plain numbers (≤15 significant digits) and `true/false`. `007`, `+1`, `1e3`, 16-digit IDs and `=1+1` stay text. `1.50` becomes the number 1.5 with a `0.00` format. JSON values keep their JSON types (a string `"007"` is never re-typed). |
| Formulas | CSV/JSON → XLSX/ODS never creates a formula: strings are always string cells. Workbook → workbook keeps the source's formulas, values, number formats, merges. |
| Dates | Never go through `Date` (time-zone dependent). Numeric cells with a date format are formatted from the serial number: `2024-01-15`, `2024-01-15T12:30:00`, `12:30:00` in CSV/TSV/JSON. Elapsed formats (`[h]:mm:ss`) become `H:MM:SS`. |
| Errors / formulas in CSV, JSON | Formulas export their saved result; error cells export as text (`#DIV/0!`). Display formatting (currency, %, …) is not applied: raw values are exported. |
| CSV output | RFC 4180: CRLF, quote only when needed. UTF-8 **BOM only when the text contains non-ASCII** (exactly when Excel needs it to pick UTF-8; pure-ASCII files are byte-identical either way). `options.bom = true/false` forces it. TSV: LF, quoting like CSV, never a BOM. `options.escapeFormulae = true` prefixes `= + - @` text with `'`. |
| CSV input | Delimiter auto-detected (`, ; tab |`), TSV is tab. BOM stripped; invalid UTF-8 falls back to Windows-1252; UTF-16 with BOM is read. Blank lines are skipped, ragged rows are kept. |
| Multiple sheets | Workbook/JSON object → CSV/TSV: one file per non-empty sheet, ZIP when more than one (`bundle`); a single non-empty sheet gives a plain file. Names are made path-safe and unique. |
| JSON out | One non-empty sheet: array of row objects (first row = keys; empty keys → `Column N`, duplicates → `name_2`; empty cells → `null`). Several: object keyed by sheet name. `options.header = false` gives arrays of arrays. |
| JSON in | `[ {…} ]` records (columns = union of keys, first-seen order) · `[ […] ]` rows · `[scalars]` → `value` column · `{ "Sheet": [...] }` one sheet per key · single object → one row. Nested objects/arrays are stored as compact JSON text. |
| ODS dates | SheetJS CE's ODS writer drops unquoted separators such as the dashes in `yyyy-mm-dd`; date formats are rewritten with quoted separators before writing. Error cells are written as their text (the ODS writer would drop them). |
| Not carried over | Styling, charts, images, conditional formats, pivot tables (SheetJS CE has no style support). |

## Limits (reject with a message, never truncate)

* input ≤ 200 MB; ZIP containers: ≤ 1 GiB / ≤ 400 MiB per part really inflated (counted while streaming), ≤ 2,000 parts
* XLSX/ODS: ≤ 1,048,576 rows, ≤ 16,384 columns, ≤ 32,767 characters per XLSX cell, ≤ 256 sheets
* ≤ 50,000,000 cells in memory; ODS `number-rows/columns-repeated` expansion of valued cells is bounded by the same budget
* CSV → 1,048,576 rows is the practical ceiling for XLSX (≈25 s, ≈2 GB RSS measured in Node); ODS is written as one string and fails above ≈ 1M rows

## Stages

`read` (bytes) → `decode` (CSV: chars consumed; workbook/JSON: unmeasured) → `transform` (rows done; text→table
inference, workbook cell reading, JSON flattening) → `encode` (rows written for CSV/TSV/JSON; unmeasured for XLSX/ODS) → `package` (workbook/JSON → CSV/TSV only).
