// FSRS wrapper. We use ts-fsrs (the same algorithm Anki ≥ 23.10 uses) directly.
// `Rating` and `State` enums are re-exported so callers don't need a separate
// ts-fsrs dependency line.

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FSRSCardState,
  type RecordLog,
} from 'ts-fsrs';

export { Rating, State };
export type { FSRSCardState, RecordLog };

/** Rating values valid as RecordLog indices (excludes Rating.Manual = 0). */
export type ReviewRating = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

const params = generatorParameters({
  enable_fuzz: true,
  request_retention: 0.9,
});
const scheduler = fsrs(params);

export function freshState(): FSRSCardState {
  return createEmptyCard();
}

/** Returns the four hypothetical next-states (Again / Hard / Good / Easy). */
export function preview(state: FSRSCardState, now: Date = new Date()): RecordLog {
  return scheduler.repeat(state, now);
}

/** Apply a user-chosen rating, returning the new card state. */
export function applyRating(state: FSRSCardState, rating: ReviewRating, now: Date = new Date()): FSRSCardState {
  return scheduler.repeat(state, now)[rating].card;
}

/** True iff the card is due for review on or before `now`. */
export function isDue(state: FSRSCardState, now: Date = new Date()): boolean {
  if (state.state === State.New) return true;
  return state.due.getTime() <= now.getTime();
}

/** Short human-friendly label for the interval after a hypothetical rating. */
export function intervalLabel(state: FSRSCardState, rating: ReviewRating, now: Date = new Date()): string {
  const next = scheduler.repeat(state, now)[rating].card;
  const ms = next.due.getTime() - now.getTime();
  if (ms < 60_000) return '<1m';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
