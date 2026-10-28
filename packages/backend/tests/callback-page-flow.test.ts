// @vitest-environment jsdom
// Pattern 4: the Instagram callback page logic against the real backend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { takeCallbackParams } from '../../frontend/src/lib/callbackParams';
import { handleOAuthCallback, type CallbackDeps } from '../../frontend/src/lib/handleCallback';
import { createStateKeeper } from '../../frontend/src/lib/oauthState';
import { authorize, createHarness, startSpa, tamper, type Harness } from './helpers.js';

const PROVIDER = 'instagram';
const land = (url: URL) => window.history.replaceState(null, '', url.pathname + url.search);

describe('callback-page-flow', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  function page(cookie: string) {
    const calls = { verifyState: 0, exchange: 0 };
    const deps: CallbackDeps = {
      verifyClientNonce: createStateKeeper(window.sessionStorage).verify,
      async verifyState(state) {
        calls.verifyState++;
        return (await h.call('POST', `/oauth/callback/${PROVIDER}/verify-state`, { cookie, body: { state } })).json().valid;
      },
      async exchange(code, state) {
        calls.exchange++;
        const res = await h.call('POST', `/oauth/callback/${PROVIDER}/exchange`, { cookie, body: { code, state } });
        if (res.statusCode !== 200) throw new Error(res.json().error);
        return res.json();
      },
    };
    return { calls, deps };
  }

  async function begin(cookie: string, decision: 'allow' | 'deny' = 'allow') {
    const { authUrl } = await startSpa(h, cookie, 'callback', PROVIDER, createStateKeeper(window.sessionStorage).start());
    return authorize(h, authUrl, decision);
  }

  it('Instagram happy: lands on /oauth/callback/instagram, verifies, exchanges, connects', async () => {
    const cookie = await h.login('biz-ig', 'member-1');
    const back = await begin(cookie);
    expect(back.pathname).toBe('/oauth/callback/instagram');
    land(back);
    const outcome = await handleOAuthCallback(takeCallbackParams(window), page(cookie).deps);
    expect(outcome).toMatchObject({ status: 'success', provider: PROVIDER });
    const { connections } = (await h.call('GET', '/connections', { cookie })).json();
    expect(connections.map((c: { provider: string }) => c.provider)).toEqual([PROVIDER]);
  });

  it('denied: an access_denied return is surfaced and nothing is sent to the backend', async () => {
    const cookie = await h.login('biz-ig-deny', 'member-1');
    const back = await begin(cookie, 'deny');
    expect(back.searchParams.get('error')).toBe('access_denied');
    land(back);
    const { calls, deps } = page(cookie);
    expect(await handleOAuthCallback(takeCallbackParams(window), deps)).toEqual({ status: 'denied', error: 'access_denied' });
    expect(calls).toEqual({ verifyState: 0, exchange: 0 });
    expect((await h.call('GET', '/connections', { cookie })).json()).toEqual({ connections: [] });
  });

  it('tampered state: refused by the server check, code never posted, code still unspent', async () => {
    const cookie = await h.login('biz-ig', 'member-2');
    const back = await begin(cookie);
    const [code, state] = [back.searchParams.get('code')!, back.searchParams.get('state')!];
    back.searchParams.set('state', tamper(state));
    land(back);
    const { calls, deps } = page(cookie);
    expect(await handleOAuthCallback(takeCallbackParams(window), deps)).toEqual({ status: 'invalid', reason: 'state_mismatch' });
    expect(calls).toEqual({ verifyState: 1, exchange: 0 });
    expect((await h.call('POST', `/oauth/callback/${PROVIDER}/exchange`, { cookie, body: { code, state } })).statusCode).toBe(200);
  });

  it('missing code: a callback with a state but no code is refused without any network call', async () => {
    const cookie = await h.login('biz-ig', 'member-3');
    const back = await begin(cookie);
    back.searchParams.delete('code');
    land(back);
    const { calls, deps } = page(cookie);
    expect(await handleOAuthCallback(takeCallbackParams(window), deps)).toEqual({ status: 'invalid', reason: 'missing_code' });
    expect(calls).toEqual({ verifyState: 0, exchange: 0 });
  });

  it('duplicate code exchange refused: same code+state twice, and the same code under a fresh state', async () => {
    const cookie = await h.login('biz-ig', 'member-4');
    const back = await begin(cookie);
    const [code, state] = [back.searchParams.get('code')!, back.searchParams.get('state')!];
    const exchange = (c: string, s: string) => h.call('POST', `/oauth/callback/${PROVIDER}/exchange`, { cookie, body: { code: c, state: s } });

    expect((await exchange(code, state)).statusCode).toBe(200);
    const again = await exchange(code, state);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: 'invalid_state' });

    // Valid new state, old code: the IdP refuses the second redemption.
    const fresh = await begin(cookie);
    const reused = await exchange(code, fresh.searchParams.get('state')!);
    expect(reused.statusCode).toBe(502);
    expect(reused.json()).toEqual({ error: 'token_exchange_failed' });
  });
});
