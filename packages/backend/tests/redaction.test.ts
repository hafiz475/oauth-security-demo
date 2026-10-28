import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, redactObject, requestPath } from '../src/redacting-logger.js';

describe('redaction', () => {
  it('token: access/refresh/page tokens and bearer headers are replaced', () => {
    const out = redactObject({
      access_token: 'at-1',
      refreshToken: 'rt-1',
      page_token: 'pt-1',
      authorization: 'Bearer at-1',
      provider: 'zoom',
    });
    expect(out).toEqual({
      access_token: REDACTED,
      refreshToken: REDACTED,
      page_token: REDACTED,
      authorization: REDACTED,
      provider: 'zoom',
    });
  });

  it('secret: client secrets, signing secrets, OAuth codes and states are replaced', () => {
    const out = redactObject({ client_secret: 's', signingSecret: 's', code: 'c', state: 'st', payloadId: 'p-1' });
    expect(out).toEqual({ client_secret: REDACTED, signingSecret: REDACTED, code: REDACTED, state: REDACTED, payloadId: 'p-1' });
  });

  it('password: values are redacted in emitted log lines, and request logs carry the path only', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (_level, line) => lines.push(line));
    log.info('smtp.connect', { host: 'mail.example', password: 'hunter2', passwd: 'hunter3' });
    log.info('request', { path: requestPath('/oauth/popup/zoom/callback?code=abc123&state=xyz789') });

    const joined = lines.join('\n');
    expect(joined).not.toMatch(/hunter2|hunter3|abc123|xyz789/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'smtp.connect', host: 'mail.example', password: REDACTED, passwd: REDACTED });
    expect(JSON.parse(lines[1]!).path).toBe('/oauth/popup/zoom/callback');
  });

  it('nested api_key: keys are matched at any depth, inside arrays, in every spelling', () => {
    const out = redactObject({
      connections: [
        { app: 'crm', config: { api_key: 'k1', 'api-key': 'k2', apiKey: 'k3', credentials: { user: 'u' } } },
        { app: 'mail', nested: { deeper: { API_KEY: 'k4' } } },
      ],
    });
    expect(out).toEqual({
      connections: [
        { app: 'crm', config: { api_key: REDACTED, 'api-key': REDACTED, apiKey: REDACTED, credentials: REDACTED } },
        { app: 'mail', nested: { deeper: { API_KEY: REDACTED } } },
      ],
    });
  });
});
