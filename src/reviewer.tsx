import { useEffect, useState } from 'preact/hooks';
import type { Card } from './cards';
import { Rating, intervalLabel, type FSRSCardState, type ReviewRating } from './fsrs';
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
import { createItem, updateItem, type FieldMap, type SrsItem } from './srsState';
import { writeSession } from './sessionLog';

interface Props {
  token: string;
  cards: Card[];
  initialState: Map<string, SrsItem>;
  srsProjectId: string;
  srsFields: FieldMap;
  logProjectId: string;
  logFields: FieldMap;
  onExit: () => void;
}

type Mode = 'preparing' | 'reviewing' | 'completing' | 'complete';

type SyncStatus = 'idle' | 'syncing' | 'error';

export function Reviewer({
  token,
  cards,
  initialState,
  srsProjectId,
  srsFields,
  logProjectId,
  logFields,
  onExit,
}: Props) {
  const [mode, setMode] = useState<Mode>('preparing');
  const [revealed, setRevealed] = useState(false);
  const [session, setSession] = useState<ReviewSession | undefined>(undefined);
  // GUID -> projectItemId. Starts populated from initialState; growing as new cards land.
  const [itemIds] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    initialState.forEach((v, k) => m.set(k, v.itemId));
    return m;
  });
  const [sync, setSync] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string | undefined>(undefined);
  const [endError, setEndError] = useState<string | undefined>(undefined);

  // Build state map from initialState for queue construction.
  const stateMap = (() => {
    const m = new Map<string, FSRSCardState>();
    initialState.forEach((v, k) => m.set(k, v.state));
    return m;
  })();

  if (mode === 'preparing') {
    const queue = buildQueue(cards, stateMap);
    return (
      <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
        <strong>Review session</strong>
        <p style={{ margin: 0 }}>
          {queue.length === 0
            ? 'Nothing due. Add new cards or wait until tomorrow.'
            : `${queue.length} card(s) in queue. Existing SRS items: ${initialState.size}.`}
        </p>
        <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
          Each answer persists to <code>anki-client/srs-state</code>; session summary writes to{' '}
          <code>anki-client/session-log</code> at the end.
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
      setMode('completing');
      return null;
    }
    const card = item.card;
    return (
      <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <strong>{session.index + 1} / {session.queue.length}</strong>
          <span class="muted" style={{ fontSize: '0.85em' }}>
            <code>{card.id}</code>
            {sync === 'syncing' && ' · syncing…'}
            {sync === 'error' && ` · sync failed: ${syncError}`}
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
                disabled={sync === 'syncing'}
                onClick={async () => {
                  const { next, updatedState } = answerSession(session, rating as ReviewRating);
                  setSync('syncing');
                  setSyncError(undefined);
                  try {
                    const existingItemId = itemIds.get(card.guid);
                    if (existingItemId) {
                      await updateItem(token, srsProjectId, existingItemId, srsFields, updatedState, card.guid);
                    } else {
                      const newItemId = await createItem(token, srsProjectId, srsFields, card, updatedState);
                      itemIds.set(card.guid, newItemId);
                    }
                    setSync('idle');
                  } catch (e: unknown) {
                    setSync('error');
                    setSyncError((e as Error).message);
                    // Keep going — in-memory state still advances; user can retry by re-answering later.
                  }
                  setSession(next);
                  setRevealed(false);
                  if (isComplete(next)) setMode('completing');
                }}
                style={{ flex: 1 }}
              >
                {label}
                <br />
                <span class="muted" style={{ fontSize: '0.75em' }}>{intervalLabel(item.state, rating as ReviewRating)}</span>
              </button>
            ))}
          </div>
        )}

        <button onClick={() => setMode('completing')} style={{ alignSelf: 'flex-start', fontSize: '0.85em' }}>
          End session early
        </button>
      </section>
    );
  }

  if (mode === 'completing' && session) {
    // Render summary and kick off the session-log write once.
    return (
      <CompletingScreen
        token={token}
        logProjectId={logProjectId}
        logFields={logFields}
        session={session}
        onDone={() => setMode('complete')}
        onError={(msg) => { setEndError(msg); setMode('complete'); }}
        onBack={onExit}
      />
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
        {endError ? (
          <p style={{ color: 'crimson', margin: 0, fontSize: '0.85em' }}>
            Session log write failed: {endError}. SRS state was still saved.
          </p>
        ) : (
          <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
            Logged to <code>anki-client/session-log</code>.
          </p>
        )}
        <button onClick={onExit}>Back</button>
      </section>
    );
  }

  return null;
}

function CompletingScreen({
  token,
  logProjectId,
  logFields,
  session,
  onDone,
  onError,
  onBack,
}: {
  token: string;
  logProjectId: string;
  logFields: FieldMap;
  session: ReviewSession;
  onDone: () => void;
  onError: (msg: string) => void;
  onBack: () => void;
}) {
  useEffect(() => {
    (async () => {
      const t = tally(session);
      if (t.reviews === 0) { onDone(); return; }
      try {
        await writeSession(token, logProjectId, logFields, {
          date: new Date(),
          reviews: t.reviews,
          newCards: t.newCards,
          again: t.again,
          hard: t.hard,
          good: t.good,
          easy: t.easy,
          retentionPct: t.retentionPct,
          timeMin: Math.max(1, Math.round(t.elapsedMs / 60000)),
        });
        onDone();
      } catch (e: unknown) {
        onError((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
      <p class="muted" style={{ margin: 0 }}>Writing session log…</p>
      <button onClick={onBack} style={{ alignSelf: 'flex-start', fontSize: '0.85em' }}>Cancel</button>
    </section>
  );
}
