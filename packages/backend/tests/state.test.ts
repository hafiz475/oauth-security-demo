import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newState, verifyState } from '../src/state.js';
import { createHarness, tamper, type Harness } from './helpers.js';

describe('state', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('fresh: every state is a new random UUID and verifies against itself', () => {
    const states = new Set(Array.from({ length: 500 }, newState));
    expect(states.size).toBe(500);
    for (const s of states) expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const s = newState();
    expect(verifyState(s, s)).toBe(true);
  });

  it('reuse-after-verify: a state is accepted once, then never again', () => {
    const provider = h.ctx.providers.get('zoom')!;
    const identity = { sessionId: 'session-reuse', businessUid: 'biz-alpha', memberId: 'member-1' };
    const { state } = h.ctx.flows.start({ provider, identity, redirectUri: 'http://localhost:5173/cb' });
    expect(h.ctx.flows.claim(identity, ['zoom'], state)).toBeDefined();
    expect(h.ctx.flows.claim(identity, ['zoom'], state)).toBeUndefined();
  });

  it('tampered: one changed character, or any other same-length value, is rejected', () => {
    const s = newState();
    expect(verifyState(s, tamper(s))).toBe(false);
    expect(verifyState(s, s.slice(0, -1) + (s.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(verifyState(s, newState())).toBe(false);
  });

  it('missing: null, undefined, empty, short, oversize and non-string values are rejected before comparing', () => {
    const s = newState();
    for (const bad of [null, undefined, '', 'short', 'x'.repeat(257), 42, {}, [s]]) {
      expect(verifyState(s, bad)).toBe(false);
      expect(verifyState(bad, s)).toBe(false);
    }
    expect(verifyState(null, null)).toBe(false);
    expect(verifyState(undefined, undefined)).toBe(false);
  });
});
