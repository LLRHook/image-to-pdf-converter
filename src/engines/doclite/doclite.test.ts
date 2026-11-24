import { describe, expect, it } from 'vitest';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import { EngineUnsupportedError } from '../../core/types';
import { edges } from './edges';
import engine from './engine';
import pandocEngine from '../pandoc/engine';
import { LIMITS, MARKDOWN_WORK_BUDGET, markdownWork } from '../pandoc/limits';
import { escapeMarkdownLine } from './markdown';

const dec = new TextDecoder();
const enc = new TextEncoder();

async function run(from: FormatId, to: FormatId, text: string | Uint8Array, name = `note.${from}`) {
  const ctx = testContext();
  const data = typeof text === 'string' ? enc.encode(text) : text;
  const res = await engine.convert({ input: blobOf(data), name, from, to, options: {} }, ctx);
  return { ctx, res, out: dec.decode(await bytesOf(res.output)) };
}

const declared = (from: FormatId, to: FormatId) =>
  edges.find((e) => e.from.includes(from) && e.to.includes(to))!.stages(from, to);

/** Text of an HTML body as a browser would render it, one paragraph per element. */
function htmlText(html: string): string[] {
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  return body
    .split(/<\/(?:p|pre|h\d|li|blockquote|tr)>/)
    .map((chunk) =>
      chunk
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim(),
    )
    .filter(Boolean);
}

describe('doclite edges', () => {
  it('declares the exact stages the engine reports', async () => {
    const cases: [FormatId, FormatId, string][] = [
      ['md', 'html', '# T\n\nhello'],
      ['txt', 'html', 'hello'],
      ['txt', 'md', 'hello'],
      ['md', 'txt', '# T\n\nhello'],
    ];
    for (const [from, to, src] of cases) {
      const { ctx } = await run(from, to, src);
      expect(ctx.stages).toEqual(declared(from, to).map((s) => s.id));
      expect(ctx.progressValues).toEqual([]);
      expect(ctx.assets).toEqual([]); // nothing to download
    }
    expect(declared('md', 'html').map((s) => s.label)).toEqual(['Parse Markdown', 'Render HTML']);
  });
});

describe('md -> html', () => {
  const md = [
    '# Quarterly *report*',
    '',
    'Some **bold**, _em_, ~~gone~~ and `code` with a [link](https://example.com/a?b=1&c=2).',
    '',
    '- [x] done',
    '- [ ] todo',
    '',
    '1. one',
    '2. two',
    '',
    '| Region | Revenue |',
    '|--------|--------:|',
    '| North  | 120     |',
    '',
    '```js',
    'const x = "<b>";',
    '```',
    '',
    '> quoted',
    '',
    '![logo](data:image/png;base64,iVBORw0KGgo=)',
    '',
    'Привет, 世界 😀 é',
  ].join('\n');

  it('renders a full UTF-8 HTML document with real content', async () => {
    const { res, out, ctx } = await run('md', 'html', md, 'report.md');
    expect(res.ext).toBe('html');
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<title>Quarterly report</title>');
    expect(out).toContain('<h1>Quarterly <em>report</em></h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<del>gone</del>');
    expect(out).toMatch(/<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">link<\/a>/);
    expect(out).toContain('<input checked="" disabled="" type="checkbox"> done');
    expect(out).toContain('<ol>');
    expect(out).toContain('<table>');
    expect(out).toMatch(/<th align="right">Revenue<\/th>/);
    expect(out).toContain('class="language-js"');
    expect(out).toContain('const x = &quot;&lt;b&gt;&quot;;');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('Привет, 世界 😀 é');
    expect(out).toMatch(/<img src="data:image\/png/);
    expect(res.mime).toBe('text/html');

    const f = ctx.factsSeen[0]!;
    expect(f).toMatchObject({ kind: 'document', headings: 1, images: 1, tables: 1 });
    if (f.kind === 'document') {
      expect(f.blocks).toBeGreaterThan(8);
      expect(f.words).toBeGreaterThan(25);
    }
    const prev = ctx.previews[0]!;
    expect(prev.kind).toBe('outline');
    if (prev.kind === 'outline') {
      expect(prev.items[0]).toEqual({ level: 1, text: 'Quarterly report' });
      expect(prev.items.some((i) => i.text === 'Table: 2 rows × 2 columns')).toBe(true);
    }
  });

  it('uses the file name when there is no heading', async () => {
    const { out } = await run('md', 'html', 'just text', 'my notes.md');
    expect(out).toContain('<title>my notes</title>');
  });

  it('neutralises hostile content: CSP + script/frame/handler/javascript: removal', async () => {
    const { out } = await run(
      'md',
      'html',
      'x\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n<div onclick="y()">d</div>\n\n[a](javascript:alert(2)) ![b](javascript:alert(3)) <b>ok</b> <img src=x onerror=alert(4)>\n',
    );
    expect(out).toContain("default-src 'none'");
    const body = out.slice(out.indexOf('<body>'));
    expect(body).not.toMatch(/<script|<iframe|onclick|onerror|javascript:/i);
    expect(body).toContain('<b>ok</b>');
  });

  it('falls back to pandoc for what it cannot do faithfully', async () => {
    await expect(run('md', 'html', '---\ntitle: T\n---\n\nbody')).rejects.toBeInstanceOf(EngineUnsupportedError);
    await expect(run('md', 'html', 'text[^1]\n\n[^1]: note')).rejects.toBeInstanceOf(EngineUnsupportedError);
  });

  it('is not slow on adversarial input, and refuses absurd emphasis and nesting up front', async () => {
    // CPU time, not wall time: other processes on a busy machine must not fail this.
    const cpuMs = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const t = cpuMs();
    // Linear-time shapes run on the quick path.
    await run('md', 'html', '['.repeat(20000) + '\n\n' + '*'.repeat(20000) + '\n\n' + 'a_'.repeat(500));
    await run('md', 'html', '[a](b'.repeat(20000));
    await run('md', 'html', '- a\n'.repeat(20000));
    await run('md', 'html', 'a _b '.repeat(20000));
    expect(cpuMs() - t).toBeLessThan(4000);
    // marked and pandoc are quadratic in unmatched emphasis markers inside one word: refuse before parsing.
    const t2 = cpuMs();
    for (const hostile of ['a_'.repeat(40000), '_a_b'.repeat(20000), '*a*b'.repeat(20000), '**a'.repeat(30000), ('a_'.repeat(3000) + ' ').repeat(50)]) {
      await expect(run('md', 'html', hostile)).rejects.toThrow(/far too long/);
    }
    expect(cpuMs() - t2).toBeLessThan(1500);
    await expect(run('md', 'html', '> '.repeat(5000) + 'x')).rejects.toThrow(/block quotes more than 400 levels/);
    await expect(run('md', 'html', '>'.repeat(401) + 'x')).rejects.toThrow(/block quotes more than 400 levels/);
    // Deep but sane nesting still converts, on the quick path or via pandoc.
    const t3 = cpuMs();
    try {
      const { out } = await run('md', 'html', '> '.repeat(300) + 'x');
      expect(out).toContain('x');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineUnsupportedError);
    }
    expect(cpuMs() - t3).toBeLessThan(1500);
  });

  it('keeps the work estimate small for real documents', () => {
    const para = 'Some *emphasis*, __strong__ and snake_case_names in a normal paragraph.\n';
    expect(markdownWork(para.repeat(200_000))).toBeLessThan(MARKDOWN_WORK_BUDGET);
    expect(markdownWork('*'.repeat(20000) + '\n' + '-'.repeat(500))).toBeLessThan(MARKDOWN_WORK_BUDGET);
    expect(markdownWork('_a_b '.repeat(20000))).toBeLessThan(MARKDOWN_WORK_BUDGET);
    expect(markdownWork('a_'.repeat(2500))).toBeGreaterThan(MARKDOWN_WORK_BUDGET);
  });

  it('rejects inputs over the size limit', async () => {
    await expect(run('md', 'html', new Uint8Array(LIMITS.inputBytes + 1))).rejects.toThrow(/limit/);
  });
});

describe('md -> txt', () => {
  it('writes the text of simple Markdown faithfully', async () => {
    const md = [
      '# Title',
      '',
      'A **bold** and _soft_ line with `code`, a [link](https://example.com) and ![alt text](x.png).',
      '',
      '- one',
      '- two',
      '  - nested',
      '',
      '3. three',
      '4. four',
      '',
      '- [x] done',
      '',
      '> quote here',
      '',
      '    indented code',
      '',
      '---',
    ].join('\n');
    const { out, res } = await run('md', 'txt', md);
    expect(res.ext).toBe('txt');
    expect(out).toContain('Title\n\nA bold and soft line with code, a link (https://example.com) and [alt text].');
    expect(out).toContain('- one\n- two\n  - nested');
    expect(out).toContain('3. three\n4. four');
    expect(out).toContain('- [x] done');
    expect(out).toContain('> quote here');
    expect(out).toContain('    indented code');
    expect(out).not.toMatch(/\*\*|`|_soft_/);
  });

  it('has the same words as pandoc on a document both can do', async () => {
    const md = '# Head\n\nSome **bold** and _it_ text.\n\n- a\n- b\n\n1. x\n2. y\n\n> q\n';
    const lite = (await run('md', 'txt', md)).out;
    const pc = await pandocEngine.convert({ input: blobOf(md), name: 'a.md', from: 'md', to: 'txt', options: {} }, testContext());
    const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase());
    expect(words(lite)).toEqual(words(dec.decode(await bytesOf(pc.output))));
  });

  it.each([
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['raw html', 'text <b>x</b>'],
    ['html block', '<div>x</div>'],
    ['front matter', '---\ntitle: x\n---\n\ntext'],
    ['footnote', 'a[^1]\n\n[^1]: n'],
  ])('falls back to pandoc for %s', async (_n, md) => {
    await expect(run('md', 'txt', md)).rejects.toBeInstanceOf(EngineUnsupportedError);
  });
});

const NASTY = [
  '# not a heading',
  '* not a list',
  '- dash item',
  '+ plus item',
  '1. numbered?',
  '2) paren numbered?',
  '> not a quote',
  '`tick` and ``double``',
  '**bold** and __strong__ and *em* and _em_',
  'snake_case_name and 2 * 3 = 6',
  '[link](http://example.com) ![img](y.png) [ref]: http://x',
  '<div>html</div> <script>alert(1)</script> &amp; &copy; &#35;',
  '|a|b| and a | b',
  '~~strike~~ and ~tilde~',
  'back\\slash and trailing\\',
  '$x$ and $5 and $6',
  '<http://auto.link> and https://bare.example/path',
].join('\n');

describe('txt -> md (round trip through real Markdown parsers)', () => {
  it('escapes every special so the text survives rendering by marked', async () => {
    const md = (await run('txt', 'md', NASTY)).out;
    const html = (await run('md', 'html', md)).out;
    const body = html.slice(html.indexOf('<body>'));
    expect(body).not.toMatch(/<(?:h\d|ul|ol|li|blockquote|strong|em|del|img|script|div|code|table)/);
    // One paragraph with the original lines, in order.
    expect(htmlText(html)).toEqual([NASTY]);
  });

  it('survives pandoc (a second, independent Markdown parser)', async () => {
    const md = (await run('txt', 'md', NASTY)).out;
    const pc = await pandocEngine.convert({ input: blobOf(md), name: 'a.md', from: 'md', to: 'txt', options: {} }, testContext());
    const text = dec.decode(await bytesOf(pc.output)).trim();
    const squash = (s: string) => s.replace(/\s+/g, '').replace(/\\/g, '');
    expect(squash(text)).toBe(squash(NASTY));
  });

  it('keeps paragraphs, line structure and whitespace-significant blocks', async () => {
    const txt = 'first line\nsecond line\n\n\n\nnext paragraph\n\n    code a\n    code b\n\ncol1   col2   col3';
    const { out } = await run('txt', 'md', txt);
    expect(out).toBe('first line\\\nsecond line\n\nnext paragraph\n\n```\n    code a\n    code b\n```\n\n```\ncol1   col2   col3\n```\n');
  });

  it('escapes a lone indented line and setext underlines', () => {
    expect(escapeMarkdownLine('      deep')).toBe('&#32;     deep');
    expect(escapeMarkdownLine('=====')).toBe('\\=====');
    expect(escapeMarkdownLine('-----')).toBe('\\-----');
    expect(escapeMarkdownLine('7. seven')).toBe('7\\. seven');
    expect(escapeMarkdownLine('# h')).toBe('\\# h');
  });

  it('handles empty and unicode input', async () => {
    expect((await run('txt', 'md', '')).out).toBe('');
    expect((await run('txt', 'md', 'Привет 日本語 😀')).out).toBe('Привет 日本語 😀\n');
  });
});

describe('txt -> html', () => {
  it('escapes everything and keeps line structure', async () => {
    const txt = 'a <b> & "q" \'s\'\nsecond line\n\n<script>alert(1)</script>\n\n    ascii\n    art';
    const { out, res } = await run('txt', 'html', txt, 'raw.txt');
    expect(res.ext).toBe('html');
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<title>raw</title>');
    expect(out).toContain('<p class="t">a &lt;b&gt; &amp; &quot;q&quot; &#39;s&#39;<br>second line</p>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('<pre>    ascii\n    art</pre>');
    expect(htmlText(out)).toEqual(['a <b> & "q" \'s\'\nsecond line', '<script>alert(1)</script>', 'ascii\n    art'].map((s, i) => (i === 2 ? '    ascii\n    art'.trim() : s)));
  });

  it('reports real facts', async () => {
    const { ctx } = await run('txt', 'html', 'one two\nthree\n\nfour');
    expect(ctx.factsSeen[0]).toEqual({ kind: 'text', chars: 19, lines: 4 });
    expect(ctx.previews[0]).toEqual({ kind: 'outline', items: [{ level: 0, text: 'one two three' }, { level: 0, text: 'four' }] });
  });

  it('decodes UTF-16 with BOM and rejects binary', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('héllo').flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
    expect((await run('txt', 'html', utf16)).out).toContain('héllo');
    await expect(run('txt', 'html', new Uint8Array([1, 0, 2, 0, 3, 0, 4]))).rejects.toThrow(/binary/);
  });
});
