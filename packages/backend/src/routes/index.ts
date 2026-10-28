import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireIdentity } from '../session.js';
import { toPublicProvider } from '../provider-registry.js';
import { registerPendingRoutes } from './integration-pending.js';
import { registerMetaPagesRoutes } from './meta-pages.js';
import { registerPopupRoutes } from './oauth-popup.js';
import { registerRedirectRoutes } from './oauth-redirect.js';
import { registerEmbeddedRoutes } from './oauth-embedded.js';
import { registerCallbackRoutes } from './oauth-callback.js';

export function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/providers', async () => ({ providers: [...ctx.providers.values()].map(toPublicProvider) }));

  app.get('/connections', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    return { connections: ctx.connections.list(identity.businessUid) };
  });

  registerPopupRoutes(app, ctx);
  registerRedirectRoutes(app, ctx);
  registerEmbeddedRoutes(app, ctx);
  registerCallbackRoutes(app, ctx);
  registerPendingRoutes(app, ctx);
  registerMetaPagesRoutes(app, ctx);
}
