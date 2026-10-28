import { describe, expect, it } from 'vitest';
import { UnsafeUrlParamError, buildOAuthUrl } from '../src/lib/buildOAuthUrl';

// Shares the "failure-modes" group with packages/backend/tests/failure-modes.test.ts.
describe('failure-modes', () => {
  it('FM-07 credential placed in a URL: buildOAuthUrl throws for every credential-shaped key', () => {
    const refused = [
      'access_token',
      'refresh_token',
      'id_token',
      'page_token',
      'client_secret',
      'password',
      'api_key',
      'api-key',
      'apiKey',
      'x-api-key',
      'authorization',
      'credentials',
      'Token',
    ];
    for (const key of refused) {
      expect(() => buildOAuthUrl('https://idp.example/authorize', { [key]: 'value' }), key).toThrow(UnsafeUrlParamError);
    }

    // What OAuth legitimately carries in URLs still works, through URLSearchParams.
    const url = buildOAuthUrl('/oauth/popup/zoom?existing=1', {
      payloadId: 'p-1',
      state: 's-1',
      code_challenge: 'c-1',
      scope: 'a b',
      prompt: true,
      max_age: 0,
    });
    expect(url.origin).toBe(window.location.origin);
    expect(url.search).toBe('?existing=1&payloadId=p-1&state=s-1&code_challenge=c-1&scope=a+b&prompt=true&max_age=0');

    // An empty value under a sensitive key carries no secret, so it is allowed.
    expect(buildOAuthUrl('https://idp.example/x', { access_token: '' }).searchParams.get('access_token')).toBe('');
  });
});
