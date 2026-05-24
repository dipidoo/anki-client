export interface AppConfig {
  oauthClientId: string;
  scopes: string[];
  projectPrefix: string;
  /** URL of the server-side OAuth code-exchange helper. See oauth-proxy/. */
  proxyUrl?: string;
  cardSource: {
    /** Empty string means "use the authenticated viewer.login at runtime". */
    owner: string;
    repo: string;
    branch: string;
    path: string;
  };
}

const LS_OVERRIDE_KEY = 'anki-client:config';

let cached: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  const base = await fetch(`${import.meta.env.BASE_URL}config.json`).then((r) => r.json());
  const override = localStorage.getItem(LS_OVERRIDE_KEY);
  cached = override ? { ...base, ...JSON.parse(override) } : base;
  return cached!;
}

/**
 * Returns the config with any "use viewer" placeholders resolved against the
 * authed user. Call this after a successful sign-in.
 */
export function resolveConfig(config: AppConfig, viewerLogin: string): AppConfig {
  return {
    ...config,
    cardSource: {
      ...config.cardSource,
      owner: config.cardSource.owner || viewerLogin,
    },
  };
}

export function saveOverride(partial: Partial<AppConfig>): void {
  const existing = localStorage.getItem(LS_OVERRIDE_KEY);
  const merged = existing ? { ...JSON.parse(existing), ...partial } : partial;
  localStorage.setItem(LS_OVERRIDE_KEY, JSON.stringify(merged));
  cached = undefined;
}

export function clearOverride(): void {
  localStorage.removeItem(LS_OVERRIDE_KEY);
  cached = undefined;
}
