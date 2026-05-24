import { useEffect, useState } from 'preact/hooks';
import { loadConfig, type AppConfig } from './config';
import {
  authorize,
  clearToken,
  getToken,
  handleCallback,
  setToken,
  verifyToken,
} from './auth';

type Viewer = { login: string; id: string };

type AuthState =
  | { kind: 'booting' }
  | { kind: 'unauth' }
  | { kind: 'exchanging' }
  | { kind: 'verifying' }
  | { kind: 'authed'; viewer: Viewer }
  | { kind: 'error'; message: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | undefined>(undefined);
  const [state, setState] = useState<AuthState>({ kind: 'booting' });
  const [patInput, setPatInput] = useState('');

  // Boot: load config, handle any OAuth callback in the URL, then try existing token.
  useEffect(() => {
    (async () => {
      const cfg = await loadConfig();
      setConfig(cfg);

      // 1. If we just came back from github.com with ?code=, exchange it.
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

      // 2. No callback in flight. Try a persisted token.
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

  if (state.kind === 'booting' || !config) return <p class="muted">Loading…</p>;

  return (
    <main class="stack">
      <h1>anki-client</h1>

      {state.kind === 'unauth' && (
        <div class="stack">
          <p class="muted">
            Sign in to load cards from <code>{config.cardSource.owner}/{config.cardSource.repo}</code>{' '}
            and sync SRS state to your <code>{config.projectPrefix}*</code> projects.
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

      {state.kind === 'authed' && (
        <div class="stack">
          <p>
            Signed in as <strong>@{state.viewer.login}</strong>.
          </p>
          <p class="muted">
            Next steps (not yet implemented): discover projects matching{' '}
            <code>{config.projectPrefix}*</code>, fetch cards from{' '}
            <code>{config.cardSource.owner}/{config.cardSource.repo}/{config.cardSource.path}</code>, FSRS queue.
          </p>
          <button
            onClick={() => {
              clearToken();
              setState({ kind: 'unauth' });
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </main>
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
