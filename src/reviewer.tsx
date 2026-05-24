import { useMemo, useState } from 'preact/hooks';
import type { Card } from './cards';
import { Rating, intervalLabel, type FSRSCardState } from './fsrs';
import {
  answer as answerSession,
  buildQueue,
  currentItem,
  isComplete,
  newSession,
  tally,
  type ReviewSession,
} from './review';
import { renderAnswer, renderQuestion } from './renderCard';

interface Props {
  cards: Card[];
  /** Existing per-GUID FSRS state (phase 3b — empty for now). */
  stateByGuid?: Map<string, FSRSCardState>;
  onExit: () => void;
}

type Mode = 'preparing' | 'reviewing' | 'complete';

export function Reviewer({ cards, stateByGuid, onExit }: Props) {
  const [mode, setMode] = useState<Mode>('preparing');
  const [revealed, setRevealed] = useState(false);
  const [session, setSession] = useState<ReviewSession | undefined>(undefined);

  const queue = useMemo(() => buildQueue(cards, stateByGuid ?? new Map()), [cards, stateByGuid]);

  if (mode === 'preparing') {
    return (
      <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
        <strong>Review session</strong>
        <p style={{ margin: 0 }}>
          {queue.length === 0
            ? 'Nothing due. Add new cards or wait until tomorrow.'
            : `${queue.length} card(s) in queue (mix of due reviews + capped new).`}
        </p>
        <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
          Phase 3a: in-memory only. Answers are NOT yet persisted to the SRS-state project — that lands in 3b.
        </p>
        <div class="row">
          <button
            onClick={() => {
              setSession(newSession(queue));
              setRevealed(false);
              setMode('reviewing');
            }}
            disabled={queue.length === 0}
          >
            Start
          </button>
          <button onClick={onExit}>Back</button>
        </div>
      </section>
    );
  }

  if (mode === 'reviewing' && session) {
    const item = currentItem(session);
    if (!item) {
      setMode('complete');
      return null;
    }
    const card = item.card;
    return (
      <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <strong>{session.index + 1} / {session.queue.length}</strong>
          <span class="muted" style={{ fontSize: '0.85em' }}>
            <code>{card.id}</code>
          </span>
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: '1.05em' }}>
          {revealed ? renderAnswer(card) : renderQuestion(card)}
        </pre>
        {revealed && card.extra && (
          <p class="muted" style={{ margin: 0, borderTop: '1px solid currentColor', paddingTop: '0.5rem' }}>
            {card.extra}
          </p>
        )}
        {revealed && card.source && (
          <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>{card.source}</p>
        )}

        {!revealed ? (
          <button onClick={() => setRevealed(true)}>Show answer</button>
        ) : (
          <div class="row">
            {([
              [Rating.Again, 'Again'],
              [Rating.Hard,  'Hard'],
              [Rating.Good,  'Good'],
              [Rating.Easy,  'Easy'],
            ] as const).map(([rating, label]) => (
              <button
                key={rating}
                onClick={() => {
                  const { next } = answerSession(session, rating);
                  setSession(next);
                  setRevealed(false);
                  if (isComplete(next)) setMode('complete');
                }}
                style={{ flex: 1 }}
              >
                {label}
                <br />
                <span class="muted" style={{ fontSize: '0.75em' }}>{intervalLabel(item.state, rating)}</span>
              </button>
            ))}
          </div>
        )}

        <button onClick={onExit} style={{ alignSelf: 'flex-start', fontSize: '0.85em' }}>End session</button>
      </section>
    );
  }

  if (mode === 'complete' && session) {
    const t = tally(session);
    return (
      <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
        <strong>Session complete</strong>
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          <li>{t.reviews} reviewed ({t.newCards} new)</li>
          <li>Again {t.again} · Hard {t.hard} · Good {t.good} · Easy {t.easy}</li>
          <li>Retention: {t.retentionPct}%</li>
          <li>Time: {Math.round(t.elapsedMs / 1000)}s</li>
        </ul>
        <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
          (Phase 3b: this summary will be written as a DraftIssue in <code>anki-client/session-log</code>.)
        </p>
        <button onClick={onExit}>Back</button>
      </section>
    );
  }

  return null;
}
