// Review session state machine. Phase 3a: in-memory only — survives reloads
// within one browser tab via session-scoped storage, but does NOT persist to
// GitHub Projects yet. That comes in phase 3b.

import type { Card } from './cards';
import { freshState, isDue, applyRating, type FSRSCardState, type ReviewRating } from './fsrs';

export interface QueueItem {
  card: Card;
  state: FSRSCardState;
}

const NEW_CARDS_PER_SESSION = 10;

/**
 * Build the review queue for `now` from the full card list + an existing
 * per-GUID state map. Cards with no state yet are treated as new and capped
 * at the new-card daily quota.
 */
export function buildQueue(
  allCards: Card[],
  stateByGuid: Map<string, FSRSCardState>,
  now: Date = new Date(),
  newCap = NEW_CARDS_PER_SESSION,
): QueueItem[] {
  const due: QueueItem[] = [];
  const newOnes: QueueItem[] = [];
  for (const card of allCards) {
    const existing = stateByGuid.get(card.guid);
    if (!existing) {
      newOnes.push({ card, state: freshState() });
      continue;
    }
    if (isDue(existing, now)) due.push({ card, state: existing });
  }
  return [...due, ...newOnes.slice(0, newCap)];
}

export interface ReviewSession {
  queue: QueueItem[];
  index: number;
  answers: Array<{ guid: string; rating: ReviewRating; at: Date; from: FSRSCardState; to: FSRSCardState }>;
  startedAt: Date;
}

export function newSession(queue: QueueItem[]): ReviewSession {
  return { queue, index: 0, answers: [], startedAt: new Date() };
}

export function currentItem(session: ReviewSession): QueueItem | undefined {
  return session.queue[session.index];
}

export function isComplete(session: ReviewSession): boolean {
  return session.index >= session.queue.length;
}

/** Window (ms) within which a re-rated card should reappear in the same session. */
const REQUEUE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Answer the current card and advance. If the new state's `due` is still
 * within REQUEUE_WINDOW_MS of now (typical for Again/Hard which bounce the
 * card into a short learning step), the card is re-pushed to the end of the
 * queue so the user sees it again before the session ends.
 */
export function answer(
  session: ReviewSession,
  rating: ReviewRating,
  now: Date = new Date(),
): { next: ReviewSession; updatedState: FSRSCardState } {
  const item = session.queue[session.index];
  if (!item) throw new Error('answer() called on completed session');
  const to = applyRating(item.state, rating, now);
  const log = { guid: item.card.guid, rating, at: now, from: item.state, to };
  const queue = session.queue.slice();
  queue[session.index] = { ...item, state: to };
  if (to.due.getTime() - now.getTime() <= REQUEUE_WINDOW_MS) {
    queue.push({ card: item.card, state: to });
  }
  return {
    next: { ...session, queue, index: session.index + 1, answers: [...session.answers, log] },
    updatedState: to,
  };
}

/** Compute per-rating tallies for the session log. */
export function tally(session: ReviewSession): {
  reviews: number;
  newCards: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  retentionPct: number;
  elapsedMs: number;
} {
  let again = 0, hard = 0, good = 0, easy = 0, newCards = 0;
  for (const a of session.answers) {
    if (a.from.reps === 0) newCards++;
    switch (a.rating) {
      case 1: again++; break;
      case 2: hard++; break;
      case 3: good++; break;
      case 4: easy++; break;
    }
  }
  const reviews = session.answers.length;
  const retentionPct = reviews === 0 ? 0 : Math.round(((good + easy) / reviews) * 100);
  const elapsedMs = (session.answers.at(-1)?.at.getTime() ?? Date.now()) - session.startedAt.getTime();
  return { reviews, newCards, again, hard, good, easy, retentionPct, elapsedMs };
}
