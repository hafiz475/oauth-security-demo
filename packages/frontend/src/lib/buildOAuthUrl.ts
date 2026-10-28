const SENSITIVE_PARAM = /token|secret|password|api[_-]?key|authorization|credentials/i;

export class UnsafeUrlParamError extends Error {
  override name = 'UnsafeUrlParamError';
  constructor(readonly param: string) {
    super(`Refusing to put "${param}" in a URL. Send it in a POST body instead.`);
  }
}

/**
 * Every URL the SPA builds goes through here (M3). A non-empty value under a
 * credential-looking key throws, so a secret cannot end up in history,
 * Referer headers or proxy logs by accident.
 */
export function buildOAuthUrl(base: string | URL, params: Record<string, string | number | boolean> = {}): URL {
  const url = new URL(base, globalThis.location?.origin);
  const search = new URLSearchParams(url.search);
  for (const [key, raw] of Object.entries(params)) {
    const value = String(raw);
    if (SENSITIVE_PARAM.test(key) && value.length > 0) throw new UnsafeUrlParamError(key);
    search.set(key, value);
  }
  url.search = search.toString();
  return url;
}
