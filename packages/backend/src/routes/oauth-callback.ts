import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireIdentity } from '../session.js';
import { buildAuthorizeUrl } from '../oauth-flow.js';
import { sendErrorPage } from '../completion-page.js';
import { exchangeSpaCode, verifySpaState } from './spa-callback.js';

const SPA_INDEX = join(import.meta.dirname, '../../../frontend/dist/index.html');

/**
 * Pattern 4: dedicated callback page (Instagram). The provider redirects to the
 * SPA route /oauth/callback/:provider; CallbackPage verifies state with the
 * backend first and only then posts the code for exchange.
 */
export function registerCallbackRoutes(app: FastifyInstance, ctx: AppContext) {
  const callbackProvider = (id: string) => {
    const p = ctx.providers.get(id);
    return p?.pattern === 'callback' ? p : undefined;
  };

  app.post('/oauth/callback/:provider/start', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = callbackProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const { clientNonce } = (req.body ?? {}) as { clientNonce?: string };
    const { payloadId } = ctx.flows.start({
      provider,
      identity,
      redirectUri: `${ctx.cfg.appOrigin}/oauth/callback/${provider.id}`,
      clientNonce,
    });
    const flow = ctx.flows.findForLaunch(payloadId, identity, provider.id)!;
    return { payloadId, authUrl: buildAuthorizeUrl(ctx, provider, flow) };
  });

  // Single-origin deployments: the backend serves the built SPA for this route.
  // In dev, Vite serves it and only the POST endpoints below are proxied.
  app.get('/oauth/callback/:provider', async (req, reply) => {
    if (!callbackProvider((req.params as { provider: string }).provider)) {
      return sendErrorPage(reply, 404, 'Unknown provider', 'There is no callback page for this provider.');
    }
    if (!existsSync(SPA_INDEX)) {
      return sendErrorPage(reply, 404, 'SPA not built', 'Run `pnpm build`, or use `pnpm dev` where Vite serves this route.');
    }
    return reply.type('text/html; charset=utf-8').send(readFileSync(SPA_INDEX, 'utf8'));
  });

  app.post('/oauth/callback/:provider/verify-state', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = callbackProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    return verifySpaState(ctx, identity, [provider.id], req.body);
  });

  app.post('/oauth/callback/:provider/exchange', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = callbackProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
    return exchangeSpaCode(ctx, identity, [provider.id], req.body);
  });
}
