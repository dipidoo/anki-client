// Render card content with very simple cloze handling. Real math rendering
// (KaTeX) is a later phase — for now we show LaTeX as raw \(...\) text.

import type { Card } from './cards';

/** Returns the question side: clozes replaced with [...] placeholders. */
export function renderQuestion(card: Card): string {
  if (card.notetype === 'basic') return card.front;
  return card.front.replace(/\{\{c\d+::([^:}]+?)(?:::[^}]+)?\}\}/g, '[ … ]');
}

/** Returns the answer side: clozes revealed with **bold** markers around them. */
export function renderAnswer(card: Card): string {
  if (card.notetype === 'basic') return card.back ?? '';
  // Reveal each cloze content, drop the hint (the part after ::).
  return card.front.replace(/\{\{c\d+::([^:}]+?)(?:::[^}]+)?\}\}/g, (_m, content) => `**${content}**`);
}
