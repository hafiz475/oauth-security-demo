import { useEffect, useRef, useState } from 'react';
import { api, type SpaFlowKind } from '../lib/api';
import { takeCallbackParams } from '../lib/callbackParams';
import { handleOAuthCallback, type CallbackOutcome } from '../lib/handleCallback';
import { useOAuthState } from '../hooks/useOAuthState';

/**
 * SPA landing route for full-page flows: Pattern 4 (/oauth/callback/:provider,
 * Instagram) and Pattern 2 (/oauth/meta/callback, shared by the Meta apps).
 */
export function CallbackPage({ kind, provider }: { kind: SpaFlowKind; provider: string }) {
  const tab = useOAuthState();
  const [outcome, setOutcome] = useState<CallbackOutcome | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // The code is single-use; StrictMode's second effect run must not resend it.
    if (ran.current) return;
    ran.current = true;
    const params = takeCallbackParams();
    void handleOAuthCallback(params, {
      verifyClientNonce: tab.verify,
      verifyState: async (state) => (await api.verifyState(kind, provider, state)).valid,
      exchange: (code, state) => api.exchange(kind, provider, code, state),
    }).then(setOutcome);
  }, [kind, provider, tab]);

  return (
    <section className="card wide">
      <h2>Finishing connection</h2>
      {!outcome && <p className="muted">Verifying state with the server…</p>}
      {outcome?.status === 'success' && (
        <p>
          <span className="badge ok">Connected</span> {outcome.provider}.{' '}
          {outcome.provider === 'facebook-lead-ads' ? <a href="/demo/meta-pages">See your pages →</a> : <a href="/">Back to integrations</a>}
        </p>
      )}
      {outcome?.status === 'denied' && <p className="error">You declined access ({outcome.error}). Nothing was connected.</p>}
      {outcome?.status === 'invalid' && (
        <p className="error">
          Refused: {outcome.reason}. The code was not sent to the server. <a href="/">Start again</a>
        </p>
      )}
      {outcome?.status === 'failed' && <p className="error">Connection failed: {outcome.reason}</p>}
    </section>
  );
}
