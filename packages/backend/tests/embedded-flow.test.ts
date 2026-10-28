// @vitest-environment jsdom
// The browser-side Embedded Signup listener against the real backend and mock IdP.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listenForEmbeddedSignup, type EmbeddedOutcome } from '../../frontend/src/lib/embeddedSignup';
import { APP_ORIGIN, createHarness, embeddedMessages, type Harness } from './helpers.js';

const PROVIDER = 'whatsapp-embedded-signup';

const post = (data: unknown, origin: string, target: EventTarget = window) =>
  target.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin }));

const settledWithin = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

/** Same check while setTimeout is faked: flush microtasks only. */
const settledWithinFakeTime = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe('embedded-flow', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  afterEach(() => vi.useRealTimers());

  async function config(cookie: string) {
    const res = await h.call('POST', `/oauth/embedded/${PROVIDER}/config`, { cookie, body: {} });
    expect(res.statusCode).toBe(200);
    return res.json() as { payloadId: string; state: string; appId: string; allowedOrigins: string[]; signupUrl: string };
  }

  it('code+postMessage: allow-listed events plus the login code complete the connection', async () => {
    const cookie = await h.login('biz-wa', 'member-1');
    const cfg = await config(cookie);
    const sdkOrigin = new URL(cfg.signupUrl).origin;
    expect(cfg.allowedOrigins).toContain(sdkOrigin);

    const listener = listenForEmbeddedSignup({ allowedOrigins: cfg.allowedOrigins });
    for (const m of await embeddedMessages(h, cfg.appId, 'FINISH')) post(m, sdkOrigin);
    const outcome = await listener.result;
    expect(outcome.status).toBe('finished');
    const { code, wabaId, phoneNumberId } = outcome as Extract<EmbeddedOutcome, { status: 'finished' }>;

    const complete = await h.call('POST', `/oauth/embedded/${PROVIDER}/complete`, {
      cookie,
      body: { state: cfg.state, code, wabaId, phoneNumberId },
    });
    expect(complete.statusCode).toBe(200);
    const connection = (await h.call('GET', `/google-oauth2/${cfg.payloadId}/getByPayload`, { cookie })).json();
    expect(connection).toMatchObject({ provider: PROVIDER, details: { wabaId, phoneNumberId } });
  });

  it('origin-mismatch dropped: events from other origins are ignored and logged at WARN without content', async () => {
    const cookie = await h.login('biz-wa', 'member-2');
    const cfg = await config(cookie);
    const warn = vi.fn();
    const listener = listenForEmbeddedSignup({ allowedOrigins: cfg.allowedOrigins, warn });
    const messages = await embeddedMessages(h, cfg.appId, 'FINISH');

    for (const m of messages) post(m, 'https://evil.example');
    expect(await settledWithin(listener.result)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(messages.length);
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'https://evil.example');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(messages[0]!.data.waba_id);
    expect(logged).not.toContain(messages[1]!.authResponse.code);

    for (const m of messages) post(m, APP_ORIGIN);
    expect((await listener.result).status).toBe('finished');
  });

  it('cancel surfaced: a CANCEL event resolves with the step the user left at, and nothing is connected', async () => {
    const cookie = await h.login('biz-wa-cancel', 'member-1');
    const cfg = await config(cookie);
    const listener = listenForEmbeddedSignup({ allowedOrigins: cfg.allowedOrigins });
    for (const m of await embeddedMessages(h, cfg.appId, 'CANCEL')) post(m, APP_ORIGIN);
    expect(await listener.result).toEqual({ status: 'cancelled', step: 'PHONE_NUMBER_SETUP' });
    expect((await h.call('GET', '/connections', { cookie })).json()).toEqual({ connections: [] });
  });

  it('stuck-toast-never-possible: every path settles, including silence, and late events change nothing', async () => {
    const cookie = await h.login('biz-wa', 'member-3');
    const cfg = await config(cookie);
    const [errorMsgs, finishMsgs] = [await embeddedMessages(h, cfg.appId, 'ERROR'), await embeddedMessages(h, cfg.appId, 'FINISH')];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // One message channel per listener so each scenario is isolated.
    const [silentCh, failedCh, halfCh] = [new EventTarget(), new EventTarget(), new EventTarget()];
    const opts = { allowedOrigins: cfg.allowedOrigins, timeoutMs: 60_000, warn: () => {} };
    const silent = listenForEmbeddedSignup({ ...opts, target: silentCh });
    const failed = listenForEmbeddedSignup({ ...opts, target: failedCh });
    const halfDone = listenForEmbeddedSignup({ ...opts, target: halfCh });

    // `silent` hears nothing; `failed` gets an ERROR; `halfDone` gets the session event but never a code.
    for (const m of errorMsgs) post(m, APP_ORIGIN, failedCh);
    expect(await failed.result).toEqual({ status: 'error', reason: 'signup_error' });
    post(finishMsgs[0], APP_ORIGIN, halfCh);
    expect(await settledWithinFakeTime(halfDone.result)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(await silent.result).toEqual({ status: 'error', reason: 'timeout' });
    expect(await halfDone.result).toEqual({ status: 'error', reason: 'timeout' });

    for (const m of finishMsgs) post(m, APP_ORIGIN, silentCh);
    expect(await silent.result).toEqual({ status: 'error', reason: 'timeout' });
  });
});
