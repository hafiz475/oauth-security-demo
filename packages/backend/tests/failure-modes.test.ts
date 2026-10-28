import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoConfigError } from '../src/crypto.js';
import { FLOW_TTL_MS } from '../src/oauth-flow.js';
import { authorize, completionMessage, createHarness, pathOf, runPopupFlow, runSpaFlow, startPopup, type Harness } from './helpers.js';

/**
 * The twelve failure modes from docs/threat-model.md. FM-05 (authorization code
 * replay) lives in callback-page-flow; FM-07 and FM-11 are browser-side and
 * live in the frontend suite under the same group name.
 */
describe('failure-modes', () => {
  let h: Harness;
  let alpha: string;
  beforeAll(async () => {
    h = await createHarness();
    alpha = await h.login('biz-alpha', 'member-1');
  });
  afterAll(() => h.close());

  const refusedPage = (res: { statusCode: number; body: string }) => res.statusCode === 400 && completionMessage(res.body) === null;

  it('FM-01 callback without state: refused, and no completion message is sent', async () => {
    const { authUrl } = await startPopup(h, alpha, 'hubspot');
    const back = await authorize(h, authUrl);
    back.searchParams.delete('state');
    expect(refusedPage(await h.call('GET', pathOf(back), { cookie: alpha }))).toBe(true);
  });

  it("FM-02 login CSRF: a victim's browser replaying the attacker's callback URL is refused", async () => {
    const attacker = await h.login('biz-attacker', 'mallory');
    const victim = await h.login('biz-victim', 'alice');
    const { authUrl } = await startPopup(h, attacker, 'google-sheets');
    const attackerCallback = await authorize(h, authUrl);

    expect(refusedPage(await h.call('GET', pathOf(attackerCallback), { cookie: victim }))).toBe(true);
    expect((await h.call('GET', '/connections', { cookie: victim })).json()).toEqual({ connections: [] });
  });

  it('FM-03 state replay: a completed callback cannot be replayed', async () => {
    const { back, completion } = await runPopupFlow(h, alpha, 'zoom');
    expect(completion?.message.status).toBe('success');
    expect(refusedPage(await h.call('GET', pathOf(back), { cookie: alpha }))).toBe(true);
  });

  it('FM-04 expired state: a callback after the 10-minute flow TTL is refused', async () => {
    const { authUrl } = await startPopup(h, alpha, 'zoho-crm');
    const back = await authorize(h, authUrl);
    h.clock.advance(FLOW_TTL_MS);
    expect(refusedPage(await h.call('GET', pathOf(back), { cookie: alpha }))).toBe(true);
  });

  it('FM-06 unissued payloadId: completion pages and lookups do not exist for ids this session was not given', async () => {
    const forged = randomUUID();
    const page = await h.call('GET', `/integration/connected/${forged}`, { cookie: alpha });
    expect(page.statusCode).toBe(404);
    expect(completionMessage(page.body)).toBeNull();
    expect((await h.call('GET', `/google-oauth2/${forged}/getByPayload`, { cookie: alpha })).statusCode).toBe(404);
    expect((await h.call('GET', `/oauth/popup/zoom?payloadId=${forged}`, { cookie: alpha })).statusCode).toBe(404);

    // A real payloadId from another business is just as unknown.
    const other = await h.login('biz-other', 'member-1');
    const { completion } = await runPopupFlow(h, other, 'razorpay');
    expect((await h.call('GET', `/google-oauth2/${completion!.message.payloadId}/getByPayload`, { cookie: alpha })).statusCode).toBe(404);
  });

  it('FM-08 credentials on the query string: refused, and nothing is stored', async () => {
    const count = () => Number(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM pending_connections').get()!.n);
    const before = count();
    const viaQuery = await h.call('POST', '/integration/pending?apiKey=demo-key-in-url-0001', {
      cookie: alpha,
      body: { app: 'generic-api-key', connectionName: 'x', credentials: { apiKey: 'demo-key-in-url-0001' } },
    });
    expect(viaQuery.statusCode).toBe(400);
    expect(viaQuery.json()).toEqual({ error: 'query_parameters_not_allowed' });

    // Wrong shape is refused too, and the error names the field, not the value.
    const badShape = await h.call('POST', '/integration/pending', {
      cookie: alpha,
      body: { app: 'smtp-relay', connectionName: 'x', credentials: { host: 'mail.example', password: 'leaky-password' } },
    });
    expect(badShape.statusCode).toBe(400);
    expect(badShape.body).not.toContain('leaky-password');
    expect(count()).toBe(before);
  });

  it('FM-09 tampered ciphertext: GCM authentication fails closed and leaks no plaintext', async () => {
    const { exchange } = await runSpaFlow(h, alpha, 'redirect', 'facebook-lead-ads');
    expect(exchange.statusCode).toBe(200);
    const [page] = h.ctx.vault.listPages('biz-alpha');
    const token = h.ctx.vault.getPageToken('biz-alpha', page!.pageId);

    const row = h.ctx.db.prepare('SELECT token_cipher FROM meta_page_tokens WHERE page_id = ?').get(page!.pageId)!;
    const bytes = Buffer.from(String(row.token_cipher), 'base64');
    bytes[bytes.length - 1]! ^= 0x01;
    h.ctx.db.prepare('UPDATE meta_page_tokens SET token_cipher = ? WHERE page_id = ?').run(bytes.toString('base64'), page!.pageId);

    const res = await h.call('GET', `/meta/pages/${page!.pageId}/forms`, { cookie: alpha });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain(token);
  });

  it('FM-10 missing or malformed DEMO_AES_KEY: the server refuses to boot', async () => {
    const saved = process.env.DEMO_AES_KEY;
    try {
      delete process.env.DEMO_AES_KEY;
      await expect(createHarness()).rejects.toThrow(CryptoConfigError);
      process.env.DEMO_AES_KEY = 'not-hex-and-too-short';
      await expect(createHarness()).rejects.toThrow(/DEMO_AES_KEY must be 32 bytes/);
    } finally {
      process.env.DEMO_AES_KEY = saved;
    }
  });

  it('FM-12 unknown provider or wrong pattern: every entry point answers 404', async () => {
    const attempts = [
      h.call('POST', '/oauth/popup/not-a-provider/start', { cookie: alpha, body: {} }),
      h.call('POST', '/oauth/popup/instagram/start', { cookie: alpha, body: {} }),
      h.call('POST', '/oauth/redirect/google-sheets/start', { cookie: alpha, body: {} }),
      h.call('POST', '/oauth/callback/facebook-lead-ads/start', { cookie: alpha, body: {} }),
      h.call('POST', '/oauth/embedded/zoom/config', { cookie: alpha, body: {} }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown_provider' });
    }
  });
});
