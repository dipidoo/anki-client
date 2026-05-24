// Card rendering: convert YAML card text into safe HTML with KaTeX-rendered
// math and styled cloze deletions.
//
// Pipeline:
//   1. Extract math segments (\(...\), \[...\]) and cloze segments ({{c1::...}})
//      into placeholder tokens.
//   2. HTML-escape the surrounding text (cards live in our own private repo so
//      this is defense-in-depth, not strictly required).
//   3. Render math via KaTeX and inject styled spans for clozes.
//   4. Preserve newlines via CSS white-space: pre-wrap (caller's job).

import katex from 'katex';
import type { Card } from './cards';

interface Token {
  kind: 'text' | 'math' | 'cloze';
  raw: string;
  // for math:
  displayMode?: boolean;
  // for cloze:
  clozeContent?: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Combined regex: cloze | display math | inline math
  const re = /\{\{c\d+::([^:}]+?)(?:::[^}]+)?\}\}|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', raw: text.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined) {
      tokens.push({ kind: 'cloze', raw: m[0], clozeContent: m[1] });
    } else if (m[2] !== undefined) {
      tokens.push({ kind: 'math', raw: m[2], displayMode: true });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: 'math', raw: m[3], displayMode: false });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', raw: text.slice(lastIndex) });
  }
  return tokens;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMath(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      output: 'html',
    });
  } catch (e) {
    return `<code>${escapeHtml(expr)}</code>`;
  }
}

/**
 * Render the question side: clozes shown as styled placeholders.
 */
export function renderQuestion(card: Card): string {
  if (card.notetype === 'basic') return renderRich(card.front, false);
  return renderRich(card.front, false, 'placeholder');
}

/**
 * Render the answer side: clozes revealed as styled emphasis.
 * For basic cards, returns the `back` field.
 */
export function renderAnswer(card: Card): string {
  if (card.notetype === 'basic') return renderRich(card.back ?? '', false);
  return renderRich(card.front, false, 'reveal');
}

export function renderExtra(text: string): string {
  return renderRich(text, false);
}

type ClozeMode = 'placeholder' | 'reveal';

function renderRich(text: string, _unused: boolean, clozeMode?: ClozeMode): string {
  const parts: string[] = [];
  for (const tok of tokenize(text)) {
    if (tok.kind === 'text') {
      parts.push(escapeHtml(tok.raw));
    } else if (tok.kind === 'math') {
      parts.push(renderMath(tok.raw, tok.displayMode ?? false));
    } else if (tok.kind === 'cloze') {
      if (clozeMode === 'placeholder' || !clozeMode) {
        parts.push('<span class="cloze-placeholder">[&hellip;]</span>');
      } else {
        // reveal: render the cloze content (which may itself contain math) recursively.
        const inner = renderRich(tok.clozeContent ?? '', false);
        parts.push(`<span class="cloze-reveal">${inner}</span>`);
      }
    }
  }
  return parts.join('');
}
