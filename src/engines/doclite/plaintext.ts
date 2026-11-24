/** Markdown tokens -> plain text, for the subset where that is faithful. Anything else falls back to pandoc. */
import type { Token, Tokens } from 'marked';
import { EngineUnsupportedError } from '../../core/types';

function inline(tokens: Token[] | undefined): string {
  let out = '';
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'text':
      case 'escape':
        out += (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : (t as Tokens.Text).text;
        break;
      case 'codespan':
        out += (t as Tokens.Codespan).text;
        break;
      case 'em':
      case 'strong':
      case 'del':
        out += inline((t as Tokens.Em).tokens);
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const label = inline(l.tokens);
        out += label === l.href || l.autolink ? label : l.href && l.href !== '#' ? `${label} (${l.href})` : label;
        break;
      }
      case 'image':
        out += `[${(t as Tokens.Image).text}]`;
        break;
      case 'br':
        out += '\n';
        break;
      default:
        throw new EngineUnsupportedError(`inline ${t.type}`);
    }
  }
  return out;
}

const indent = (s: string, pad: string) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');

function blocks(tokens: Token[]): string {
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
      case 'checkbox': // the list item adds its own [x] / [ ] marker
        break;
      case 'heading':
        out.push(inline((t as Tokens.Heading).tokens));
        break;
      case 'paragraph':
      case 'text':
        out.push(inline((t as Tokens.Paragraph).tokens));
        break;
      case 'code':
        out.push(indent((t as Tokens.Code).text, '    '));
        break;
      case 'hr':
        out.push('-'.repeat(72));
        break;
      case 'blockquote':
        out.push(indent(blocks((t as Tokens.Blockquote).tokens), '> '));
        break;
      case 'list': {
        const l = t as Tokens.List;
        let n = typeof l.start === 'number' ? l.start : 1;
        const items = l.items.map((item) => {
          const marker = l.ordered ? `${n++}. ` : '- ';
          const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
          const body = blocks(item.tokens).replace(/\n\n/g, '\n');
          return marker + task + indent(body, ' '.repeat(marker.length)).slice(marker.length);
        });
        out.push(items.join('\n'));
        break;
      }
      default: // table, html, anything else: not faithful here
        throw new EngineUnsupportedError(`block ${t.type}`);
    }
  }
  return out.join('\n\n');
}

export function markdownToText(tokens: Token[]): string {
  const text = blocks(tokens);
  return text ? text + '\n' : '';
}
