import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptJson } from '../src/crypto.js';
import { PENDING_TTL_MS } from '../src/pending-connection.js';
import { completionMessage, createHarness, pathOf, type Harness } from './helpers.js';

const freshKey = () => `demo-key-${randomBytes(16).toString('hex')}`;

describe('pending-connection', () => {
  let h: Harness;
  let alpha: string;
  beforeAll(async () => {
    h = await createHarness();
    alpha = await h.login('biz-alpha', 'member-1');
  });
  afterAll(() => h.close());

  const createPending = async (cookie: string, apiKey = freshKey()) => {
    const res = await h.call('POST', '/integration/pending', {
      cookie,
      body: { app: 'generic-api-key', connectionName: 'Billing key', credentials: { apiKey } },
    });
    expect(res.statusCode).toBe(200);
    return { apiKey, res, body: res.json() as { pendingId: string; expiresAt: number; connectUrl: string } };
  };
  const connect = (cookie: string, pendingId: string) => h.call('GET', `/integration/connect?pendingId=${pendingId}`, { cookie });

  it('happy: body credentials -> handle -> connect -> completion page; credentials stored server-side', async () => {
    const { apiKey, body } = await createPending(alpha);
    const res = await h.call('GET', pathOf(body.connectUrl), { cookie: alpha });
    expect(res.statusCode).toBe(302);
    const final = await h.call('GET', pathOf(String(res.headers.location)), { cookie: alpha });
    const done = completionMessage(final.body);
    expect(done?.message.status).toBe('success');
    expect(h.ctx.connections.readSecret(done!.message.payloadId)).toEqual({ apiKey });
  });

  it('single-use: the second redemption of a handle gets 410 "expired or already used"', async () => {
    const { body } = await createPending(alpha);
    expect((await connect(alpha, body.pendingId)).statusCode).toBe(302);
    const second = await connect(alpha, body.pendingId);
    expect(second.statusCode).toBe(410);
    expect(second.body).toMatch(/expired or was already used/);
  });

  it('TTL: a handle is dead after five minutes', async () => {
    const { body } = await createPending(alpha);
    expect(body.expiresAt - h.clock.now).toBe(PENDING_TTL_MS);
    h.clock.advance(PENDING_TTL_MS);
    expect((await connect(alpha, body.pendingId)).statusCode).toBe(410);
  });

  it('cross-user: another member of the same business cannot redeem the handle', async () => {
    const { body } = await createPending(alpha);
    const colleague = await h.login('biz-alpha', 'member-2');
    expect((await connect(colleague, body.pendingId)).statusCode).toBe(410);
    expect((await connect(alpha, body.pendingId)).statusCode).toBe(302);
  });

  it('cross-business: a member of another business cannot redeem the handle', async () => {
    const { body } = await createPending(alpha);
    const outsider = await h.login('biz-beta', 'member-1');
    expect((await connect(outsider, body.pendingId)).statusCode).toBe(410);
    expect((await connect(alpha, body.pendingId)).statusCode).toBe(302);
  });

  it('response-body clean: the create response holds only the handle, expiry and a handle-only URL', async () => {
    const { apiKey, res, body } = await createPending(alpha);
    expect(Object.keys(body).sort()).toEqual(['connectUrl', 'expiresAt', 'pendingId']);
    expect(res.body).not.toContain(apiKey);
    expect([...new URL(body.connectUrl).searchParams.keys()]).toEqual(['pendingId']);
  });

  it('encrypted-at-rest: the stored row holds ciphertext only', async () => {
    const { apiKey, body } = await createPending(alpha);
    const row = h.ctx.db.prepare('SELECT * FROM pending_connections WHERE pending_id = ?').get(body.pendingId)!;
    expect(JSON.stringify(row)).not.toContain(apiKey);
    expect(decryptJson(String(row.credentials_cipher))).toEqual({ apiKey });
  });

  it('atomic-consume-race: five concurrent redemptions, exactly one wins', async () => {
    const { body } = await createPending(alpha);
    const results = await Promise.all(Array.from({ length: 5 }, () => connect(alpha, body.pendingId)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([302, 410, 410, 410, 410]);
    const row = h.ctx.db.prepare('SELECT consumed FROM pending_connections WHERE pending_id = ?').get(body.pendingId)!;
    expect(row.consumed).toBe(1);
  });

  it('credentials-encrypted-before-insert: the value handed to INSERT is already ciphertext', async () => {
    // A trigger records exactly what the INSERT statement received.
    h.ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS insert_audit (cipher TEXT);
      CREATE TRIGGER IF NOT EXISTS audit_pending BEFORE INSERT ON pending_connections
      BEGIN INSERT INTO insert_audit (cipher) VALUES (NEW.credentials_cipher); END;`);
    const { apiKey } = await createPending(alpha);
    const audited = h.ctx.db.prepare('SELECT cipher FROM insert_audit').all();
    expect(audited).toHaveLength(1);
    expect(String(audited[0]!.cipher)).not.toContain(apiKey);
    expect(decryptJson(String(audited[0]!.cipher))).toEqual({ apiKey });
    h.ctx.db.exec('DROP TRIGGER audit_pending; DROP TABLE insert_audit;');
  });
});
