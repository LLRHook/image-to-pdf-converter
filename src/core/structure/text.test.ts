import { describe, expect, it } from 'vitest';
import { findAll, findSegment, flatten } from './invariants';
import { concat, countingSource, fixture, parseChecked, utf8 } from './testkit';
import { parseStructure } from './index';

const slice = (bytes: Uint8Array, s: { offset: number; length: number }): string => new TextDecoder().decode(bytes.subarray(s.offset, s.offset + s.length));

describe('JSON', () => {
  it('uses top-level keys as segments and nests members with real byte ranges', async () => {
    const bytes = fixture('sample.json');
    const st = await parseChecked(bytes, 'json');
    expect(st.segments.map((s) => s.name)).toEqual(['name', 'version', 'tags', 'nested', 'ok']);
    const nested = findSegment(st, 'nested')!;
    expect(slice(bytes, nested).startsWith('"nested"')).toBe(true);
    expect(nested.detail).toBe('object · 2 keys');
    expect(findSegment(st, 'tags')!.detail).toBe('array · 3 items');
    expect(findSegment(st, 'z')!.children).toHaveLength(3);
    expect(st.segments[0]!.offset).toBe(0);
    expect(st.segments.at(-1)!.offset + st.segments.at(-1)!.length).toBe(bytes.length);
    expect(st.summary).toBe('JSON object · 5 keys · UTF-8');
  });

  it('reports byte (not character) offsets for multi-byte text', async () => {
    const bytes = utf8('{"naïve":"日本語","emoji":"😀😀","last":[1,2]}');
    const st = await parseChecked(bytes, 'json');
    const last = findSegment(st, 'last')!;
    expect(slice(bytes, last)).toBe('"last":[1,2]}');
    const emoji = findSegment(st, 'emoji')!;
    expect(slice(bytes, emoji)).toBe('"emoji":"😀😀",');
    expect(emoji.detail).toBe('string · 8 B');
    expect(findSegment(st, 'naïve')!.detail).toBe('string · 9 B');
  });

  it('groups big arrays into at most 500 counted ranges', async () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const bytes = utf8(JSON.stringify(items));
    const st = await parseChecked(bytes, 'json');
    expect(st.segments.length).toBeLessThanOrEqual(500);
    expect(st.segments.reduce((a, s) => a + (s.count ?? 1), 0)).toBe(5000);
    expect(st.summary).toContain('array · 5,000 items');
  });

  it('keeps going past invalid JSON and flags the damage', async () => {
    const st = await parseChecked(utf8('{"a":1,"b":[1,2,"c":3}'), 'json');
    expect(st.segments.length).toBeGreaterThanOrEqual(1);
    expect(st.segments.at(-1)!.name).toBe('invalid JSON');
    expect(st.segments[0]!.name).toBe('a');
  });

  it('survives absurd nesting without recursion', async () => {
    const st = await parseChecked(utf8('['.repeat(200_000) + ']'.repeat(200_000)), 'json');
    expect(st.segments.length).toBeGreaterThan(0);
  });

  it('detects JSON Lines', async () => {
    const st = await parseChecked(utf8('{"a":1}\n{"a":2}\n{"a":3}\n'), 'json');
    expect(st.summary).toContain('JSON Lines · 3 records');
  });
});

describe('YAML', () => {
  it('lists top-level keys with value summaries', async () => {
    const st = await parseChecked(fixture('sample.yaml'), 'yaml');
    expect(st.segments.map((s) => s.name)).toEqual(['name', 'version', 'items', 'nested', 'text']);
    expect(findSegment(st, 'items')!.detail).toBe('sequence · 2 items');
    expect(findSegment(st, 'nested')!.detail).toBe('mapping · 2 keys');
    expect(findSegment(st, 'text')!.detail).toBe('block scalar · 2 lines');
    expect(findSegment(st, 'name')!.detail).toBe('demo');
  });

  it('splits multi-document streams', async () => {
    const st = await parseChecked(utf8('---\na: 1\nb: 2\n---\nc: 3\n---\n- x\n- y\n'), 'yaml');
    expect(st.segments.map((s) => s.name)).toEqual(['document 1', 'document 2', 'document 3']);
    expect(st.segments[0]!.children!.map((c) => c.name)).toEqual(['a', 'b']);
    expect(st.summary).toContain('3 documents');
  });
});

describe('CSV / TSV', () => {
  it('reads the header and respects quoted newlines', async () => {
    const bytes = fixture('sample.csv');
    const st = await parseChecked(bytes, 'csv');
    expect(st.segments[0]).toMatchObject({ name: 'header row', role: 'header' });
    expect(st.segments[0]!.detail).toBe('3 columns: id, name, score');
    expect(st.segments.length).toBe(4);
    const multi = st.segments[2]!;
    expect(slice(bytes, multi)).toBe('2,"multi\nline",7\n');
    expect(st.summary).toBe('CSV · 3 data rows × 3 columns · comma-delimited · ASCII');
  });

  it('merges thousands of rows into counted blocks', async () => {
    const rows = ['a,b,c', ...Array.from({ length: 10_000 }, (_, i) => `${i},x${i},${i * 2}`)];
    const bytes = utf8(rows.join('\n') + '\n');
    const st = await parseChecked(bytes, 'csv');
    const blocks = st.segments.slice(1);
    expect(blocks.length).toBeLessThanOrEqual(64);
    expect(blocks.reduce((a, s) => a + (s.count ?? 1), 0)).toBe(10_000);
    expect(blocks[0]!.detail).toContain('× 3 columns');
    expect(st.summary).toContain('10,000 data rows × 3 columns');
  });

  it('reports ragged rows and picks the delimiter', async () => {
    const st = await parseChecked(utf8('a;b;c\n1;2\n3;4;5;6\n'), 'csv');
    expect(st.summary).toContain('semicolon-delimited');
    expect(st.summary).toContain('ragged rows (2–4 columns)');
  });

  it('parses TSV', async () => {
    const st = await parseChecked(fixture('sample.tsv'), 'tsv');
    expect(st.summary).toBe('TSV · 2 data rows × 2 columns · tab-delimited · ASCII');
  });

  it('handles CRLF and a UTF-8 BOM', async () => {
    const bytes = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8('é,b\r\n1,2\r\n3,4\r\n'));
    const st = await parseChecked(bytes, 'csv');
    expect(st.segments.length).toBe(3);
    expect(st.summary).toContain('UTF-8 (BOM)');
  });
});

describe('Markdown', () => {
  it('nests sections by heading level and ignores fenced code', async () => {
    const bytes = fixture('sample.md');
    const st = await parseChecked(bytes, 'md');
    expect(st.segments.map((s) => s.name)).toEqual(['front matter', 'preface', '# Title']);
    const title = findSegment(st, '# Title')!;
    expect(title.children!.map((c) => c.name)).toEqual(['## Section A', '## Section B', '## Setext Heading']);
    expect(title.detail).toContain('1 code block');
    expect(findSegment(st, '## Section A')!.detail).toContain('1 code block');
    expect(slice(bytes, findSegment(st, '## Section B')!).startsWith('## Section B')).toBe(true);
    expect(st.summary).toContain('4 headings');
  });

  it('describes heading-less documents as one body', async () => {
    const st = await parseChecked(utf8('just text\nand more\n'), 'md');
    expect(st.segments.map((s) => s.name)).toEqual(['body']);
  });
});

describe('Plain text', () => {
  it('splits paragraphs with real counts', async () => {
    const bytes = fixture('sample.txt');
    const st = await parseChecked(bytes, 'txt');
    expect(st.segments.map((s) => s.name)).toEqual(['paragraph 1', 'paragraph 2', 'paragraph 3']);
    expect(st.segments[0]!.detail).toBe('3 lines · 6 words');
    expect(slice(bytes, st.segments[1]!)).toBe('Second paragraph.\n\n');
    expect(st.summary).toBe('Plain text · 6 lines · 9 words · 3 paragraphs · ASCII');
  });

  it('falls back to line ranges, merged into at most 64 blocks', async () => {
    const bytes = utf8(Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'));
    const st = await parseChecked(bytes, 'txt');
    expect(st.segments.length).toBeLessThanOrEqual(64);
    expect(st.segments.reduce((a, s) => a + (s.count ?? 1), 0)).toBe(5000);
    expect(st.segments[0]!.name).toMatch(/^lines 1–/);
  });
});

describe('RTF', () => {
  it('separates header groups from the body', async () => {
    const bytes = fixture('sample.rtf');
    const st = await parseChecked(bytes, 'rtf');
    const names = st.segments.map((s) => s.name);
    expect(names).toContain('font table');
    expect(names).toContain('colour table');
    expect(names).toContain('body');
    expect(names.at(-1)).toBe('closing brace');
    expect(findSegment(st, 'font table')!.detail).toContain('Times-Bold');
    expect(findSegment(st, 'colour table')!.role).toBe('palette');
    expect(findSegment(st, 'body')!.detail).toMatch(/\d+ paragraph breaks?/);
    expect(slice(bytes, st.segments.at(-1)!)).toBe('}');
    expect(st.summary).toContain('RTF 1 · code page 1252');
  });

  it('finds pictures inside the body', async () => {
    const rtf = utf8('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard Hello\\par {\\pict\\pngblip\\picw10\\pich10 89504e47}\\par}');
    const st = await parseChecked(rtf, 'rtf');
    expect(findSegment(st, 'picture')!.detail).toContain('png 10×10');
    expect(findSegment(st, 'body')!.detail).toContain('2 paragraph breaks');
  });
});

describe('LaTeX', () => {
  it('separates the preamble from the document and nests sections', async () => {
    const bytes = fixture('sample.tex');
    const st = await parseChecked(bytes, 'tex');
    expect(st.segments.map((s) => s.name)).toEqual(['preamble', 'document']);
    const pre = st.segments[0]!;
    expect(pre.children!.map((c) => c.name)).toEqual(['documentclass', 'usepackage', 'definitions', 'title block']);
    expect(pre.children![1]!.count).toBe(2);
    const doc = st.segments[1]!;
    const intro = doc.children!.find((c) => c.name === '\\section{Intro}')!;
    expect(intro.children!.map((c) => c.name)).toEqual(['\\subsection{Detail}']);
    // a commented-out \section must not count
    expect(flatten(st.segments).some((s) => s.name.includes('fake'))).toBe(false);
    expect(slice(bytes, doc).startsWith('\\begin{document}')).toBe(true);
    expect(st.summary).toContain('full document');
    expect(st.summary).toContain('3 sections');
  });
});

describe('HTML / XML', () => {
  it('builds head/body trees with implied closing tags and raw-text elements', async () => {
    const bytes = fixture('sample.html');
    const st = await parseChecked(bytes, 'html');
    const html = findSegment(st, 'html')!;
    expect(html.children!.map((c) => c.name)).toEqual(['head', 'body']);
    expect(findSegment(st, 'script')!.role).toBe('records'); // the "<p>" inside it was not parsed as a tag
    expect(findSegment(st, 'title')!.detail).toBe('Sample page');
    expect(findSegment(st, 'p')!.count).toBe(2); // unclosed <p> elements
    expect(findSegment(st, 'li')!.count).toBe(2);
    expect(findSegment(st, 'img')!.role).toBe('media');
    expect(slice(bytes, findSegment(st, 'h1')!).startsWith('<h1 id="top">')).toBe(true);
    expect(st.summary).toContain('HTML "Sample page"');
  });

  it('lists XML root children, merging repeated elements', async () => {
    const st = await parseChecked(fixture('sample.xml'), 'xml');
    const root = findSegment(st, 'catalog')!;
    expect(root.children!.map((c) => [c.name, c.count])).toEqual([['book', 3], ['note', undefined]]);
    expect(st.segments[0]!.name).toBe('XML declaration');
    expect(st.summary).toBe('XML <catalog> · 8 elements · ASCII');
  });

  it('survives unclosed and mismatched tags', async () => {
    const st = await parseChecked(utf8('<a><b><c></b></a><d>'), 'xml');
    expect(st.segments.length).toBeGreaterThan(0);
    const deep = '<x>'.repeat(30_000);
    const st2 = await parseChecked(utf8(deep), 'xml');
    expect(st2.segments.length).toBeGreaterThan(0);
  });
});

describe('read budget', () => {
  it('caps reads at 8 MB and flags truncation on huge text files', async () => {
    const line = 'col1,col2,col3\n';
    const bytes = utf8(line.repeat(Math.ceil((20 * 1024 * 1024) / line.length)));
    const src = countingSource(bytes);
    const st = await parseStructure(src, 'csv');
    expect(st.truncated).toBe(true);
    expect(src.bytesRead).toBeLessThanOrEqual(8 * 1024 * 1024 + 300_000);
    expect(st.segments.at(-1)!.name).toBe('beyond read limit');
    expect(st.segments.at(-1)!.offset + st.segments.at(-1)!.length).toBe(bytes.length);
  });

  it('honours a custom maxBytes', async () => {
    const bytes = utf8('abc\n'.repeat(100_000));
    const src = countingSource(bytes);
    const st = await parseStructure(src, 'txt', { maxBytes: 1000 });
    expect(st.truncated).toBe(true);
    expect(src.bytesRead).toBeLessThanOrEqual(1000);
  });
});

void findAll;
