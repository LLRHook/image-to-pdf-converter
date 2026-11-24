import { Marked, type Token, type Tokens } from 'marked';
import { formatInfo } from '../../core/formats';
import { EngineUnsupportedError, type ConvertRequest, type ConvertResult, type Engine, type EngineContext } from '../../core/types';
import { assertDocumentSize, assertMarkdownTractable, formatBytes } from '../pandoc/limits';
import { HTML_CSP, baseNameOf, decodeText, escapeHtml, isPreformatted, paragraphsOf, splitLines, truncate } from '../pandoc/text';
import { inlineText, markdownStats, textToMarkdown } from './markdown';
import { markdownToText } from './plaintext';

/** doclite handles plain text well past this, but markdown parsing is superlinear on hostile input. */
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;

/** Tags and handlers that can run code or load active content when the HTML is rendered. */
const ACTIVE_HTML = /<\s*(?:script|iframe|frame|object|embed|applet|link|meta|base|form|style|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:/i;
const BAD_URL = /^\s*(?:javascript|vbscript|data:(?!image\/))/i;

/** Applied to every token before rendering (the lexer + parser split skips marked's own walkTokens option). */
function neutralise(token: Token): void {
  if (token.type === 'html') {
    const t = token as Tokens.HTML;
    if (ACTIVE_HTML.test(t.text)) t.text = '';
  } else if (token.type === 'link' || token.type === 'image') {
    const t = token as Tokens.Link;
    if (BAD_URL.test(t.href)) t.href = '#';
  }
}

const STYLE = `
html{color:#1a1a1a;background:#fdfdfd}
body{margin:0 auto;max-width:42em;padding:2.5em 1.5em;font:1rem/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .5em}
pre{background:#f3f3f3;padding:.8em 1em;overflow:auto;border-radius:4px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
:not(pre)>code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}
blockquote{margin:1em 0;padding:0 1em;border-left:3px solid #ddd;color:#555}
table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.3em .7em}
img{max-width:100%}
p.t{white-space:pre-wrap}
@media (prefers-color-scheme:dark){html{color:#e6e6e6;background:#181818}pre,:not(pre)>code{background:#262626}blockquote{color:#aaa;border-color:#444}th,td{border-color:#444}a{color:#8ab4f8}}
`.trim();

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${HTML_CSP}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function guard(req: ConvertRequest): void {
  assertDocumentSize(req.input.size);
  if (req.from === 'md' && req.input.size > MAX_MARKDOWN_BYTES) {
    throw new EngineUnsupportedError(`Markdown over ${formatBytes(MAX_MARKDOWN_BYTES)} goes to the full converter.`);
  }
}

/** Constructs the quick path cannot render faithfully: let pandoc do them. */
function assertSimpleMarkdown(src: string): void {
  if (/^---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/.test(src)) throw new EngineUnsupportedError('YAML front matter');
  if (/^ {0,3}\[\^[^\]\s]+\]:/m.test(src)) throw new EngineUnsupportedError('footnotes');
}

function done(text: string, to: 'html' | 'md' | 'txt'): ConvertResult {
  const info = formatInfo(to);
  return { output: new TextEncoder().encode(text), ext: info.exts[0]!, mime: info.mime };
}

async function convert(req: ConvertRequest, ctx: EngineContext): Promise<ConvertResult> {
  guard(req);
  const { text } = decodeText(new Uint8Array(await req.input.arrayBuffer()));
  const title = baseNameOf(req.name);

  if (req.from === 'md') {
    ctx.stage('decode');
    assertMarkdownTractable(text);
    assertSimpleMarkdown(text);
    const md = new Marked({ gfm: true, breaks: false, async: false });
    let tokens: ReturnType<Marked['lexer']>;
    try {
      tokens = md.lexer(text);
      md.walkTokens(tokens, neutralise);
    } catch (e) {
      // marked recurses per nesting level: absurdly deep quotes/lists overflow its stack.
      if (e instanceof RangeError) throw new EngineUnsupportedError('Markdown nested too deeply for the quick path');
      throw e;
    }
    const stats = markdownStats(tokens);
    ctx.facts({ kind: 'document', blocks: stats.blocks, headings: stats.headings, images: stats.images, words: stats.words, tables: stats.tables });
    ctx.preview({ kind: 'outline', items: stats.outline });

    if (req.to === 'html') {
      ctx.stage('encode');
      let body: string;
      try {
        body = md.parser(tokens);
      } catch (e) {
        if (e instanceof RangeError) throw new EngineUnsupportedError('Markdown nested too deeply for the quick path');
        throw e;
      }
      const h1 = tokens.find((t): t is Tokens.Heading => t.type === 'heading' && (t as Tokens.Heading).depth === 1);
      return done(htmlPage((h1 && inlineText(h1.tokens).trim()) || title, body), 'html');
    }
    if (req.to === 'txt') {
      ctx.stage('encode');
      return done(markdownToText(tokens), 'txt');
    }
  }

  if (req.from === 'txt') {
    ctx.stage('decode');
    const blocks = paragraphsOf(text);
    ctx.facts({ kind: 'text', chars: text.length, lines: splitLines(text).length });
    ctx.preview({ kind: 'outline', items: blocks.slice(0, 40).map((b) => ({ level: 0, text: truncate(b.join(' '), 80) })) });

    if (req.to === 'html') {
      ctx.stage('encode');
      const body = blocks
        .map((lines) =>
          isPreformatted(lines)
            ? `<pre>${escapeHtml(lines.map((l) => l.replace(/\s+$/, '').replace(/\t/g, '    ')).join('\n'))}</pre>`
            : `<p class="t">${lines.map(escapeHtml).join('<br>')}</p>`,
        )
        .join('\n');
      return done(htmlPage(title, body), 'html');
    }
    if (req.to === 'md') {
      ctx.stage('encode');
      return done(textToMarkdown(text), 'md');
    }
  }
  throw new Error(`doclite cannot convert ${req.from} to ${req.to}`);
}

export default { convert } satisfies Engine;
