// Card rendering: convert YAML card text into safe HTML with KaTeX math,
// styled cloze deletions (including clozes that live INSIDE math expressions),
// and inline images sourced from the pre-populated image cache.
//
// Two-pass tokenization:
//   1. Extract every {{c1::...}} cloze marker out of the text and replace with
//      a sentinel like "\u0001<idx>\u0002". This lets us treat clozes uniformly
//      whether they were authored inside or outside math.
//   2. Tokenize images + math on the substituted text. Math expressions that
//      contain a sentinel get SPLIT at the sentinel — math chunk → cloze token
//      → math chunk — so KaTeX never sees the sentinel.
// Cloze tokens carry a flag indicating whether they were extracted from inside
// math, so the renderer can render the cloze content as math (KaTeX) on reveal
// rather than as plain text.

import katex from 'katex';
import type { Card } from './cards';
import { getImageContent } from './images';

const C_START = '\u0001';
const C_END = '\u0002';

interface ExtractedCloze {
  content: string;
}

interface Token {
  kind: 'text' | 'math' | 'cloze' | 'image';
  raw: string;
  displayMode?: boolean;        // math
  clozeContent?: string;        // cloze
  clozeFromMath?: boolean;      // cloze
  clozeDisplayMode?: boolean;   // cloze (when fromMath)
  imageAlt?: string;            // image
  imagePath?: string;           // image
}

function extractClozes(text: string): { text: string; clozes: ExtractedCloze[] } {
  const clozes: ExtractedCloze[] = [];
  // Cloze content is everything up to "}}", minus an optional ::hint suffix.
  // We intentionally allow `{` inside the content (for things like \frac{1}{n}).
  const out = text.replace(/\{\{c\d+::([\s\S]+?)(?:::[^}]*)?\}\}/g, (_, content) => {
    const idx = clozes.length;
    clozes.push({ content: String(content) });
    return `${C_START}${idx}${C_END}`;
  });
  return { text: out, clozes };
}

function tokenize(text: string): Token[] {
  const { text: sub, clozes } = extractClozes(text);
  const tokens: Token[] = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    if (m.index > lastIndex) {
      pushTextWithClozes(tokens, sub.slice(lastIndex, m.index), clozes);
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      tokens.push({ kind: 'image', raw: m[0], imageAlt: m[1], imagePath: m[2] });
    } else if (m[3] !== undefined) {
      pushMathWithClozes(tokens, m[3], true, clozes);
    } else if (m[4] !== undefined) {
      pushMathWithClozes(tokens, m[4], false, clozes);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < sub.length) {
    pushTextWithClozes(tokens, sub.slice(lastIndex), clozes);
  }
  return tokens;
}

function pushTextWithClozes(out: Token[], text: string, clozes: ExtractedCloze[]): void {
  if (!text.includes(C_START)) {
    if (text) out.push({ kind: 'text', raw: text });
    return;
  }
  // Split text on sentinels, alternating text fragments and cloze tokens.
  const parts = text.split(/\u0001(\d+)\u0002/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out.push({ kind: 'text', raw: parts[i] });
    } else {
      const idx = Number(parts[i]);
      out.push({ kind: 'cloze', raw: '', clozeContent: clozes[idx].content, clozeFromMath: false });
    }
  }
}

function pushMathWithClozes(
  out: Token[],
  mathExpr: string,
  displayMode: boolean,
  clozes: ExtractedCloze[],
): void {
  if (!mathExpr.includes(C_START)) {
    out.push({ kind: 'math', raw: mathExpr, displayMode });
    return;
  }
  const parts = mathExpr.split(/\u0001(\d+)\u0002/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const seg = parts[i];
      if (seg && seg.trim()) out.push({ kind: 'math', raw: seg, displayMode });
    } else {
      const idx = Number(parts[i]);
      out.push({
        kind: 'cloze',
        raw: '',
        clozeContent: clozes[idx].content,
        clozeFromMath: true,
        clozeDisplayMode: displayMode,
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(expr)}</code>`;
  }
}

function renderImage(alt: string, path: string): string {
  const safeAlt = escapeHtml(alt);
  if (/^https?:\/\//i.test(path)) {
    return `<img src="${escapeHtml(path)}" alt="${safeAlt}" class="card-image" loading="lazy" />`;
  }
  const content = getImageContent(path);
  if (!content) {
    return `<span class="card-image-missing">[image not loaded: ${escapeHtml(path)}]</span>`;
  }
  if (content.kind === 'svg') {
    return `<figure class="card-image card-image-svg" aria-label="${safeAlt}">${content.markup}</figure>`;
  }
  if (content.kind === 'data-url') {
    return `<img src="${content.url}" alt="${safeAlt}" class="card-image" loading="lazy" />`;
  }
  return `<span class="card-image-missing">[image error: ${escapeHtml(path)}: ${escapeHtml(content.message)}]</span>`;
}

type ClozeMode = 'placeholder' | 'reveal';

export function renderQuestion(card: Card): string {
  if (card.notetype === 'basic') return renderRich(card.front);
  return renderRich(card.front, 'placeholder');
}

export function renderAnswer(card: Card): string {
  if (card.notetype === 'basic') return renderRich(card.back ?? '');
  return renderRich(card.front, 'reveal');
}

export function renderExtra(text: string): string {
  return renderRich(text);
}

function renderRich(text: string, clozeMode?: ClozeMode): string {
  const parts: string[] = [];
  for (const tok of tokenize(text)) {
    if (tok.kind === 'text') {
      parts.push(escapeHtml(tok.raw));
    } else if (tok.kind === 'math') {
      parts.push(renderMath(tok.raw, tok.displayMode ?? false));
    } else if (tok.kind === 'image') {
      parts.push(renderImage(tok.imageAlt ?? '', tok.imagePath ?? ''));
    } else if (tok.kind === 'cloze') {
      if (clozeMode === 'placeholder' || !clozeMode) {
        parts.push('<span class="cloze-placeholder">[&hellip;]</span>');
      } else {
        // reveal mode
        if (tok.clozeFromMath) {
          // Cloze was extracted from inside math — render the content as math
          // so it typographically matches the surrounding expression.
          parts.push(
            `<span class="cloze-reveal">${renderMath(tok.clozeContent ?? '', tok.clozeDisplayMode ?? false)}</span>`,
          );
        } else {
          // Cloze was authored as prose — full recursive render (text + math).
          const inner = renderRich(tok.clozeContent ?? '');
          parts.push(`<span class="cloze-reveal">${inner}</span>`);
        }
      }
    }
  }
  return parts.join('');
}
