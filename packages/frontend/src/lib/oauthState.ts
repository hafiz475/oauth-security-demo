const STORAGE_KEY = 'oauth.clientNonce';

export function randomNonce(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function constantTimeEqual(expected: string | null | undefined, actual: string | null | undefined): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected.length === 0 || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

/**
 * Full-page flows use a composite state "<server state>.<tab nonce>". The
 * server checks the whole value against the session; the tab checks its own
 * nonce, so a callback that this tab did not start is refused before any
 * network call is made.
 */
export function splitState(state: string): { serverPart: string; clientNonce: string | null } {
  const dot = state.lastIndexOf('.');
  return dot === -1 ? { serverPart: state, clientNonce: null } : { serverPart: state.slice(0, dot), clientNonce: state.slice(dot + 1) };
}

export function createStateKeeper(storage: Storage) {
  return {
    /** Fresh random value, remembered for this tab only. */
    start(): string {
      const value = randomNonce();
      storage.setItem(STORAGE_KEY, value);
      return value;
    },
    /** Single use: the stored value is removed whether or not it matches. */
    verify(returned: string | null | undefined): boolean {
      const expected = storage.getItem(STORAGE_KEY);
      storage.removeItem(STORAGE_KEY);
      return constantTimeEqual(expected, returned);
    },
  };
}

export type StateKeeper = ReturnType<typeof createStateKeeper>;
