import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt } from '../src/crypto.js';
import { createHarness, runSpaFlow, type Harness } from './helpers.js';

const randomToken = () => `page-token-${randomBytes(12).toString('hex')}`;

describe('page-token-vault', () => {
  let h: Harness;
  let alpha: string;
  let pageIds: string[];
  let pageTokens: string[];

  beforeAll(async () => {
    h = await createHarness();
    alpha = await h.login('biz-alpha', 'member-1');
    const { exchange } = await runSpaFlow(h, alpha, 'redirect', 'facebook-lead-ads');
    expect(exchange.statusCode).toBe(200);
    pageIds = h.ctx.vault.listPages('biz-alpha').map((p) => p.pageId);
    pageTokens = pageIds.map((id) => h.ctx.vault.getPageToken('biz-alpha', id));
  });
  afterAll(() => h.close());

  it('list no-token: GET /meta/pages returns pageId, name, category, tasks and nothing else', async () => {
    const res = await h.call('GET', '/meta/pages', { cookie: alpha });
    expect(res.statusCode).toBe(200);
    const { pages } = res.json() as { pages: Array<Record<string, unknown>> };
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(Object.keys(page).sort()).toEqual(['category', 'name', 'pageId', 'tasks']);
    for (const token of pageTokens) expect(res.body).not.toContain(token);
  });

  it('forms by page_id: the browser sends only an id; the backend resolves the token and the provider accepts it', async () => {
    const forms = await h.call('GET', `/meta/pages/${pageIds[0]}/forms`, { cookie: alpha });
    expect(forms.statusCode).toBe(200);
    const list = (forms.json() as { forms: Array<{ id: string; name: string }> }).forms;
    expect(list.map((f) => f.name)).toEqual(['Request a callback', 'Get a quote']);

    const fields = await h.call('GET', `/meta/pages/${pageIds[0]}/fields?formId=${list[0]!.id}`, { cookie: alpha });
    expect(fields.statusCode).toBe(200);
    expect((fields.json() as { fields: Array<{ key: string }> }).fields.map((f) => f.key)).toEqual(['full_name', 'email', 'phone_number']);
    for (const token of pageTokens) expect(forms.body + fields.body).not.toContain(token);
  });

  it("foreign page 404: another business cannot list or use this business's pages", async () => {
    const beta = await h.login('biz-beta', 'member-1');
    expect((await h.call('GET', '/meta/pages', { cookie: beta })).json()).toEqual({ pages: [] });
    const res = await h.call('GET', `/meta/pages/${pageIds[0]}/forms`, { cookie: beta });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'page_not_connected' });
  });

  it('encryption-at-rest: rows hold AES-GCM ciphertext with a fresh IV per write', () => {
    const rows = h.ctx.db.prepare('SELECT * FROM meta_page_tokens WHERE business_uid = ?').all('biz-alpha');
    for (const token of pageTokens) expect(JSON.stringify(rows)).not.toContain(token);
    const decrypted = rows.map((r) => decrypt(String(r.token_cipher)));
    expect(decrypted.sort()).toEqual([...pageTokens].sort());

    const token = randomToken();
    h.ctx.vault.upsertPageToken('biz-iv', { id: 'p-iv', name: 'IV check', access_token: token });
    const first = h.ctx.db.prepare("SELECT token_cipher FROM meta_page_tokens WHERE page_id = 'p-iv'").get()!.token_cipher;
    h.ctx.vault.upsertPageToken('biz-iv', { id: 'p-iv', name: 'IV check', access_token: token });
    const second = h.ctx.db.prepare("SELECT token_cipher FROM meta_page_tokens WHERE page_id = 'p-iv'").get()!.token_cipher;
    expect(first).not.toBe(second);
  });

  it('migration from plaintext: legacy rows are encrypted into the vault and the legacy table is dropped', () => {
    const legacy = [randomToken(), randomToken()];
    h.ctx.db.exec(`CREATE TABLE meta_pages_legacy (business_uid TEXT, page_id TEXT, name TEXT, category TEXT, access_token TEXT)`);
    const insert = h.ctx.db.prepare('INSERT INTO meta_pages_legacy VALUES (?, ?, ?, ?, ?)');
    insert.run('biz-legacy', 'legacy-1', 'Old page one', 'Shop', legacy[0]);
    insert.run('biz-legacy', 'legacy-2', 'Old page two', 'Shop', legacy[1]);

    expect(h.ctx.vault.migrateLegacyPlaintextTokens()).toBe(2);
    expect(h.ctx.vault.getPageToken('biz-legacy', 'legacy-1')).toBe(legacy[0]);
    expect(h.ctx.vault.getPageToken('biz-legacy', 'legacy-2')).toBe(legacy[1]);
    expect(h.ctx.db.prepare("SELECT name FROM sqlite_master WHERE name = 'meta_pages_legacy'").get()).toBeUndefined();
    const rows = h.ctx.db.prepare("SELECT * FROM meta_page_tokens WHERE business_uid = 'biz-legacy'").all();
    for (const token of legacy) expect(JSON.stringify(rows)).not.toContain(token);
    expect(h.ctx.vault.migrateLegacyPlaintextTokens()).toBe(0);
  });

  it('expired token -> 401: an expired page token is never used', async () => {
    h.ctx.vault.upsertPageToken('biz-alpha', { id: 'p-expired', name: 'Expired', access_token: randomToken(), expiresAt: h.clock.now - 1 });
    const res = await h.call('GET', '/meta/pages/p-expired/forms', { cookie: alpha });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'page_token_expired' });
  });

  it('upsert collision on page_id: one row per (business, page); re-connecting replaces the token', () => {
    const [oldToken, newToken, otherToken] = [randomToken(), randomToken(), randomToken()];
    h.ctx.vault.upsertPageToken('biz-upsert', { id: 'p-same', name: 'Before', access_token: oldToken });
    h.ctx.vault.upsertPageToken('biz-upsert', { id: 'p-same', name: 'After', access_token: newToken });
    h.ctx.vault.upsertPageToken('biz-other', { id: 'p-same', name: 'Other business', access_token: otherToken });

    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM meta_page_tokens WHERE page_id = 'p-same'").get()!.n).toBe(2);
    expect(h.ctx.vault.getPageToken('biz-upsert', 'p-same')).toBe(newToken);
    expect(h.ctx.vault.listPages('biz-upsert')).toEqual([{ pageId: 'p-same', name: 'After', category: null, tasks: [] }]);
    expect(h.ctx.vault.getPageToken('biz-other', 'p-same')).toBe(otherToken);
  });
});
