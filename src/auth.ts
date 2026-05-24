// GitHub OAuth2 Web Flow + PAT-paste fallback.
//
// Why web flow (not device flow): see Agent.PD/learning/anki/SYNC-DESIGN.md §11.
// CORS on github.com/login/* is impossible from a browser, so we proxy the
// code-for-token exchange through a tiny server-side helper that holds the
// client_secret. See ../oauth-proxy/README.md.
//
// Flow:
//   1. authorize() — top-level navigation to github.com (no CORS involved)
//   2. user approves on github.com
//   3. github.com redirects to our origin with ?code=...&state=...
//   4. handleCallback() — reads code from URL, posts to proxy, gets token
//   5. token persists in localStorage; URL is cleaned

import type { AppConfig } from './config';

const LS_TOKEN_KEY = 'anki-client:gh_token';
const SS_STATE_KEY = 'anki-client:oauth_state';

const GH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

export function getToken(): string | undefined {
  return localStorage.getItem(LS_TOKEN_KEY) ?? undefined;
}

export function setToken(token: string): void {
  localStorage.setItem(LS_TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(LS_TOKEN_KEY);
}

/**
 * Begin OAuth2 web flow by navigating to github.com/login/oauth/authorize.
 * This call does NOT return — the page navigates away.
 */
export function authorize(config: AppConfig): void {
  const state = randomState();
  sessionStorage.setItem(SS_STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: callbackUrl(),
    scope: config.scopes.join(' '),
    state,
    allow_signup: 'false',
  });
  window.location.assign(`${GH_AUTHORIZE_URL}?${params.toString()}`);
}

export interface CallbackResult {
  kind: 'ok' | 'error' | 'none';
  token?: string;
  error?: string;
}

/**
 * Called on every app boot. If the current URL has ?code=... from a GitHub
 * redirect, exchange it via the proxy and return the token. Otherwise no-op.
 */
export async function handleCallback(config: AppConfig): Promise<CallbackResult> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const ghError = url.searchParams.get('error');

  // No callback in progress.
  if (!code && !ghError) return { kind: 'none' };

  // Always strip ?code/?state/?error from the URL so refresh doesn't replay.
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  url.searchParams.delete('error_uri');
  window.history.replaceState({}, '', url.toString());

  if (ghError) {
    return { kind: 'error', error: `${ghError}: ${url.searchParams.get('error_description') ?? ''}`.trim() };
  }

  // Validate state to prevent CSRF.
  const expectedState = sessionStorage.getItem(SS_STATE_KEY);
  sessionStorage.removeItem(SS_STATE_KEY);
  if (!expectedState || expectedState !== state) {
    return { kind: 'error', error: 'OAuth state mismatch (possible CSRF or stale callback).' };
  }

  if (!config.proxyUrl) {
    return { kind: 'error', error: 'proxyUrl not configured — cannot exchange code without a server-side helper.' };
  }

  try {
    const r = await fetch(config.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) return { kind: 'error', error: `proxy ${r.status}: ${await r.text()}` };
    const data = (await r.json()) as { access_token?: string; error?: string; error_description?: string };
    if (data.access_token) {
      setToken(data.access_token);
      return { kind: 'ok', token: data.access_token };
    }
    return { kind: 'error', error: data.error_description ?? data.error ?? 'unknown' };
  } catch (e: unknown) {
    return { kind: 'error', error: `proxy unreachable: ${(e as Error).message}` };
  }
}

/** Hit GraphQL viewer query to verify a token. Works against api.github.com — proper CORS. */
export async function verifyToken(token: string): Promise<{ login: string; id: string } | undefined> {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { viewer { id login } }' }),
  });
  if (!r.ok) return undefined;
  const body = await r.json();
  return body?.data?.viewer;
}

// ---- internals ----------------------------------------------------------

function callbackUrl(): string {
  // GitHub matches this against the OAuth App's registered callback URL
  // EXACTLY (including trailing slash). The SPA reads ?code= from this URL.
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
