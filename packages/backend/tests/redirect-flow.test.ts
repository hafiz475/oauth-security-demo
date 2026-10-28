// @vitest-environment jsdom
// Drives the real SPA callback logic (frontend/src/lib) against the real backend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { takeCallbackParams } from '../../frontend/src/lib/callbackParams';
import { handleOAuthCallback, type CallbackDeps } from '../../frontend/src/lib/handleCallback';
import { createStateKeeper } from '../../frontend/src/lib/oauthState';
import { authorize, createHarness, startSpa, tamper, type Harness } from './helpers.js';

const META_PROVIDERS = ['facebook-lead-ads', 'meta-capi', 'meta-catalogue'];

/** Simulates the browser landing on the URL the IdP redirected to. */
const land = (url: URL) => window.history.replaceState(null, '', url.pathname + url.search);

describe('redirect-flow', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  function spa(cookie: string) {
    const calls = { verifyState: 0, exchange: 0 };
    const deps: CallbackDeps = {
      verifyClientNonce: createStateKeeper(window.sessionStorage).verify,
      async verifyState(state) {
        calls.verifyState++;
        return (await h.call('POST', '/oauth/redirect/verify-state', { cookie, body: { state } })).json().valid;
      },
      async exchange(code, state) {
        calls.exchange++;
        const res = await h.call('POST', '/oauth/redirect/exchange', { cookie, body: { code, state } });
        if (res.statusCode !== 200) throw new Error(res.json().error);
        return res.json();
      },
    };
    return { calls, deps };
  }

  async function begin(cookie: string, providerId: string) {
    const nonce = createStateKeeper(window.sessionStorage).start();
    const { authUrl } = await startSpa(h, cookie, 'redirect', providerId, nonce);
    const back = await authorize(h, authUrl);
    return { authUrl, back };
  }

  it.each(META_PROVIDERS)('%s: happy path through the shared Meta handler, with its own scopes', async (providerId) => {
    const cookie = await h.login('biz-meta', `member-${providerId}`);
    const { authUrl, back } = await begin(cookie, providerId);
    const scopes = h.ctx.providers.get(providerId)!.scopes;
    expect(new URL(authUrl).searchParams.get('scope')).toBe(scopes.join(' '));
    expect(back.pathname).toBe('/oauth/meta/callback');

    land(back);
    const outcome = await handleOAuthCallback(takeCallbackParams(window), spa(cookie).deps);
    expect(outcome).toMatchObject({ status: 'success', provider: providerId });

    const payloadId = (outcome as { payloadId: string }).payloadId;
    const connection = (await h.call('GET', `/google-oauth2/${payloadId}/getByPayload`, { cookie })).json();
    expect(connection).toMatchObject({ provider: providerId, details: { scopes } });
  });

  it('code-stripped-on-refresh: the code leaves the address bar before exchange; a refresh or replay gets nothing', async () => {
    const cookie = await h.login('biz-meta', 'member-refresh');
    const { back } = await begin(cookie, 'meta-capi');
    land(back);
    expect(window.location.search).toContain('code=');

    const { deps } = spa(cookie);
    const params = takeCallbackParams(window);
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/oauth/meta/callback');
    expect((await handleOAuthCallback(params, deps)).status).toBe('success');

    // "Refresh": the page reads the address bar again.
    const again = takeCallbackParams(window);
    expect(again).toEqual({ code: null, state: null, error: null });
    expect(await handleOAuthCallback(again, deps)).toEqual({ status: 'invalid', reason: 'missing_state' });

    // A captured copy of the code is useless too.
    const replay = await h.call('POST', '/oauth/redirect/exchange', { cookie, body: { code: params.code, state: params.state } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'invalid_state' });
  });

  it('state-tampered: the SPA refuses before sending the code, and the untouched code stays unspent', async () => {
    const cookie = await h.login('biz-meta', 'member-tamper');
    const { back } = await begin(cookie, 'facebook-lead-ads');
    const code = back.searchParams.get('code')!;
    const state = back.searchParams.get('state')!;

    back.searchParams.set('state', tamper(state));
    land(back);
    const { calls, deps } = spa(cookie);
    expect(await handleOAuthCallback(takeCallbackParams(window), deps)).toEqual({ status: 'invalid', reason: 'state_mismatch' });
    expect(calls).toEqual({ verifyState: 1, exchange: 0 });

    const genuine = await h.call('POST', '/oauth/redirect/exchange', { cookie, body: { code, state } });
    expect(genuine.statusCode).toBe(200);
  });
});
