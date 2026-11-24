import { beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import type { ConvertResult } from '../../core/types';
import { PANDOC_SOURCES, PANDOC_TARGETS } from './spec';
import { edges } from './edges';
import engine from './engine';
import { SAMPLE_MD, SAMPLE_MD_NO_IMAGE, SAMPLE_PNG, buildSources, fixturePandoc } from './fixtures';
import { LIMITS } from './limits';
import { listZip } from './container';
import { loadPandoc, readDocument } from './pandoc';
import { PANDOC_VERSION } from './version';

const dec = new TextDecoder();
let sources: Record<string, Uint8Array>;
let noImage: Record<string, Uint8Array>;

beforeAll(async () => {
  const p = await fixturePandoc();
  sources = await buildSources(p);
  noImage = await buildSources(p, SAMPLE_MD_NO_IMAGE);
});

async function run(from: FormatId, to: FormatId, data: Uint8Array, name = `report.${from}`) {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(data), name, from, to, options: {} }, ctx);
  return { res, ctx };
}

async function textOutput(res: ConvertResult): Promise<string> {
  return dec.decode(await bytesOf(res.output));
}

const declared = (from: FormatId, to: FormatId) => edges[0]!.stages(from, to);

describe('pandoc edges', () => {
  it('declares the version it bundles', () => {
    expect(PANDOC_VERSION).toMatch(/^\d+\.\d+/);
    expect(declared('docx', 'md')[0]!.label).toBe(`Load pandoc ${PANDOC_VERSION}`);
    expect(declared('docx', 'md').map((s) => s.label)).toEqual([
      `Load pandoc ${PANDOC_VERSION}`,
      'Read DOCX into pandoc AST',
      'Write Markdown',
      'Collect embedded images',
    ]);
    expect(declared('txt', 'docx').map((s) => s.label)).toEqual([
      `Load pandoc ${PANDOC_VERSION}`,
      'Split plain text into pandoc AST',
      'Write DOCX',
    ]);
  });
});

describe('pandoc: every source -> every target', () => {
  const pairs = PANDOC_SOURCES.flatMap((from) => PANDOC_TARGETS.filter((to) => to !== from).map((to) => [from, to] as const));
  expect(pairs.length).toBe(56);

  it.each(pairs)('%s -> %s', async (from, to) => {
    const { res, ctx } = await run(from, to, sources[from]!);

    // Stages: exactly the declared ones, in order; never fake progress.
    expect(ctx.stages).toEqual(declared(from, to).map((s) => s.id));
    expect(ctx.progressValues).toEqual([]);
    // Facts are real and arrive from the decoded AST.
    const facts = ctx.factsSeen[0]!;
    expect(facts.kind).toBe('document');
    if (facts.kind === 'document') {
      expect(facts.blocks).toBeGreaterThan(3);
      expect(facts.words).toBeGreaterThan(10);
    }
    expect(ctx.previews[0]!.kind).toBe('outline');
    expect(ctx.assets.length).toBe(1); // exactly one asset: the pandoc wasm

    const out = await bytesOf(res.output);
    // The sources that really hold the image (a standalone .tex/.txt file cannot).
    const hasImage = !['txt', 'tex'].includes(from) && to !== 'txt';
    switch (to) {
      case 'docx': {
        expect(res.ext).toBe('docx');
        const z = unzipSync(out);
        expect(Object.keys(z)).toContain('word/document.xml');
        const media = Object.keys(z).filter((n) => n.startsWith('word/media/'));
        expect(media.length).toBe(hasImage ? 1 : 0);
        break;
      }
      case 'odt': {
        expect(dec.decode(unzipSync(out)['mimetype']!)).toBe('application/vnd.oasis.opendocument.text');
        break;
      }
      case 'epub': {
        const z = unzipSync(out);
        expect(dec.decode(z['mimetype']!)).toBe('application/epub+zip');
        expect(Object.keys(z).some((n) => n.endsWith('.xhtml'))).toBe(true);
        break;
      }
      case 'rtf':
        expect(dec.decode(out.subarray(0, 6))).toBe('{\\rtf1');
        break;
      case 'html': {
        const html = dec.decode(out);
        expect(html).toMatch(/^<!DOCTYPE html>/i);
        expect(html).toContain('<meta charset="utf-8"');
        expect(html).toContain('Content-Security-Policy');
        expect(html).not.toMatch(/(?:src|href)="https?:\/\/(?!example\.com)/);
        if (hasImage) expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
        else expect(html).not.toContain('data:image');
        break;
      }
      case 'md':
      case 'tex': {
        if (hasImage) {
          // Images stay files: a ZIP with the document and media/.
          expect(res.ext).toBe('zip');
          expect(res.bundle).toEqual({ count: 2, ext: to });
          const z = unzipSync(out);
          const names = Object.keys(z).sort();
          expect(names[0]!.startsWith('media/')).toBe(true);
          expect(names).toContain(`report.${to}`);
          const png = z[names[0]!]!;
          expect(png.length).toBeGreaterThan(50);
          expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
          const doc = dec.decode(z[`report.${to}`]!);
          expect(doc).toContain(names[0]!);
        } else {
          expect(res.ext).toBe(to);
          expect(res.bundle).toBeUndefined();
        }
        break;
      }
      case 'txt': {
        expect(res.ext).toBe('txt');
        const t = dec.decode(out);
        expect(t).toContain('Overview');
        expect(t).toContain('quarterly');
        expect(t).not.toMatch(/\*\*quarterly/);
        break;
      }
    }
  });
});

describe('pandoc: content survives a round trip', () => {
  const sourcesWithStructure: FormatId[] = ['docx', 'odt', 'epub', 'md', 'html', 'tex'];
  it.each(sourcesWithStructure)('%s -> docx -> md keeps headings, table, lists and text', async (from) => {
    const mid = await run(from, 'docx', sources[from]!);
    const back = await run('docx', 'md', await bytesOf(mid.res.output));
    const zip = back.res.ext === 'zip' ? unzipSync(await bytesOf(back.res.output)) : undefined;
    const md = zip ? dec.decode(zip['report.md']!) : await textOutput(back.res);
    expect(md).toMatch(/^#+ Overview/m);
    expect(md).toMatch(/^#+ Numbers/m);
    expect(md).toContain('| North');
    expect(md).toContain('| South');
    expect(md).toContain('120');
    expect(md).toMatch(/^- +first item/m);
    expect(md).toMatch(/^1\. +alpha/m);
    expect(md).toContain('**quarterly**');
    expect(md).toContain('A footnote about regions');
    expect(md).toContain('https://example.com/page');
  });

  it('keeps the image bytes through docx -> epub -> odt -> md/zip', async () => {
    let cur = sources.docx!;
    for (const to of ['epub', 'odt'] as const) {
      const from: FormatId = to === 'epub' ? 'docx' : 'epub';
      cur = await bytesOf((await run(from, to, cur)).res.output);
    }
    const { res } = await run('odt', 'md', cur);
    const z = unzipSync(await bytesOf(res.output));
    const png = Object.entries(z).find(([n]) => n.startsWith('media/'))![1];
    expect(png.length).toBe(SAMPLE_PNG.length);
    expect(Array.from(png)).toEqual(Array.from(SAMPLE_PNG));
  });
});

describe('pandoc: facts and outline come from the real AST', () => {
  it('counts what the document contains', async () => {
    const p = await fixturePandoc();
    const read = await readDocument(p, { bytes: sources.docx!, from: 'docx', label: 'DOCX' });
    const f = read.analysis.facts;
    expect(f.headings).toBe(2);
    expect(f.tables).toBe(1);
    expect(f.images).toBe(1);
    expect(f.words).toBeGreaterThan(25);
    const items = read.analysis.outline.items;
    expect(items[0]).toEqual({ level: 1, text: 'Overview' });
    expect(items.some((i) => i.level === 2 && i.text === 'Numbers')).toBe(true);
    expect(items.some((i) => /^Table: 3 rows × 2 columns$/.test(i.text))).toBe(true);
    expect(items.every((i) => i.text.length <= 80)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(40);
  });

  it('caps the outline at 40 items with text <= 80 chars', async () => {
    const md = Array.from({ length: 80 }, (_, i) => `## Heading ${i} ${'x'.repeat(120)}\n\nparagraph ${i}\n`).join('\n');
    const { ctx } = await run('md', 'html', new TextEncoder().encode(md));
    const prev = ctx.previews[0]!;
    expect(prev.kind).toBe('outline');
    if (prev.kind === 'outline') {
      expect(prev.items.length).toBe(40);
      expect(prev.items.every((i) => i.text.length <= 80)).toBe(true);
    }
  });
});

describe('pandoc: plain text input', () => {
  it('keeps lines, paragraphs and whitespace-significant blocks without interpreting markup', async () => {
    const txt = [
      '*not bold* # not a heading',
      'second line of the first paragraph',
      '',
      '',
      '1. not a list',
      '',
      '    indented code',
      '    stays code',
      '',
      'a   b   c',
    ].join('\n');
    const { res } = await run('txt', 'html', new TextEncoder().encode(txt), 'note.txt');
    const html = await textOutput(res);
    expect(html).toContain('*not bold* # not a heading<br />');
    expect(html).toContain('second line of the first paragraph');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<ol');
    expect(html).toContain('<pre><code>    indented code\n    stays code</code></pre>');
    expect(html).toContain('<pre><code>a   b   c</code></pre>');
    expect(html).toContain('<title>note</title>');
  });

  it('decodes UTF-16 and legacy encodings', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('Привет мир').flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
    const out = await textOutput((await run('txt', 'md', utf16)).res);
    expect(out).toContain('Привет мир');
    const win1252 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café"
    expect(await textOutput((await run('txt', 'md', win1252)).res)).toContain('café');
  });

  it('rejects binary data', async () => {
    const bin = new Uint8Array(200);
    bin.set([0x50, 0x4b, 0, 1, 2]);
    await expect(run('txt', 'md', bin)).rejects.toThrow(/binary data/);
  });
});

describe('pandoc: unicode', () => {
  it('survives md -> docx -> md', async () => {
    const md = '# Привет, 世界\n\nЭто тест: 日本語, Ελληνικά, العربية, emoji 😀 and diacritics é ñ ü.\n';
    const mid = await run('md', 'docx', new TextEncoder().encode(md));
    const back = await run('docx', 'md', await bytesOf(mid.res.output));
    const out = await textOutput(back.res);
    for (const w of ['Привет, 世界', '日本語', 'Ελληνικά', 'العربية', '😀', 'é ñ ü']) expect(out).toContain(w);
  });
});

describe('pandoc: images', () => {
  it('md with a data: URI image -> docx embeds it; unreachable images do not fail the job', async () => {
    const png = Buffer.from(SAMPLE_PNG).toString('base64');
    const md = `![ok](data:image/png;base64,${png})\n\n![remote](https://example.com/x.png)\n\n![missing](nope.png)\n`;
    const { res } = await run('md', 'docx', new TextEncoder().encode(md));
    const z = unzipSync(await bytesOf(res.output));
    expect(Object.keys(z).filter((n) => n.startsWith('word/media/')).length).toBe(1);
  });

  it('no images -> md stays a plain .md file', async () => {
    const { res } = await run('docx', 'md', noImage.docx!);
    expect(res.ext).toBe('md');
    expect(res.bundle).toBeUndefined();
    expect(await textOutput(res)).toContain('# Overview');
  });
});

describe('pandoc: safety', () => {
  it('rejects wrong or damaged containers before downloading pandoc', async () => {
    const ctx = testContext();
    const garbage = new TextEncoder().encode('hello this is not a docx');
    await expect(engine.convert({ input: blobOf(garbage), name: 'x.docx', from: 'docx', to: 'md', options: {} }, ctx)).rejects.toThrow(/not a DOCX/);
    expect(ctx.assets).toEqual([]);
    await expect(run('rtf', 'md', garbage)).rejects.toThrow(/not RTF/);
    await expect(run('epub', 'md', sources.docx!)).rejects.toThrow(/not an EPUB/);
    await expect(run('docx', 'md', sources.odt!)).rejects.toThrow(/not a Word document/);
    await expect(run('docx', 'md', new Uint8Array(0))).rejects.toThrow(/empty/);
  });

  it('rejects inputs over the size limit', async () => {
    const big = new Uint8Array(LIMITS.inputBytes + 1);
    await expect(run('md', 'html', big)).rejects.toThrow(/limit/);
  });

  it('rejects ZIP bombs by their declared sizes without inflating', async () => {
    const { zipSync } = await import('fflate');
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(LIMITS.zipEntryBytes + 1024) }, { level: 1 });
    expect(bomb.length).toBeLessThan(1_000_000);
    expect(() => listZip(bomb)).toThrow(/expands beyond/);
    await expect(run('docx', 'md', bomb)).rejects.toThrow(/expands beyond/);
  });

  it('reports a damaged docx with a readable message', async () => {
    const broken = sources.docx!.slice(0, 400);
    await expect(run('docx', 'md', broken)).rejects.toThrow(/valid ZIP|Could not read/);
  });

  it('hostile HTML is neutralised: no script, frame, handler, style or javascript: link survives', async () => {
    const html =
      '<p>hi</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror=alert(1)>' +
      '<a href="javascript:alert(2)">l</a><span style="x" onclick="y()">s</span><object data="x"></object>';
    for (const to of ['md', 'tex', 'txt'] as const) {
      const out = await textOutput((await run('html', to, new TextEncoder().encode(html))).res);
      expect(out).not.toMatch(/<script|<iframe|<object|onerror|onclick|javascript:|alert\(/i);
      expect(out).toContain('hi');
    }
  });

  it('raw HTML in markdown that could run code is dropped, harmless raw HTML stays', async () => {
    const md = 'a <kbd>Ctrl</kbd> b\n\n<script>alert(1)</script>\n\n<div onclick="x()">c</div>\n\n[x](javascript:alert(1))\n';
    const html = await textOutput((await run('md', 'html', new TextEncoder().encode(md))).res);
    const body = html.slice(html.indexOf('<body>'));
    expect(body).toContain('<kbd>Ctrl</kbd>');
    expect(body).not.toMatch(/<script|onclick|javascript:/i);
  });

  it('raw HTML in markdown is neutralised by a CSP in the HTML output', async () => {
    const md = 'x\n\n<script>alert(1)</script>\n';
    const out = await textOutput((await run('md', 'html', new TextEncoder().encode(md))).res);
    expect(out).toMatch(/default-src (?:'|&#39;)none/);
  });

  it('survives deeply nested structure without blowing the stack', async () => {
    const md = '> '.repeat(400) + 'deep\n';
    const { ctx, res } = await run('md', 'txt', new TextEncoder().encode(md));
    expect(await textOutput(res)).toContain('deep');
    expect(ctx.factsSeen[0]!.kind).toBe('document');
  });
});

describe('pandoc: hostile Markdown is refused before the slow reader runs', () => {
  it.each([
    ['unmatched emphasis in one word', 'a_'.repeat(6000)],
    ['absurdly nested quotes', '> '.repeat(2000) + 'x'],
  ])('%s', async (_name, md) => {
    const ctx = testContext();
    const t = performance.now();
    await expect(engine.convert({ input: blobOf(new TextEncoder().encode(md)), name: 'x.md', from: 'md', to: 'docx', options: {} }, ctx)).rejects.toThrow(/far too long/);
    expect(ctx.assets, 'refused before the 58 MB download').toEqual([]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('pandoc: one instance, repeated use', () => {
  it('loads once per job and finishes every conversion', async () => {
    const p = await loadPandoc(testContext());
    for (let i = 0; i < 3; i++) {
      const r = await readDocument(p, { bytes: sources.md!, from: 'md', label: 'Markdown' });
      expect(r.analysis.facts.headings).toBe(2);
    }
  });
});

describe('sanity of fixtures', () => {
  it('sample sources contain the image', () => {
    expect(SAMPLE_MD).toContain('logo.png');
    expect(Object.keys(unzipSync(sources.docx!)).some((n) => n.startsWith('word/media/'))).toBe(true);
  });
});
