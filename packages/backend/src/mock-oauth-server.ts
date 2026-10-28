import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { pkceChallenge } from './oauth-flow.js';
import { sendErrorPage } from './completion-page.js';

/**
 * A small fake identity provider so every flow runs end to end with no real
 * credentials. It behaves like a strict IdP: registered redirect origins only,
 * single-use codes, exact redirect_uri match, PKCE S256 when a challenge was sent.
 * Pages and tokens it hands out are random per run.
 */

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string | undefined;
  used: boolean;
}

interface MockForm {
  id: string;
  name: string;
  questions: Array<{ key: string; label: string; type: string }>;
}

interface MockPage {
  id: string;
  name: string;
  category: string;
  tasks: string[];
  token: string;
  forms: MockForm[];
}

const opaque = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;
const numericId = () => Array.from({ length: 15 }, (_, i) => randomInt(i === 0 ? 1 : 0, 10)).join('');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function registerMockOAuth(app: FastifyInstance, ctx: AppContext) {
  const codes = new Map<string, IssuedCode>();
  const userTokens = new Map<string, { clientId: string; pages: MockPage[] | null }>();
  const pageTokens = new Map<string, MockPage>();
  const registeredOrigins = new Set([ctx.cfg.appOrigin, ctx.cfg.apiOrigin]);

  const redirectAllowed = (uri: string) => {
    try {
      return registeredOrigins.has(new URL(uri).origin);
    } catch {
      return false;
    }
  };

  const issueCode = (clientId: string, redirectUri: string, scope: string, codeChallenge?: string) => {
    const code = opaque('mock_code_');
    codes.set(code, { clientId, redirectUri, scope, codeChallenge, used: false });
    return code;
  };

  const makePages = (): MockPage[] =>
    [
      { name: 'Northwind Bakery', category: 'Bakery' },
      { name: 'Contoso Outdoor', category: 'Sporting goods' },
    ].map(({ name, category }) => {
      const page: MockPage = {
        id: numericId(),
        name,
        category,
        tasks: ['ADVERTISE', 'MANAGE'],
        token: opaque('mock_page_token_'),
        forms: ['Request a callback', 'Get a quote'].map((formName) => ({
          id: numericId(),
          name: formName,
          questions: [
            { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
            { key: 'email', label: 'Email', type: 'EMAIL' },
            { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
          ],
        })),
      };
      pageTokens.set(page.token, page);
      return page;
    });

  app.get('/mock-oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.client_id || q.response_type !== 'code' || !q.redirect_uri || !redirectAllowed(q.redirect_uri)) {
      return sendErrorPage(reply, 400, 'Invalid authorization request', 'client_id, response_type=code and a registered redirect_uri are required.');
    }

    if (q.decision === 'allow' || q.decision === 'deny') {
      const back = new URL(q.redirect_uri);
      if (q.decision === 'allow') {
        back.searchParams.set('code', issueCode(q.client_id, q.redirect_uri, q.scope ?? '', q.code_challenge));
      } else {
        back.searchParams.set('error', 'access_denied');
      }
      if (q.state) back.searchParams.set('state', q.state);
      return reply.redirect(back.toString());
    }

    const decisionHref = (decision: string) => {
      const u = new URL(req.url, 'http://mock.invalid');
      u.searchParams.set('decision', decision);
      return escapeHtml(u.pathname + u.search);
    };
    const scopes = (q.scope ?? '').split(' ').filter(Boolean).map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('');
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock IdP consent</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;line-height:1.5">
<p style="color:#666;font-size:.85rem">Mock identity provider · local demo</p>
<h1 style="font-size:1.3rem"><code>${escapeHtml(q.client_id)}</code> wants access</h1>
<ul>${scopes}</ul>
<p><a href="${decisionHref('allow')}" style="padding:.5rem 1rem;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Allow</a>
&nbsp;<a href="${decisionHref('deny')}" style="padding:.5rem 1rem;border:1px solid #999;border-radius:6px;text-decoration:none;color:inherit">Deny</a></p>
</body></html>`);
  });

  app.post('/mock-oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rec = typeof b.code === 'string' ? codes.get(b.code) : undefined;
    if (!rec) return reply.code(400).send({ error: 'invalid_grant' });
    if (rec.used) return reply.code(400).send({ error: 'invalid_grant', error_description: 'code already used' });
    rec.used = true;
    if (b.redirect_uri !== rec.redirectUri || b.client_id !== rec.clientId) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect_uri or client mismatch' });
    }
    if (rec.codeChallenge && (typeof b.code_verifier !== 'string' || pkceChallenge(b.code_verifier) !== rec.codeChallenge)) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'pkce verification failed' });
    }
    const accessToken = opaque('mock_at_');
    userTokens.set(accessToken, { clientId: rec.clientId, pages: null });
    return {
      access_token: accessToken,
      refresh_token: opaque('mock_rt_'),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: rec.scope,
    };
  });

  // --- Graph-like endpoints used by the Meta pages demo (M2) ---------------

  app.get('/mock-oauth/graph/me/accounts', async (req, reply) => {
    const user = userTokens.get(bearer(req) ?? '');
    if (!user) return reply.code(401).send({ error: { message: 'invalid user token' } });
    user.pages ??= makePages();
    return {
      data: user.pages.map((p) => ({ id: p.id, name: p.name, category: p.category, tasks: p.tasks, access_token: p.token })),
    };
  });

  app.get('/mock-oauth/graph/:pageId/leadgen_forms', async (req, reply) => {
    const { pageId } = req.params as { pageId: string };
    const page = pageTokens.get(bearer(req) ?? '');
    if (!page || page.id !== pageId) return reply.code(401).send({ error: { message: 'page token does not match page' } });
    return { data: page.forms.map((f) => ({ id: f.id, name: f.name, status: 'ACTIVE' })) };
  });

  app.get('/mock-oauth/graph/:formId/questions', async (req, reply) => {
    const { formId } = req.params as { formId: string };
    const form = pageTokens.get(bearer(req) ?? '')?.forms.find((f) => f.id === formId);
    if (!form) return reply.code(401).send({ error: { message: 'form not reachable with this page token' } });
    return { data: form.questions };
  });

  // --- WhatsApp Embedded Signup stand-in (Pattern 3) ----------------------

  app.get('/mock-oauth/embedded-signup', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.client_id) return sendErrorPage(reply, 400, 'Invalid request', 'client_id is required.');
    const nonce = randomBytes(16).toString('base64');
    const cfgJson = JSON.stringify({ clientId: q.client_id, targetOrigin: ctx.cfg.appOrigin }).replace(/</g, '\\u003c');
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'`)
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mock Embedded Signup</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;line-height:1.5">
<p style="color:#666;font-size:.85rem">Mock WhatsApp Embedded Signup · local demo</p>
<h1 style="font-size:1.3rem">Connect a WhatsApp Business number</h1>
<p><button id="finish">Finish signup</button> <button id="cancel">Cancel</button></p>
<script type="application/json" id="cfg">${cfgJson}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  function send(event) {
    fetch('postmessage', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, event: event }) })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        body.messages.forEach(function (m) { if (window.opener) window.opener.postMessage(JSON.stringify(m), cfg.targetOrigin); });
        window.close();
      });
  }
  document.getElementById('finish').addEventListener('click', function () { send('FINISH'); });
  document.getElementById('cancel').addEventListener('click', function () { send('CANCEL'); });
})();
</script></body></html>`);
  });

  /** Returns the messages the real SDK would post to the opener for a given outcome. */
  app.post('/mock-oauth/postmessage', async (req, reply) => {
    const b = (req.body ?? {}) as { client_id?: unknown; event?: unknown };
    if (typeof b.client_id !== 'string') return reply.code(400).send({ error: 'client_id required' });
    switch (b.event) {
      case 'FINISH':
        return {
          messages: [
            { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: numericId(), waba_id: numericId() } },
            { type: 'FB_LOGIN_RESPONSE', authResponse: { code: issueCode(b.client_id, '', 'whatsapp_business_management') } },
          ],
        };
      case 'CANCEL':
        return { messages: [{ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } }] };
      case 'ERROR':
        return { messages: [{ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'mock signup error' } }] };
      default:
        return reply.code(400).send({ error: 'event must be FINISH, CANCEL or ERROR' });
    }
  });
}
