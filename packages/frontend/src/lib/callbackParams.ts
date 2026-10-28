export interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
}

/**
 * Reads code/state/error from the address bar and immediately replaces the
 * history entry without them, so a refresh, the back button or a shared link
 * cannot replay the code.
 */
export function takeCallbackParams(win: Window = window): CallbackParams {
  const params = new URLSearchParams(win.location.search);
  const taken = { code: params.get('code'), state: params.get('state'), error: params.get('error') };
  if (win.location.search) win.history.replaceState(win.history.state, '', win.location.pathname + win.location.hash);
  return taken;
}
