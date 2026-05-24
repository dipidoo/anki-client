// GitHub OAuth Device Flow + PAT-paste fallback.
//
// Device Flow rationale: see Agent.PD/learning/anki/SYNC-DESIGN.md §11 — no
// backend, so we can't hold a client_secret. GitHub doesn't support PKCE for
// OAuth Apps. Device flow is the canonical no-backend path.
//
// CORS note: github.com/login/device/code and /login/oauth/access_token do NOT
// implement OPTIONS preflight. To avoid triggering a preflight we send the body
// as application/x-www-form-urlencoded (a CORS-safelisted Content-Type) instead
// of application/json. This turns each call into a "simple request" the browser
// sends directly. If GitHub returns Access-Control-Allow-Origin on the actual
// POST response, the flow works end-to-end. If not, we still need a proxy or
// PAT fallback.

const LS_TOKEN_KEY = 'anki-client:gh_token';
const GH_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function getToken(): string | undefined {
  return localStorage.getItem(LS_TOKEN_KEY) ?? undefined;
}

export function setToken(token: string): void {
  localStorage.setItem(LS_TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(LS_TOKEN_KEY);
}

// IMPORTANT: Do NOT add custom headers here (e.g. X-Requested-With). Any
// non-safelisted header forces a CORS preflight that GitHub will reject.
// Accept is safelisted; Content-Type with the value below is safelisted.
const SIMPLE_HEADERS: HeadersInit = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

export async function startDeviceFlow(clientId: string, scopes: string[]): Promise<DeviceCodeStart> {
  const body = new URLSearchParams({ client_id: clientId, scope: scopes.join(' ') }).toString();
  const r = await fetch(GH_DEVICE_CODE_URL, { method: 'POST', headers: SIMPLE_HEADERS, body });
  if (!r.ok) throw new Error(`device/code: ${r.status} ${await r.text()}`);
  return r.json();
}

export interface DevicePollOk {
  kind: 'ok';
  access_token: string;
  token_type: string;
  scope: string;
}
export interface DevicePollPending {
  kind: 'pending';
  retryAfterSec: number;
}
export interface DevicePollDenied {
  kind: 'denied';
  error: string;
  description?: string;
}
export type DevicePollResult = DevicePollOk | DevicePollPending | DevicePollDenied;

export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  intervalSec: number,
): Promise<DevicePollResult> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }).toString();
  const r = await fetch(GH_TOKEN_URL, { method: 'POST', headers: SIMPLE_HEADERS, body });
  const data = await r.json();
  if (data.access_token) {
    return { kind: 'ok', access_token: data.access_token, token_type: data.token_type, scope: data.scope };
  }
  if (data.error === 'authorization_pending') return { kind: 'pending', retryAfterSec: intervalSec };
  if (data.error === 'slow_down') return { kind: 'pending', retryAfterSec: intervalSec + 5 };
  return { kind: 'denied', error: data.error, description: data.error_description };
}

// Verify a token works by hitting the GraphQL viewer query. api.github.com DOES
// send CORS allow headers for authed requests, so this is fine.
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
