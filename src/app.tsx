import { useEffect, useState } from 'preact/hooks';
import { loadConfig, type AppConfig } from './config';
import {
  clearToken,
  getToken,
  pollDeviceFlow,
  setToken,
  startDeviceFlow,
  verifyToken,
  type DeviceCodeStart,
} from './auth';

type Viewer = { login: string; id: string };

type AuthState =
  | { kind: 'unauth' }
  | { kind: 'device-pending'; start: DeviceCodeStart; status: string }
  | { kind: 'verifying' }
  | { kind: 'authed'; viewer: Viewer }
  | { kind: 'error'; message: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | undefined>(undefined);
  const [state, setState] = useState<AuthState>({ kind: 'unauth' });
  const [patInput, setPatInput] = useState('');

  // Boot: load config, try existing token.
  useEffect(() => {
    (async () => {
      const cfg = await loadConfig();
      setConfig(cfg);
      const existing = getToken();
      if (!existing) return;
      setState({ kind: 'verifying' });
      const v = await verifyToken(existing);
      if (v) setState({ kind: 'authed', viewer: v });
      else {
        clearToken();
        setState({ kind: 'unauth' });
      }
    })();
  }, []);

  if (!config) return <p class="muted">Loading…</p>;

  return (
    <main class="stack">
      <h1>anki-client</h1>

      {state.kind === 'unauth' && (
        <div class="stack">
          <p class="muted">
            Sign in to load cards from <code>{config.cardSource.owner}/{config.cardSource.repo}</code>{' '}
            and sync SRS state to your <code>{config.projectPrefix}*</code> projects.
          </p>
          <button onClick={() => beginDeviceFlow(config, setState)}>Sign in with GitHub (device flow)</button>
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

      {state.kind === 'device-pending' && (
        <div class="stack">
          <p>
            Open{' '}
            <a href={state.start.verification_uri} target="_blank" rel="noreferrer">
              {state.start.verification_uri}
            </a>{' '}
            and enter this code:
          </p>
          <div class="code-card">{state.start.user_code}</div>
          <p class="muted">{state.status}</p>
          <button onClick={() => setState({ kind: 'unauth' })}>Cancel</button>
        </div>
      )}

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

async function beginDeviceFlow(config: AppConfig, setState: (s: AuthState) => void): Promise<void> {
  try {
    const start = await startDeviceFlow(config.oauthClientId, config.scopes);
    setState({ kind: 'device-pending', start, status: 'Waiting for you to authorize on github.com…' });
    const expiresAt = Date.now() + start.expires_in * 1000;
    while (Date.now() < expiresAt) {
      await new Promise((res) => setTimeout(res, start.interval * 1000));
      const r = await pollDeviceFlow(config.oauthClientId, start.device_code, start.interval);
      if (r.kind === 'ok') {
        setToken(r.access_token);
        setState({ kind: 'verifying' });
        const v = await verifyToken(r.access_token);
        if (v) {
          setState({ kind: 'authed', viewer: v });
          return;
        }
        setState({ kind: 'error', message: 'Token received but viewer query failed.' });
        return;
      }
      if (r.kind === 'denied') {
        setState({ kind: 'error', message: `${r.error}${r.description ? `: ${r.description}` : ''}` });
        return;
      }
      // pending: loop
    }
    setState({ kind: 'error', message: 'Device code expired before authorization.' });
  } catch (e: unknown) {
    setState({ kind: 'error', message: `${(e as Error).message}. If this is a CORS error, use PAT paste instead — see SYNC-DESIGN §11.` });
  }
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
