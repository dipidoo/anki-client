// Card rendering: convert YAML card text into safe HTML with KaTeX math,
// styled cloze deletions, and inline images sourced from the image cache
// (which is pre-populated by preloadImagesForCards before review starts).

import katex from 'katex';
import type { Card } from './cards';
import { getImageContent } from './images';

interface Token {
  kind: 'text' | 'math' | 'cloze' | 'image';
  raw: string;
  displayMode?: boolean;        // math
  clozeContent?: string;        // cloze
  imageAlt?: string;            // image
  imagePath?: string;           // image (repo-relative or absolute URL)
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Order matters: image first (most distinctive prefix !), then cloze, then math.
  const re =
    /!\[([^\]]*)\]\(([^)]+)\)|\{\{c\d+::([^:}]+?)(?:::[^}]+)?\}\}|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', raw: text.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      tokens.push({ kind: 'image', raw: m[0], imageAlt: m[1], imagePath: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: 'cloze', raw: m[0], clozeContent: m[3] });
    } else if (m[4] !== undefined) {
      tokens.push({ kind: 'math', raw: m[4], displayMode: true });
    } else if (m[5] !== undefined) {
      tokens.push({ kind: 'math', raw: m[5], displayMode: false });
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
        const inner = renderRich(tok.clozeContent ?? '');
        parts.push(`<span class="cloze-reveal">${inner}</span>`);
      }
    }
  }
  return parts.join('');
}
