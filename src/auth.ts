// GitHub OAuth Device Flow + PAT-paste fallback.
//
// Device Flow rationale: see Agent.PD/learning/anki/SYNC-DESIGN.md §11 — no
// backend, so we can't hold a client_secret. GitHub doesn't support PKCE for
// OAuth Apps. Device flow is the canonical no-backend path.
//
// CORS note: github.com/login/device/code and /login/oauth/access_token are
// known to be CORS-restrictive for browser POSTs from arbitrary origins. If
// the device-flow start fails with a CORS error, fall back to PAT paste; we
// can add a tiny edge-proxy later (Cloudflare Worker) if device flow becomes
// the daily-driver path.

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

export async function startDeviceFlow(clientId: string, scopes: string[]): Promise<DeviceCodeStart> {
  const r = await fetch(GH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: scopes.join(' ') }),
  });
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
  const r = await fetch(GH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const body = await r.json();
  if (body.access_token) {
    return { kind: 'ok', access_token: body.access_token, token_type: body.token_type, scope: body.scope };
  }
  if (body.error === 'authorization_pending') return { kind: 'pending', retryAfterSec: intervalSec };
  if (body.error === 'slow_down') return { kind: 'pending', retryAfterSec: intervalSec + 5 };
  return { kind: 'denied', error: body.error, description: body.error_description };
}

// Verify a token works by hitting the GraphQL viewer query.
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
