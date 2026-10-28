import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';

export const APP_ORIGIN = 'http://localhost:5173';
export const SENSITIVE_PARAM = /token|secret|password|passwd|api[_-]?key|authorization|credentials/i;

type Method = 'GET' | 'POST';

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  clock: { now: number; advance(ms: number): void };
  login(businessUid?: string, memberId?: string): Promise<string>;
  call(method: Method, url: string, opts?: { cookie?: string; body?: unknown }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** A fetch() that is served by app.inject, so nothing listens on a port. */
export function injectFetch(
  getApp: () => FastifyInstance,
  opts: { cookie?: () => string | undefined; onResponse?: (path: string, status: number, body: string) => void } = {},
): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, APP_ORIGIN);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const cookie = opts.cookie?.();
    if (cookie && !headers.cookie) headers.cookie = cookie;
    const res = await getApp().inject({
      method: (init?.method ?? 'GET') as Method,
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    opts.onResponse?.(url.pathname + url.search, res.statusCode, res.body);
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [String(v)]) out.append(k, one);
    }
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: out });
  };
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  let app!: FastifyInstance;
  const cfg = loadConfig(
    { LOG_LEVEL: process.env.LOG_LEVEL, APP_ORIGIN, ...env },
    { dbPath: ':memory:', now: () => clock.now, fetch: injectFetch(() => app) },
  );
  app = await buildServer(cfg);
  await app.ready();

  const call: Harness['call'] = (method, url, opts = {}) =>
    app.inject({
      method,
      url,
      headers: opts.cookie ? { cookie: opts.cookie } : {},
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });

  return {
    app,
    ctx: app.demo,
    clock,
    call,
    async login(businessUid = 'biz-alpha', memberId = 'member-1') {
      const res = await call('POST', '/session/demo', { body: { businessUid, memberId } });
      const raw = res.headers['set-cookie'];
      return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
    },
    close: () => app.close(),
  };
}

// ---------------------------------------------------------------------------
// Flow drivers. Each records every URL the browser would see and every body
// the browser would receive, so tests can assert nothing secret is in them.
// ---------------------------------------------------------------------------

export interface Transcript {
  urls: string[];
  bodies: string[];
}
export const newTranscript = (): Transcript => ({ urls: [], bodies: [] });

export const pathOf = (u: string | URL) => {
  const url = new URL(u, APP_ORIGIN);
  return url.pathname + url.search;
};

export const clientNonce = () => randomBytes(18).toString('base64url');

/** Flip one character so the value keeps its length and shape. */
export const tamper = (s: string) => (s[0] === 'a' ? 'b' : 'a') + s.slice(1);

export function completionMessage(html: string): { targetOrigin: string; message: { status: string; payloadId: string; error?: string } } | null {
  const m = /<script type="application\/json" id="oauth-result" data-target-origin="([^"]*)">([\s\S]*?)<\/script>/.exec(html);
  return m ? { targetOrigin: m[1]!, message: JSON.parse(m[2]!) } : null;
}

/** Plays the user's click on the mock consent page; returns where the IdP redirects. */
export async function authorize(h: Harness, authUrl: string, decision: 'allow' | 'deny' = 'allow', t?: Transcript): Promise<URL> {
  const consent = new URL(authUrl);
  consent.searchParams.set('decision', decision);
  const res = await h.call('GET', pathOf(consent));
  expect(res.statusCode).toBe(302);
  const location = String(res.headers.location);
  t?.urls.push(authUrl, consent.toString(), location);
  return new URL(location);
}

export async function startPopup(h: Harness, cookie: string, providerId: string, t?: Transcript) {
  const start = await h.call('POST', `/oauth/popup/${providerId}/start`, { cookie, body: {} });
  expect(start.statusCode).toBe(200);
  const { payloadId, launchUrl } = start.json() as { payloadId: string; launchUrl: string };
  const launch = await h.call('GET', pathOf(launchUrl), { cookie });
  expect(launch.statusCode).toBe(302);
  const authUrl = String(launch.headers.location);
  t?.bodies.push(start.body);
  t?.urls.push(launchUrl);
  return { payloadId, authUrl };
}

export async function runPopupFlow(h: Harness, cookie: string, providerId: string, t = newTranscript()) {
  const { payloadId, authUrl } = await startPopup(h, cookie, providerId, t);
  const back = await authorize(h, authUrl, 'allow', t);
  const callback = await h.call('GET', pathOf(back), { cookie });
  t.bodies.push(callback.body);
  return { payloadId, back, callback, completion: completionMessage(callback.body) };
}

export type SpaKind = 'redirect' | 'callback';
export const spaPath = (kind: SpaKind, providerId: string, action: 'verify-state' | 'exchange') =>
  kind === 'redirect' ? `/oauth/redirect/${action}` : `/oauth/callback/${providerId}/${action}`;

export async function startSpa(h: Harness, cookie: string, kind: SpaKind, providerId: string, nonce = clientNonce(), t?: Transcript) {
  const res = await h.call('POST', `/oauth/${kind}/${providerId}/start`, { cookie, body: { clientNonce: nonce } });
  expect(res.statusCode).toBe(200);
  t?.bodies.push(res.body);
  return res.json() as { payloadId: string; authUrl: string };
}

export async function runSpaFlow(h: Harness, cookie: string, kind: SpaKind, providerId: string, t = newTranscript()) {
  const { payloadId, authUrl } = await startSpa(h, cookie, kind, providerId, clientNonce(), t);
  const back = await authorize(h, authUrl, 'allow', t);
  const code = back.searchParams.get('code')!;
  const state = back.searchParams.get('state')!;
  const verify = await h.call('POST', spaPath(kind, providerId, 'verify-state'), { cookie, body: { state } });
  expect(verify.json()).toEqual({ valid: true });
  const exchange = await h.call('POST', spaPath(kind, providerId, 'exchange'), { cookie, body: { code, state } });
  t.bodies.push(verify.body, exchange.body);
  return { payloadId, code, state, exchange };
}

export async function embeddedMessages(h: Harness, clientId: string, event: 'FINISH' | 'CANCEL' | 'ERROR') {
  const res = await h.call('POST', '/mock-oauth/postmessage', { body: { client_id: clientId, event } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { messages: Array<Record<string, any>> }).messages;
}

export async function runEmbeddedFlow(h: Harness, cookie: string, providerId: string, t = newTranscript()) {
  const configRes = await h.call('POST', `/oauth/embedded/${providerId}/config`, { cookie, body: {} });
  expect(configRes.statusCode).toBe(200);
  const cfg = configRes.json() as { payloadId: string; state: string; appId: string; signupUrl: string };
  t.urls.push(cfg.signupUrl);
  t.bodies.push(configRes.body);
  const messages = await embeddedMessages(h, cfg.appId, 'FINISH');
  const session = messages.find((m) => m.type === 'WA_EMBEDDED_SIGNUP')!.data;
  const code = messages.find((m) => m.type === 'FB_LOGIN_RESPONSE')!.authResponse.code as string;
  const complete = await h.call('POST', `/oauth/embedded/${providerId}/complete`, {
    cookie,
    body: { state: cfg.state, code, wabaId: session.waba_id, phoneNumberId: session.phone_number_id },
  });
  t.bodies.push(complete.body);
  return { payloadId: cfg.payloadId, cfg, complete };
}

/** Runs the right flow for a provider and returns the payloadId it completed. */
export async function runProviderFlow(h: Harness, cookie: string, providerId: string, t = newTranscript()): Promise<string> {
  const pattern = h.ctx.providers.get(providerId)!.pattern;
  if (pattern === 'popup') {
    const { completion } = await runPopupFlow(h, cookie, providerId, t);
    expect(completion?.message).toMatchObject({ status: 'success' });
    expect(completion?.targetOrigin).toBe(APP_ORIGIN);
    return completion!.message.payloadId;
  }
  if (pattern === 'embedded') {
    const { complete } = await runEmbeddedFlow(h, cookie, providerId, t);
    expect(complete.statusCode).toBe(200);
    return (complete.json() as { payloadId: string }).payloadId;
  }
  const { exchange } = await runSpaFlow(h, cookie, pattern, providerId, t);
  expect(exchange.statusCode).toBe(200);
  return (exchange.json() as { payloadId: string }).payloadId;
}

/** Starts a fresh flow, returns it with one character of the state flipped, and reports whether it was refused. */
export async function tamperedStateRefused(h: Harness, cookie: string, providerId: string): Promise<boolean> {
  const pattern = h.ctx.providers.get(providerId)!.pattern;
  if (pattern === 'popup') {
    const { authUrl } = await startPopup(h, cookie, providerId);
    const back = await authorize(h, authUrl);
    back.searchParams.set('state', tamper(back.searchParams.get('state')!));
    const res = await h.call('GET', pathOf(back), { cookie });
    return res.statusCode === 400 && completionMessage(res.body) === null;
  }
  if (pattern === 'embedded') {
    const cfgRes = await h.call('POST', `/oauth/embedded/${providerId}/config`, { cookie, body: {} });
    const cfg = cfgRes.json() as { state: string; appId: string };
    const messages = await embeddedMessages(h, cfg.appId, 'FINISH');
    const session = messages.find((m) => m.type === 'WA_EMBEDDED_SIGNUP')!.data;
    const code = messages.find((m) => m.type === 'FB_LOGIN_RESPONSE')!.authResponse.code as string;
    const res = await h.call('POST', `/oauth/embedded/${providerId}/complete`, {
      cookie,
      body: { state: tamper(cfg.state), code, wabaId: session.waba_id, phoneNumberId: session.phone_number_id },
    });
    return res.statusCode === 400;
  }
  const { authUrl } = await startSpa(h, cookie, pattern, providerId);
  const back = await authorize(h, authUrl);
  const res = await h.call('POST', spaPath(pattern, providerId, 'exchange'), {
    cookie,
    body: { code: back.searchParams.get('code'), state: tamper(back.searchParams.get('state')!) },
  });
  return res.statusCode === 400;
}
