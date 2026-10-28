import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireIdentity } from '../session.js';
import { buildAuthorizeUrl } from '../oauth-flow.js';
import { exchangeSpaCode, verifySpaState } from './spa-callback.js';
import { syncPagesFromGraph } from './meta-pages.js';

export const META_CALLBACK_PATH = '/oauth/meta/callback';

/**
 * Pattern 2: Meta full-page redirect. The three Meta providers share one
 * handler and one redirect URI; the flow row remembers which provider it was.
 */
export function registerRedirectRoutes(app: FastifyInstance, ctx: AppContext) {
  const metaIds = [...ctx.providers.values()].filter((p) => p.pattern === 'redirect').map((p) => p.id);

  app.post('/oauth/redirect/:provider/start', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = ctx.providers.get((req.params as { provider: string }).provider);
    if (!provider || provider.pattern !== 'redirect') return reply.code(404).send({ error: 'unknown_provider' });

    const { clientNonce } = (req.body ?? {}) as { clientNonce?: string };
    const { payloadId } = ctx.flows.start({ provider, identity, redirectUri: `${ctx.cfg.appOrigin}${META_CALLBACK_PATH}`, clientNonce });
    const flow = ctx.flows.findForLaunch(payloadId, identity, provider.id)!;
    return { payloadId, authUrl: buildAuthorizeUrl(ctx, provider, flow) };
  });

  app.post('/oauth/redirect/verify-state', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    return verifySpaState(ctx, identity, metaIds, req.body);
  });

  app.post('/oauth/redirect/exchange', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    return exchangeSpaCode(ctx, identity, metaIds, req.body, async (provider, tokens, payloadId) => {
      // Lead Ads needs the page list; page tokens go straight into the vault.
      if (provider.id === 'facebook-lead-ads') await syncPagesFromGraph(ctx, identity, tokens.accessToken, payloadId);
    });
  });
}
