import { useEffect, useState } from 'preact/hooks';
import { loadConfig, resolveConfig, type AppConfig } from './config';
import {
  authorize,
  clearToken,
  getToken,
  handleCallback,
  setToken,
  verifyToken,
} from './auth';
import {
  clearProjectsCache,
  discoverProjects,
  loadCachedProjects,
  type DiscoveredProject,
  type ProjectMap,
} from './projects';
import { loadAllCards, type Card } from './cards';
import { Reviewer } from './reviewer';
import { discoverFields, loadAllItems, type FieldMap, type SrsItem } from './srsState';

type Viewer = { login: string; id: string };

type AuthState =
  | { kind: 'booting' }
  | { kind: 'unauth' }
  | { kind: 'exchanging' }
  | { kind: 'verifying' }
  | { kind: 'authed'; viewer: Viewer }
  | { kind: 'error'; message: string };

type ProjectsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; map: ProjectMap }
  | { kind: 'error'; message: string };

type CardsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; cards: Card[] }
  | { kind: 'error'; message: string };

type SrsBundle = {
  srs: DiscoveredProject;
  log: DiscoveredProject;
  srsFields: FieldMap;
  logFields: FieldMap;
  items: Map<string, SrsItem>;
};

type SrsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; bundle: SrsBundle }
  | { kind: 'error'; message: string };

type View = 'home' | 'review';

const REQUIRED_PURPOSES = ['srs-state', 'session-log'] as const;

export function App() {
  const [config, setConfig] = useState<AppConfig | undefined>(undefined);
  const [state, setState] = useState<AuthState>({ kind: 'booting' });
  const [projects, setProjects] = useState<ProjectsState>({ kind: 'idle' });
  const [cards, setCards] = useState<CardsState>({ kind: 'idle' });
  const [srs, setSrs] = useState<SrsState>({ kind: 'idle' });
  const [patInput, setPatInput] = useState('');
  const [view, setView] = useState<View>('home');

  useEffect(() => {
    (async () => {
      const cfg = await loadConfig();
      setConfig(cfg);

      const cb = await handleCallback(cfg);
      if (cb.kind === 'error') {
        setState({ kind: 'error', message: cb.error ?? 'Auth callback failed.' });
        return;
      }
      if (cb.kind === 'ok' && cb.token) {
        setState({ kind: 'verifying' });
        const v = await verifyToken(cb.token);
        if (v) setState({ kind: 'authed', viewer: v });
        else {
          clearToken();
          setState({ kind: 'error', message: 'Token issued but viewer query failed.' });
        }
        return;
      }

      const existing = getToken();
      if (!existing) {
        setState({ kind: 'unauth' });
        return;
      }
      setState({ kind: 'verifying' });
      const v = await verifyToken(existing);
      if (v) setState({ kind: 'authed', viewer: v });
      else {
        clearToken();
        setState({ kind: 'unauth' });
      }
    })();
  }, []);

  useEffect(() => {
    if (state.kind !== 'authed' || !config) return;
    const token = getToken();
    if (!token) return;
    const effective = resolveConfig(config, state.viewer.login);

    // Projects
    const cached = loadCachedProjects(state.viewer.login);
    if (cached) setProjects({ kind: 'loaded', map: cached });
    else setProjects({ kind: 'loading' });
    discoverProjects(token, effective.projectPrefix, state.viewer.login)
      .then((map) => setProjects({ kind: 'loaded', map }))
      .catch((e) => {
        if (!cached) setProjects({ kind: 'error', message: (e as Error).message });
      });

    // Cards
    setCards({ kind: 'loading' });
    loadAllCards(token, effective.cardSource)
      .then((cs) => setCards({ kind: 'loaded', cards: cs }))
      .catch((e) => setCards({ kind: 'error', message: (e as Error).message }));
  }, [state.kind === 'authed' ? state.viewer.login : null, config]);

  // Once projects are loaded, discover their fields + load existing SRS items.
  useEffect(() => {
    if (projects.kind !== 'loaded') return;
    const srsProj = projects.map.byPurpose['srs-state'];
    const logProj = projects.map.byPurpose['session-log'];
    if (!srsProj || !logProj) return;
    const token = getToken();
    if (!token) return;

    setSrs({ kind: 'loading' });
    (async () => {
      try {
        const [srsFields, logFields, items] = await Promise.all([
          discoverFields(token, srsProj.id),
          discoverFields(token, logProj.id),
          loadAllItems(token, srsProj.id),
        ]);
        setSrs({ kind: 'loaded', bundle: { srs: srsProj, log: logProj, srsFields, logFields, items } });
      } catch (e: unknown) {
        setSrs({ kind: 'error', message: (e as Error).message });
      }
    })();
  }, [projects]);

  if (state.kind === 'booting' || !config) return <p class="muted">Loading…</p>;

  return (
    <main class="stack">
      <h1>anki-client</h1>

      {state.kind === 'unauth' && (
        <div class="stack">
          <p class="muted">
            Sign in to load cards from your <code>{config.cardSource.repo}</code> repo and sync SRS state to
            your <code>{config.projectPrefix}*</code> projects.
          </p>
          <button onClick={() => authorize(config)} disabled={!config.proxyUrl}>
            Sign in with GitHub
          </button>
          {!config.proxyUrl && (
            <p class="muted" style={{ fontSize: '0.85em' }}>
              <code>proxyUrl</code> is not configured in <code>public/config.json</code> yet.
            </p>
          )}
          <details>
            <summary class="muted">Or paste a personal access token</summary>
            <div class="stack" style={{ marginTop: '0.5rem' }}>
              <p class="muted" style={{ margin: 0 }}>
                Fine-grained PAT with <code>Contents: Read</code> on <code>{config.cardSource.repo}</code> plus{' '}
                <code>Projects: Read and write</code> at user scope.
              </p>
              <input
                type="password"
                placeholder="ghp_… or github_pat_…"
                value={patInput}
                onInput={(e) => setPatInput((e.target as HTMLInputElement).value)}
              />
              <button onClick={() => acceptPat(patInput, setState, setPatInput)} disabled={!patInput.trim()}>
                Use token
              </button>
            </div>
          </details>
        </div>
      )}

      {state.kind === 'exchanging' && <p class="muted">Exchanging code for token…</p>}
      {state.kind === 'verifying' && <p class="muted">Verifying token…</p>}

      {state.kind === 'error' && (
        <div class="stack">
          <p style={{ color: 'crimson' }}>Error: {state.message}</p>
          <button onClick={() => setState({ kind: 'unauth' })}>Back</button>
        </div>
      )}

      {state.kind === 'authed' && (() => {
        const effective = resolveConfig(config, state.viewer.login);
        const loadedCards = cards.kind === 'loaded' ? cards.cards : [];
        const token = getToken();

        if (view === 'review' && loadedCards.length > 0 && srs.kind === 'loaded' && token) {
          return (
            <Reviewer
              token={token}
              cards={loadedCards}
              initialState={srs.bundle.items}
              srsProjectId={srs.bundle.srs.id}
              srsFields={srs.bundle.srsFields}
              logProjectId={srs.bundle.log.id}
              logFields={srs.bundle.logFields}
              onExit={() => {
                setView('home');
                // refresh items so next session sees writes from this one
                if (token) loadAllItems(token, srs.bundle.srs.id).then((items) => {
                  setSrs((prev) => prev.kind === 'loaded' ? { kind: 'loaded', bundle: { ...prev.bundle, items } } : prev);
                }).catch(() => {});
              }}
            />
          );
        }

        return (
          <div class="stack">
            <p>
              Signed in as <strong>@{state.viewer.login}</strong>.
            </p>

            <ProjectsPanel
              state={projects}
              prefix={effective.projectPrefix}
              onRefresh={() => {
                if (!token) return;
                clearProjectsCache(state.viewer.login);
                setProjects({ kind: 'loading' });
                discoverProjects(token, effective.projectPrefix, state.viewer.login)
                  .then((map) => setProjects({ kind: 'loaded', map }))
                  .catch((e) => setProjects({ kind: 'error', message: (e as Error).message }));
              }}
            />

            <CardsPanel
              state={cards}
              source={effective.cardSource}
              onRefresh={() => {
                if (!token) return;
                setCards({ kind: 'loading' });
                loadAllCards(token, effective.cardSource)
                  .then((cs) => setCards({ kind: 'loaded', cards: cs }))
                  .catch((e) => setCards({ kind: 'error', message: (e as Error).message }));
              }}
            />

            <SrsPanel state={srs} />

            <button
              onClick={() => setView('review')}
              disabled={cards.kind !== 'loaded' || loadedCards.length === 0 || srs.kind !== 'loaded'}
              style={{ alignSelf: 'flex-start' }}
            >
              Start review →
            </button>

            <button
              onClick={() => {
                clearToken();
                clearProjectsCache(state.viewer.login);
                setProjects({ kind: 'idle' });
                setCards({ kind: 'idle' });
                setSrs({ kind: 'idle' });
                setState({ kind: 'unauth' });
              }}
              style={{ alignSelf: 'flex-start', fontSize: '0.85em' }}
            >
              Sign out
            </button>
          </div>
        );
      })()}
    </main>
  );
}

function ProjectsPanel({
  state,
  prefix,
  onRefresh,
}: {
  state: ProjectsState;
  prefix: string;
  onRefresh: () => void;
}) {
  return (
    <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <strong>Projects discovered (<code>{prefix}*</code>)</strong>
        <button onClick={onRefresh} style={{ fontSize: '0.85em', padding: '0.25rem 0.5rem' }}>Refresh</button>
      </div>

      {state.kind === 'idle' && <p class="muted" style={{ margin: 0 }}>—</p>}
      {state.kind === 'loading' && <p class="muted" style={{ margin: 0 }}>Querying GraphQL…</p>}
      {state.kind === 'error' && <p style={{ color: 'crimson', margin: 0 }}>Error: {state.message}</p>}

      {state.kind === 'loaded' && (
        <>
          {state.map.all.length === 0 ? (
            <p class="muted" style={{ margin: 0 }}>No projects matching <code>{prefix}*</code>.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              {state.map.all.map((p) => (
                <li key={p.id}>
                  <a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> <code>{p.purpose}</code>
                </li>
              ))}
            </ul>
          )}
          {(() => {
            const missing = REQUIRED_PURPOSES.filter((p) => !state.map.byPurpose[p]);
            return missing.length === 0 ? (
              <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>✓ Both required projects present.</p>
            ) : (
              <p style={{ color: 'orange', margin: 0, fontSize: '0.85em' }}>
                Missing: {missing.map((p) => <><code>{prefix}{p}</code>{' '}</>)}
              </p>
            );
          })()}
        </>
      )}
    </section>
  );
}

function CardsPanel({
  state,
  source,
  onRefresh,
}: {
  state: CardsState;
  source: { owner: string; repo: string; branch: string; path: string };
  onRefresh: () => void;
}) {
  return (
    <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <strong>Cards loaded</strong>
        <button onClick={onRefresh} style={{ fontSize: '0.85em', padding: '0.25rem 0.5rem' }}>Refresh</button>
      </div>
      <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
        Source: <code>{source.owner}/{source.repo}@{source.branch}:{source.path}/</code>
      </p>
      {state.kind === 'idle' && <p class="muted" style={{ margin: 0 }}>—</p>}
      {state.kind === 'loading' && <p class="muted" style={{ margin: 0 }}>Fetching YAML…</p>}
      {state.kind === 'error' && <p style={{ color: 'crimson', margin: 0 }}>Error: {state.message}</p>}
      {state.kind === 'loaded' && (
        <p style={{ margin: 0 }}>
          <strong>{state.cards.length}</strong> cards across{' '}
          <strong>{new Set(state.cards.map((c) => c.sourceFile)).size}</strong> files.
        </p>
      )}
    </section>
  );
}

function SrsPanel({ state }: { state: SrsState }) {
  return (
    <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
      <strong>SRS state</strong>
      {state.kind === 'idle' && <p class="muted" style={{ margin: 0 }}>—</p>}
      {state.kind === 'loading' && <p class="muted" style={{ margin: 0 }}>Loading existing items + project fields…</p>}
      {state.kind === 'error' && <p style={{ color: 'crimson', margin: 0 }}>Error: {state.message}</p>}
      {state.kind === 'loaded' && (
        <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
          {state.bundle.items.size} existing item(s). Fields ready for read/write.
        </p>
      )}
    </section>
  );
}

async function acceptPat(
  pat: string,
  setState: (s: AuthState) => void,
  setPatInput: (v: string) => void,
): Promise<void> {
  setState({ kind: 'verifying' });
  const v = await verifyToken(pat.trim());
  if (v) {
    setToken(pat.trim());
    setPatInput('');
    setState({ kind: 'authed', viewer: v });
  } else {
    setState({ kind: 'error', message: 'Token verification failed (bad token or missing scopes).' });
  }
}
