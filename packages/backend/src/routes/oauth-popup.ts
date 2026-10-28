import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getIdentity, requireIdentity } from '../session.js';
import { buildAuthorizeUrl, exchangeCode, safeErrorCode } from '../oauth-flow.js';
import { sendCompletionPage, sendErrorPage } from '../completion-page.js';

/**
 * Pattern 1: backend-driven popup.
 *   SPA  POST /oauth/popup/:provider/start        -> { payloadId, launchUrl }
 *   pop  GET  /oauth/popup/:provider?payloadId=…  -> 302 to the provider (state + PKCE)
 *   pop  GET  /oauth/popup/:provider/callback     -> verify state, exchange, completion page
 *   SPA  GET  /google-oauth2/:payloadId/getByPayload
 */
export function registerPopupRoutes(app: FastifyInstance, ctx: AppContext) {
  const popupProvider = (id: string) => {
    const p = ctx.providers.get(id);
    return p?.pattern === 'popup' ? p : undefined;
  };

  app.post('/oauth/popup/:provider/start', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = popupProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const { payloadId } = ctx.flows.start({
      provider,
      identity,
      redirectUri: `${ctx.cfg.apiOrigin}/oauth/popup/${provider.id}/callback`,
    });
    const launchUrl = new URL(`${ctx.cfg.apiOrigin}/oauth/popup/${provider.id}`);
    launchUrl.searchParams.set('payloadId', payloadId);
    return { payloadId, launchUrl: launchUrl.toString() };
  });

  app.get('/oauth/popup/:provider', async (req, reply) => {
    const identity = getIdentity(ctx, req);
    const provider = popupProvider((req.params as { provider: string }).provider);
    const flow =
      identity && provider ? ctx.flows.findForLaunch((req.query as { payloadId?: string }).payloadId, identity, provider.id) : undefined;
    if (!provider || !flow) {
      return sendErrorPage(reply, 404, 'Connection link not found', 'Start the connection again from the app.');
    }
    return reply.redirect(buildAuthorizeUrl(ctx, provider, flow));
  });

  app.get('/oauth/popup/:provider/callback', async (req, reply) => {
    const identity = getIdentity(ctx, req);
    const provider = popupProvider((req.params as { provider: string }).provider);
    const q = req.query as { code?: string; state?: string; error?: string };

    const flow = identity && provider ? ctx.flows.claim(identity, [provider.id], q.state) : undefined;
    if (!identity || !provider || !flow) {
      // No completion message is sent for a state we did not issue to this session.
      ctx.log.warn('oauth.state_rejected', { pattern: 'popup', provider: provider?.id ?? 'unknown' });
      return sendErrorPage(reply, 400, 'Sign-in link invalid or expired', 'Close this window and start the connection again.');
    }

    if (q.error || !q.code) {
      return sendCompletionPage(reply, { status: 'error', payloadId: flow.payload_id, error: safeErrorCode(q.error ?? 'missing_code') }, ctx.cfg.appOrigin);
    }

    try {
      const tokens = await exchangeCode(ctx, provider, flow, q.code);
      ctx.connections.save({
        payloadId: flow.payload_id,
        provider: provider.id,
        businessUid: identity.businessUid,
        memberId: identity.memberId,
        secret: tokens,
        details: { scopes: provider.scopes },
      });
    } catch {
      return sendCompletionPage(reply, { status: 'error', payloadId: flow.payload_id, error: 'exchange_failed' }, ctx.cfg.appOrigin);
    }
    return sendCompletionPage(reply, { status: 'success', payloadId: flow.payload_id }, ctx.cfg.appOrigin);
  });

  app.get('/google-oauth2/:payloadId/getByPayload', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const connection = ctx.connections.getPublic((req.params as { payloadId: string }).payloadId, identity.businessUid);
    if (!connection) return reply.code(404).send({ error: 'not_found' });
    return connection;
  });
}
