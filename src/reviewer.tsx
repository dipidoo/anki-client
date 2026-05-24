import { useEffect, useState } from 'preact/hooks';
import type { Card, CardSource } from './cards';
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
import { renderAnswer, renderExtra, renderQuestion } from './renderCard';
import { createItem, updateItem, type FieldMap, type SrsItem } from './srsState';
import { writeSession } from './sessionLog';

interface Props {
  token: string;
  cards: Card[];
  cardSource: CardSource;
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
  cardSource: _cardSource,
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
  const [itemIds] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    initialState.forEach((v, k) => m.set(k, v.itemId));
    return m;
  });
  const [sync, setSync] = useState<SyncStatus>('idle');
  const [syncError, setSyncError] = useState<string | undefined>(undefined);
  const [endError, setEndError] = useState<string | undefined>(undefined);

  const stateMap = (() => {
    const m = new Map<string, FSRSCardState>();
    initialState.forEach((v, k) => m.set(k, v.state));
    return m;
  })();

  useEffect(() => {
    if (mode !== 'reviewing' || !session) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (sync === 'syncing') return;
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      let chosen: ReviewRating | undefined;
      if (e.key === '1') chosen = Rating.Again;
      else if (e.key === '2') chosen = Rating.Hard;
      else if (e.key === '3' || e.key === ' ' || e.key === 'Enter') chosen = Rating.Good;
      else if (e.key === '4') chosen = Rating.Easy;
      if (!chosen) return;
      e.preventDefault();
      void answerCard(chosen);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, revealed, session, sync]);

  async function answerCard(rating: ReviewRating): Promise<void> {
    if (!session) return;
    const item = currentItem(session);
    if (!item) return;
    const { next, updatedState } = answerSession(session, rating);
    setSync('syncing');
    setSyncError(undefined);
    try {
      const existing = itemIds.get(item.card.guid);
      if (existing) {
        await updateItem(token, srsProjectId, existing, srsFields, updatedState, item.card.guid);
      } else {
        const newId = await createItem(token, srsProjectId, srsFields, item.card, updatedState);
        itemIds.set(item.card.guid, newId);
      }
      setSync('idle');
    } catch (e: unknown) {
      setSync('error');
      setSyncError((e as Error).message);
    }
    setSession(next);
    setRevealed(false);
    if (isComplete(next)) setMode('completing');
  }

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
          Shortcuts: <kbd>Space</kbd> show answer / Good · <kbd>1</kbd> Again · <kbd>2</kbd> Hard · <kbd>3</kbd> Good · <kbd>4</kbd> Easy
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
    const body = revealed ? renderAnswer(card) : renderQuestion(card);
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

        <div class="card-body" dangerouslySetInnerHTML={{ __html: body }} />

        {revealed && card.extra && (
          <div
            class="card-body muted"
            style={{ borderTop: '1px solid currentColor', paddingTop: '0.5rem', fontSize: '0.95em' }}
            dangerouslySetInnerHTML={{ __html: renderExtra(card.extra) }}
          />
        )}
        {revealed && card.source && (
          <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>{card.source}</p>
        )}

        {!revealed ? (
          <button onClick={() => setRevealed(true)}>
            Show answer<span class="kbd-hint">[Space]</span>
          </button>
        ) : (
          <div class="row">
            {([
              [Rating.Again, 'Again', '1'],
              [Rating.Hard,  'Hard',  '2'],
              [Rating.Good,  'Good',  '3'],
              [Rating.Easy,  'Easy',  '4'],
            ] as const).map(([rating, label, key]) => (
              <button
                key={rating}
                disabled={sync === 'syncing'}
                onClick={() => void answerCard(rating as ReviewRating)}
                style={{ flex: 1 }}
              >
                {label}<span class="kbd-hint">[{key}]</span>
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
