/** Plain text -> Markdown, and the Markdown token helpers. Pure string code: no DOM. */
import type { Token, Tokens } from 'marked';
import { isPreformatted, paragraphsOf, truncate } from '../pandoc/text';

/** Escape one line of plain text so Markdown shows it literally. */
export function escapeMarkdownLine(line: string): string {
  const text = line.replace(/\t/g, '    ').replace(/\s+$/, '');
  const lead = /^ */.exec(text)![0].length;
  let body = text.slice(lead);
  body = body
    .replace(/[\\`*_[\]<|~$]/g, '\\$&')
    .replace(/&(?=#?\w+;)/g, '\\&')
    // Block markers at the start of a line.
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([+-])(?=\s|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(-{2,}|={1,})\s*$/, (m) => `\\${m}`);
  // Indentation of 4+ would become an indented code block: keep the characters, break the syntax.
  const indent = lead >= 4 ? `&#32;${' '.repeat(lead - 1)}` : ' '.repeat(lead);
  return indent + body;
}

/** A backslash right after a bare URL becomes part of the URL, so those lines break with two spaces instead. */
const ENDS_IN_LINKABLE = /(?:\b(?:https?|ftp):\/\/|\bwww\.|\bmailto:)\S*$|\S+@\S+\.\S+$/i;

function joinHardBreaks(lines: string[]): string {
  return lines.map((l, i) => (i === lines.length - 1 ? l : l + (ENDS_IN_LINKABLE.test(l) ? '  \n' : '\\\n'))).join('');
}

export function textToMarkdown(text: string): string {
  const out: string[] = [];
  for (const lines of paragraphsOf(text)) {
    if (isPreformatted(lines)) {
      const body = lines.map((l) => l.replace(/\s+$/, '').replace(/\t/g, '    ')).join('\n');
      const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      out.push(`${fence}\n${body}\n${fence}`);
    } else {
      out.push(joinHardBreaks(lines.map(escapeMarkdownLine)));
    }
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

/* ---------------------------------------------------------------- tokens */

export type Outline = { level: number; text: string }[];

/** Plain text of inline tokens. */
export function inlineText(tokens: Token[] | undefined): string {
  let out = '';
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text':
      case 'codespan':
      case 'escape':
        out += (t as Tokens.Text).tokens ? inlineText((t as Tokens.Text).tokens) : (t as Tokens.Text).text;
        break;
      case 'image':
        out += (t as Tokens.Image).text;
        break;
      case 'br':
        out += ' ';
        break;
      case 'html':
        break;
      default:
        if ('tokens' in t && Array.isArray(t.tokens)) out += inlineText(t.tokens);
        else if ('text' in t && typeof t.text === 'string') out += t.text;
    }
  }
  return out;
}

export interface MarkdownStats {
  blocks: number;
  headings: number;
  images: number;
  tables: number;
  words: number;
  outline: Outline;
}

/** Count what the Markdown really contains and sample its first ~40 blocks. Iterative: hostile nesting is safe. */
export function markdownStats(tokens: Token[], maxOutline = 40): MarkdownStats {
  const s: MarkdownStats = { blocks: 0, headings: 0, images: 0, tables: 0, words: 0, outline: [] };
  const words = (t: string) => (t.match(/\S+/g) ?? []).length;
  const stack: Token[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) stack.push(tokens[i]!);
  const outline = (level: number, text: string) => {
    if (s.outline.length < maxOutline && text.trim()) s.outline.push({ level, text: truncate(text, 80) });
  };
  const countImages = (toks: Token[] | undefined) => {
    const st = [...(toks ?? [])];
    while (st.length) {
      const t = st.pop()!;
      if (t.type === 'image') s.images++;
      if ('tokens' in t && Array.isArray(t.tokens)) st.push(...t.tokens);
    }
  };
  while (stack.length) {
    const t = stack.pop()!;
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        s.blocks++;
        s.headings++;
        s.words += words(inlineText(h.tokens));
        countImages(h.tokens);
        outline(h.depth, inlineText(h.tokens));
        break;
      }
      case 'paragraph':
      case 'text': {
        const p = t as Tokens.Paragraph;
        s.blocks++;
        const text = inlineText(p.tokens ?? [{ type: 'text', raw: p.text, text: p.text } as Tokens.Text]);
        s.words += words(text);
        countImages(p.tokens);
        outline(0, text);
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        s.blocks++;
        s.words += words(c.text);
        outline(0, c.text.split('\n', 1)[0] || '(code block)');
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        s.blocks++;
        s.tables++;
        for (const cell of [...tb.header, ...tb.rows.flat()]) {
          s.words += words(inlineText(cell.tokens));
          countImages(cell.tokens);
        }
        outline(0, `Table: ${tb.rows.length + 1} rows × ${tb.header.length} columns`);
        break;
      }
      case 'hr':
        s.blocks++;
        break;
      case 'html':
        if ((t as Tokens.HTML).block) s.blocks++;
        break;
      case 'blockquote':
        s.blocks++;
        for (let i = (t as Tokens.Blockquote).tokens.length - 1; i >= 0; i--) stack.push((t as Tokens.Blockquote).tokens[i]!);
        break;
      case 'list': {
        s.blocks++;
        const items = (t as Tokens.List).items;
        for (let i = items.length - 1; i >= 0; i--) {
          const toks = items[i]!.tokens;
          for (let j = toks.length - 1; j >= 0; j--) stack.push(toks[j]!);
        }
        break;
      }
      default:
    }
  }
  return s;
}
