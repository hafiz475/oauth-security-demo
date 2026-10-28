export interface AppConfig {
  port: number;
  /** Origin serving the SPA; the only origin popup completion pages post to. */
  appOrigin: string;
  /** Browser-visible origin of this backend; base for every redirect_uri. */
  apiOrigin: string;
  /** Origins whose Embedded Signup postMessage events are accepted. */
  originAllowlist: string[];
  /** Mock IdP base as seen by the browser (authorize, consent pages). */
  idpPublicBase: string;
  /** Mock IdP base as seen by this server (token exchange). */
  idpInternalBase: string;
  /** Meta Graph base used for page/form lookups. */
  graphBase: string;
  dbPath: string;
  env: Record<string, string | undefined>;
  now: () => number;
  fetch: typeof fetch;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const port = Number(env.PORT ?? 3000);
  const appOrigin = trimSlash(env.APP_ORIGIN ?? 'http://localhost:5173');
  const apiOrigin = trimSlash(env.API_PUBLIC_ORIGIN ?? appOrigin);
  const idpInternalBase = trimSlash(env.MOCK_IDP_INTERNAL_BASE ?? `http://127.0.0.1:${port}/mock-oauth`);
  const originAllowlist = (env.ORIGIN_ALLOWLIST ?? `${appOrigin},http://localhost:${port},https://www.facebook.com`)
    .split(',')
    .map((o) => trimSlash(o.trim()))
    .filter(Boolean);

  return {
    port,
    appOrigin,
    apiOrigin,
    originAllowlist,
    idpPublicBase: trimSlash(env.MOCK_IDP_PUBLIC_BASE ?? `${apiOrigin}/mock-oauth`),
    idpInternalBase,
    graphBase: trimSlash(env.META_GRAPH_BASE ?? `${idpInternalBase}/graph`),
    dbPath: env.DB_PATH ?? './data/demo.sqlite',
    env,
    now: () => Date.now(),
    fetch: (input, init) => globalThis.fetch(input, init),
    ...overrides,
  };
}
