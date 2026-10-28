import type { CallbackParams } from './callbackParams';
import { splitState } from './oauthState';

export type CallbackOutcome =
  | { status: 'success'; provider: string; payloadId: string }
  | { status: 'denied'; error: string }
  | { status: 'invalid'; reason: 'missing_state' | 'missing_code' | 'state_mismatch' }
  | { status: 'failed'; reason: string };

export interface CallbackDeps {
  /** Tab-level check (sessionStorage nonce). Must be single-use. */
  verifyClientNonce(nonce: string | null): boolean;
  /** Server-level check: was this state issued to this session and still unused? */
  verifyState(state: string): Promise<boolean>;
  exchange(code: string, state: string): Promise<{ provider: string; payloadId: string }>;
}

/**
 * Decision logic for an SPA callback route (Patterns 2 and 4). The code is
 * sent to the backend only after both the tab and the server accept the state.
 */
export async function handleOAuthCallback(params: CallbackParams, deps: CallbackDeps): Promise<CallbackOutcome> {
  if (params.error) {
    deps.verifyClientNonce(null); // burn the tab nonce either way
    return { status: 'denied', error: params.error };
  }
  if (!params.state) return { status: 'invalid', reason: 'missing_state' };
  if (!params.code) return { status: 'invalid', reason: 'missing_code' };

  if (!deps.verifyClientNonce(splitState(params.state).clientNonce)) return { status: 'invalid', reason: 'state_mismatch' };
  if (!(await deps.verifyState(params.state))) return { status: 'invalid', reason: 'state_mismatch' };

  try {
    const { provider, payloadId } = await deps.exchange(params.code, params.state);
    return { status: 'success', provider, payloadId };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : 'exchange_failed' };
  }
}
