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
  type ProjectMap,
} from './projects';

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

const REQUIRED_PURPOSES = ['srs-state', 'session-log'] as const;

export function App() {
  const [config, setConfig] = useState<AppConfig | undefined>(undefined);
  const [state, setState] = useState<AuthState>({ kind: 'booting' });
  const [projects, setProjects] = useState<ProjectsState>({ kind: 'idle' });
  const [patInput, setPatInput] = useState('');

  // Boot: load config, handle any OAuth callback in the URL, then try existing token.
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

  // After auth, discover projects (use cache first, refresh in background).
  useEffect(() => {
    if (state.kind !== 'authed' || !config) return;
    const token = getToken();
    if (!token) return;

    const cached = loadCachedProjects(state.viewer.login);
    if (cached) setProjects({ kind: 'loaded', map: cached });
    else setProjects({ kind: 'loading' });

    (async () => {
      try {
        const map = await discoverProjects(token, config.projectPrefix, state.viewer.login);
        setProjects({ kind: 'loaded', map });
      } catch (e: unknown) {
        if (!cached) setProjects({ kind: 'error', message: (e as Error).message });
      }
    })();
  }, [state.kind === 'authed' ? state.viewer.login : null, config]);

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
              <code>proxyUrl</code> is not configured in <code>public/config.json</code> yet. Use PAT paste below
              until the OAuth proxy is deployed.
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
        return (
          <div class="stack">
            <p>
              Signed in as <strong>@{state.viewer.login}</strong>.
            </p>
            <p class="muted">
              Card source: <code>{effective.cardSource.owner}/{effective.cardSource.repo}/{effective.cardSource.path}</code>
            </p>

            <ProjectsPanel
              state={projects}
              prefix={effective.projectPrefix}
              viewerLogin={state.viewer.login}
              onRefresh={() => {
                const token = getToken();
                if (!token) return;
                clearProjectsCache(state.viewer.login);
                setProjects({ kind: 'loading' });
                discoverProjects(token, effective.projectPrefix, state.viewer.login)
                  .then((map) => setProjects({ kind: 'loaded', map }))
                  .catch((e) => setProjects({ kind: 'error', message: (e as Error).message }));
              }}
            />

            <p class="muted">
              Next steps: fetch cards via Contents API, FSRS queue, lazy Project Item creation on first review.
            </p>
            <button
              onClick={() => {
                clearToken();
                clearProjectsCache(state.viewer.login);
                setProjects({ kind: 'idle' });
                setState({ kind: 'unauth' });
              }}
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
  viewerLogin: _viewerLogin,
  onRefresh,
}: {
  state: ProjectsState;
  prefix: string;
  viewerLogin: string;
  onRefresh: () => void;
}) {
  return (
    <section class="stack" style={{ border: '1px solid currentColor', borderRadius: 8, padding: '0.75rem' }}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <strong>Projects discovered (<code>{prefix}*</code>)</strong>
        <button onClick={onRefresh} style={{ fontSize: '0.85em', padding: '0.25rem 0.5rem' }}>
          Refresh
        </button>
      </div>

      {state.kind === 'idle' && <p class="muted" style={{ margin: 0 }}>—</p>}
      {state.kind === 'loading' && <p class="muted" style={{ margin: 0 }}>Querying GraphQL…</p>}
      {state.kind === 'error' && (
        <p style={{ color: 'crimson', margin: 0 }}>Error: {state.message}</p>
      )}

      {state.kind === 'loaded' && (
        <>
          {state.map.all.length === 0 ? (
            <p class="muted" style={{ margin: 0 }}>
              No projects matching <code>{prefix}*</code>. Create them on github.com — see SYNC-DESIGN §11.1.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
              {state.map.all.map((p) => (
                <li key={p.id}>
                  <a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a>{' '}
                  <code>{p.purpose}</code>{' '}
                  <span class="muted" style={{ fontSize: '0.85em' }}>{p.id}</span>
                </li>
              ))}
            </ul>
          )}

          {(() => {
            const missing = REQUIRED_PURPOSES.filter((p) => !state.map.byPurpose[p]);
            return missing.length === 0 ? (
              <p class="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                ✓ Both required projects ({REQUIRED_PURPOSES.map((p) => <><code>{p}</code> </>)}) present.
              </p>
            ) : (
              <p style={{ color: 'orange', margin: 0, fontSize: '0.85em' }}>
                Missing: {missing.map((p) => <><code>{prefix}{p}</code> </>)}
              </p>
            );
          })()}
        </>
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
