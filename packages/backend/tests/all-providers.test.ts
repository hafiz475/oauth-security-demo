import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER_DEFS } from '../src/provider-registry.js';
import { APP_ORIGIN, SENSITIVE_PARAM, createHarness, newTranscript, runProviderFlow, tamperedStateRefused, type Harness } from './helpers.js';

describe('all-providers', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  // Guard against the loop silently shrinking.
  expect(PROVIDER_DEFS.map((p) => p.id)).toHaveLength(13);

  for (const def of PROVIDER_DEFS) {
    it(`${def.id} [${def.pattern}]: state verified on return (M1), no credential in any URL (M3)`, async () => {
      const cookie = await h.login('biz-all', `member-${def.id}`);
      const t = newTranscript();

      const payloadId = await runProviderFlow(h, cookie, def.id, t);
      const lookup = await h.call('GET', `/google-oauth2/${payloadId}/getByPayload`, { cookie });
      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toMatchObject({ payloadId, provider: def.id });
      t.bodies.push(lookup.body);

      // M1: the same flow with one character of the state changed is refused.
      expect(await tamperedStateRefused(h, cookie, def.id)).toBe(true);

      // M3: no URL the browser saw carries a credential-shaped parameter.
      expect(t.urls.length).toBeGreaterThan(0);
      for (const url of t.urls) {
        for (const key of new URL(url, APP_ORIGIN).searchParams.keys()) expect(key).not.toMatch(SENSITIVE_PARAM);
      }

      // M2/M3: the tokens the IdP actually issued appear in no URL and no browser-visible body.
      const secret = h.ctx.connections.readSecret<{ accessToken: string; refreshToken: string }>(payloadId);
      expect(secret.accessToken).toMatch(/^mock_at_/);
      for (const value of [secret.accessToken, secret.refreshToken]) {
        for (const seen of [...t.urls, ...t.bodies]) expect(seen).not.toContain(value);
      }
    });
  }
});
