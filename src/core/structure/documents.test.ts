import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { findAll, findSegment, flatten } from './invariants';
import { buildXls, concat, fixture, parseChecked, utf8 } from './testkit';

const latin1 = (b: Uint8Array): string => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('PDF', () => {
  it('finds every object by its "N G obj" header with dictionary detail', async () => {
    const bytes = fixture('pil.pdf');
    const st = await parseChecked(bytes, 'pdf');
    const objs = st.segments.filter((s) => / obj$/.test(s.name));
    expect(objs.length).toBe(6);
    for (const o of objs) {
      const text = latin1(bytes.subarray(o.offset, Math.min(o.offset + o.length, o.offset + 24))).replace(/^\s+/, '');
      expect(text.startsWith(o.name)).toBe(true);
    }
    const img = objs.find((o) => o.role === 'media')!;
    expect(img.detail).toContain('/Subtype /Image 200×120 DCT');
    expect(objs.find((o) => o.detail?.startsWith('/Type /Page ·'))!.detail).toContain('200×120 pt');
    expect(st.segments[0]).toMatchObject({ name: '%PDF-1.4', role: 'signature', offset: 0 });
    const names = st.segments.map((s) => s.name);
    expect(names.slice(-4)).toEqual(['xref', 'trailer', 'startxref', '%%EOF']);
    const xref = findSegment(st, 'xref')!;
    expect(xref.detail).toContain('7 entries');
    // startxref points at the xref table we found
    const sx = findSegment(st, 'startxref')!;
    expect(sx.detail).toContain(xref.offset.toLocaleString('en-US'));
    expect(st.summary).toBe('PDF 1.4 · 1 page · 6 objects · 1 image · xref table');
  });

  it('names object streams and xref streams as such (PDF 1.5)', async () => {
    const st = await parseChecked(fixture('gs-15.pdf'), 'pdf');
    expect(st.segments.some((s) => s.name.endsWith('obj (ObjStm)'))).toBe(true);
    expect(st.segments.some((s) => s.name.endsWith('obj (XRef)') && s.role === 'index')).toBe(true);
    expect(st.summary).toContain('xref stream');
    expect(st.summary).toMatch(/\+4 in 1 object stream/);
    expect(findAll(st, 'startxref')).toHaveLength(1);
  });

  it('classifies fonts, content streams, metadata and embedded font programs', async () => {
    const st = await parseChecked(fixture('quartz.pdf'), 'pdf');
    expect(st.segments.some((s) => s.role === 'style' && s.detail?.includes('/Subtype /TrueType'))).toBe(true);
    expect(st.segments.some((s) => s.role === 'style' && s.detail?.includes('embedded font program'))).toBe(true);
    expect(st.segments.some((s) => s.role === 'text' && s.detail?.startsWith('content stream'))).toBe(true);
    expect(st.segments.some((s) => s.role === 'palette' && s.detail?.startsWith('ICC profile'))).toBe(true);
    const gs = await parseChecked(fixture('gs-linear.pdf'), 'pdf');
    expect(gs.segments.some((s) => s.role === 'metadata' && s.detail?.includes('XMP'))).toBe(true);
  });

  it('detects linearized files', async () => {
    const st = await parseChecked(fixture('gs-linear.pdf'), 'pdf');
    expect(st.summary).toContain('linearized');
    expect(st.segments.some((s) => s.detail?.startsWith('linearization parameters'))).toBe(true);
  });

  it('reports incremental updates as extra revisions', async () => {
    const base = fixture('pil.pdf');
    const update = utf8('\n7 0 obj\n<< /Type /Annot /Subtype /Text >>\nendobj\nxref\n7 1\n0000008200 00000 n \ntrailer\n<< /Size 8 /Prev 7923 /Root 4 0 R >>\nstartxref\n8300\n%%EOF\n');
    const st = await parseChecked(concat(base, update), 'pdf');
    expect(findAll(st, '%%EOF')).toHaveLength(2);
    expect(findAll(st, 'trailer')[1]!.detail).toContain('/Prev 7923');
    expect(st.summary).toContain('2 revisions (incremental updates)');
    expect(st.segments.some((s) => s.name === '7 0 obj' && s.detail?.includes('/Annot'))).toBe(true);
  });

  it('does not mistake binary stream contents for objects (direct /Length)', async () => {
    const payload = utf8('junk 9 0 obj << /Type /Page >> endobj endstream\n'.repeat(5));
    const body = concat(utf8(`%PDF-1.4\n1 0 obj\n<< /Length ${payload.length} >>\nstream\n`), payload, utf8('\nendstream\nendobj\n2 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 3 >>\nstartxref\n0\n%%EOF\n'));
    const st = await parseChecked(body, 'pdf');
    const objs = st.segments.filter((s) => / obj$/.test(s.name));
    expect(objs.map((o) => o.name)).toEqual(['1 0 obj', '2 0 obj']);
    expect(objs[0]!.detail).toContain('content stream');
  });

  it('copes with indirect /Length by finding endstream', async () => {
    const payload = utf8('data endobj data');
    const body = concat(utf8('%PDF-1.4\n1 0 obj\n<< /Length 9 0 R >>\nstream\n'), payload, utf8('\nendstream\nendobj\n9 0 obj\n16\nendobj\ntrailer\n<< /Size 10 >>\nstartxref\n0\n%%EOF\n'));
    const st = await parseChecked(body, 'pdf');
    expect(st.segments.filter((s) => / obj$/.test(s.name)).map((o) => o.name)).toEqual(['1 0 obj', '9 0 obj']);
  });

  it('flags encrypted documents', async () => {
    const body = utf8('%PDF-1.6\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF\n');
    const st = await parseChecked(body, 'pdf');
    expect(st.summary).toContain('encrypted');
  });

  it('accepts junk before the header', async () => {
    const st = await parseChecked(concat(utf8('GARBAGE\n'), fixture('pil.pdf')), 'pdf');
    expect(st.segments[0]!.name).toBe('data before header');
    expect(st.segments[1]!.offset).toBe(8);
  });
});

describe('ZIP family', () => {
  it('maps DOCX entries to roles and exposes local header + data', async () => {
    const bytes = fixture('sample.docx');
    const st = await parseChecked(bytes, 'docx');
    const doc = findSegment(st, 'word/document.xml')!;
    expect(doc.role).toBe('text');
    expect(doc.detail).toMatch(/^deflate .* → /);
    expect(findSegment(st, 'word/theme/theme1.xml')!.role).toBe('style');
    expect(findSegment(st, 'docProps/core.xml')!.role).toBe('metadata');
    expect(findSegment(st, '[Content_Types].xml')!.role).toBe('metadata');
    const [lh, data] = doc.children!;
    expect(lh).toMatchObject({ name: 'local file header', role: 'header' });
    expect(data!.name).toBe('data');
    // local header = 30 + name length + extra length (verified from the bytes)
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(lh!.length).toBe(30 + dv.getUint16(doc.offset + 26, true) + dv.getUint16(doc.offset + 28, true));
    const cd = findSegment(st, 'Central directory')!;
    expect(cd.role).toBe('index');
    expect(cd.detail).toBe('8 entries');
    const eocd = findSegment(st, 'End of central directory')!;
    expect(eocd.offset + eocd.length).toBe(bytes.length);
    expect(eocd.role).toBe('trailer');
    expect(cd.offset + cd.length).toBe(eocd.offset);
    expect(st.summary).toMatch(/^DOCX · 8 entries · /);
  });

  it('maps ODT, EPUB, XLSX and ODS', async () => {
    const odt = await parseChecked(fixture('sample.odt'), 'odt');
    expect(findSegment(odt, 'mimetype')!.detail).toContain('stored');
    expect(findSegment(odt, 'content.xml')!.role).toBe('text');
    expect(findSegment(odt, 'styles.xml')!.role).toBe('style');
    const epub = await parseChecked(fixture('sample.epub'), 'epub');
    expect(findSegment(epub, 'OEBPS/ch1.xhtml')!.role).toBe('text');
    expect(findSegment(epub, 'OEBPS/images/cover.png')!.role).toBe('media');
    expect(findSegment(epub, 'OEBPS/content.opf')!.role).toBe('header');
    const xlsx = await parseChecked(fixture('sample.xlsx'), 'xlsx');
    expect(findSegment(xlsx, 'xl/worksheets/sheet1.xml')!.role).toBe('records');
    expect(findSegment(xlsx, 'xl/sharedStrings.xml')!.role).toBe('records');
    const ods = await parseChecked(fixture('sample.ods'), 'ods');
    expect(findSegment(ods, 'content.xml')!.role).toBe('records');
  });

  it('reads the central directory from the end — never the whole file', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) files[`f${i}.bin`] = new Uint8Array(200_000).fill(i);
    const zip = zipSync(files, { level: 0 });
    const reads: number[] = [];
    const src = {
      size: zip.length,
      async read(o: number, n: number) {
        reads.push(n);
        return zip.subarray(o, o + n);
      },
    };
    const { parseStructure } = await import('./index');
    const st = await parseStructure(src, 'zip');
    expect(st.segments.filter((s) => s.name.startsWith('f'))).toHaveLength(40);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(200_000);
  });

  it('merges big archives by directory to stay under the segment cap', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 3000; i++) files[`pages/p${i}.txt`] = utf8(`page ${i}`);
    files['readme.md'] = utf8('hi');
    const st = await parseChecked(zipSync(files), 'zip');
    expect(st.segments.length).toBeLessThan(10);
    const pages = findSegment(st, 'pages/')!;
    expect(pages.count).toBe(3000);
    expect(pages.detail).toContain('3,000 files');
  });

  it('handles archives with prefix data (self-extractors)', async () => {
    const zip = fixture('plain.zip');
    const st = await parseChecked(concat(new Uint8Array(1000).fill(0x4d), zip), 'zip');
    expect(findSegment(st, 'a.txt')!.offset).toBe(1000);
    expect(findSegment(st, 'dir/b.bin')).toBeDefined();
  });

  it('falls back to local headers when the central directory is gone', async () => {
    const zip = fixture('plain.zip');
    const st = await parseChecked(zip.subarray(0, 1150), 'zip');
    expect(findSegment(st, 'a.txt')).toBeDefined();
    expect(st.summary).toContain('damaged');
  });
});

describe('XLS (OLE2)', () => {
  it('maps sectors to FAT, directory and the Workbook stream', async () => {
    const bytes = buildXls();
    const st = await parseChecked(bytes, 'xls');
    expect(st.segments.map((s) => s.name)).toEqual(['header', 'FAT', 'Directory', 'Workbook']);
    expect(st.segments[3]).toMatchObject({ offset: 1536, length: 4096, role: 'records' });
    expect(st.segments[3]!.detail).toContain('BIFF8 workbook stream');
    expect(st.summary).toContain('BIFF8 workbook');
  });
});

describe('Hostile or odd sources', () => {
  it('never throws when the source misbehaves', async () => {
    const { parseStructure } = await import('./index');
    const throwing = { size: 5000, read: async () => { throw new Error('disk on fire'); } };
    const lying = { size: 1e12, read: async () => new Uint8Array(10) };
    const nan = { size: Number.NaN, read: async () => new Uint8Array(0) };
    const neg = { size: -5, read: async () => new Uint8Array(0) };
    const huge = { size: 100, read: async () => new Uint8Array(1_000_000) };
    for (const src of [throwing, lying, nan, neg, huge]) {
      for (const f of ['png', 'jpg', 'mp4', 'mkv', 'pdf', 'zip', 'json', 'csv', 'mp3', 'ogg', 'xls'] as const) {
        const st = await parseStructure(src, f);
        expect(st.format).toBe(f);
        expect(Array.isArray(st.segments)).toBe(true);
      }
    }
  });

  it('reports an empty file without segments', async () => {
    const { parseStructure } = await import('./index');
    const { bytesSource } = await import('./types');
    const st = await parseStructure(bytesSource(new Uint8Array(0)), 'png');
    expect(st.segments).toEqual([]);
    expect(st.summary).toContain('empty');
  });

  it('describes unrecognised bytes as one unknown segment', async () => {
    const st = await parseChecked(new Uint8Array(500).fill(7), 'png');
    expect(st.segments).toHaveLength(1);
    expect(st.segments[0]!.role).toBe('unknown');
    expect(flatten(st.segments)).toHaveLength(1);
  });
});
