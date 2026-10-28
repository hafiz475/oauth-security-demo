import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getIdentity, requireIdentity } from '../session.js';
import { PendingRequestSchema } from '../pending-connection.js';
import { sendCompletionPage, sendErrorPage } from '../completion-page.js';

const COMPLETION_WINDOW_MS = 2 * 60 * 1000;

/**
 * M3: credentials travel in a POST body, never in a URL. The browser gets back
 * an opaque, single-use, 5-minute handle and opens /integration/connect with it.
 */
export function registerPendingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/integration/pending', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    // Anything on the query string is refused outright, so a caller cannot
    // "helpfully" put credentials there and have them land in proxy logs.
    if (Object.keys(req.query as object).length > 0) return reply.code(400).send({ error: 'query_parameters_not_allowed' });

    const parsed = PendingRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', fields: parsed.error.issues.map((i) => i.path.join('.')) });

    const { pendingId, expiresAt } = ctx.pending.create({
      businessUid: identity.businessUid,
      createdBy: identity.memberId,
      app: parsed.data.app,
      connectionName: parsed.data.connectionName,
      credentials: parsed.data.credentials,
    });
    const connectUrl = new URL(`${ctx.cfg.apiOrigin}/integration/connect`);
    connectUrl.searchParams.set('pendingId', pendingId);
    return { pendingId, expiresAt, connectUrl: connectUrl.toString() };
  });

  app.get('/integration/connect', async (req, reply) => {
    const identity = getIdentity(ctx, req);
    const { pendingId } = req.query as { pendingId?: string };
    const redeemed = identity && typeof pendingId === 'string' ? ctx.pending.consume(pendingId, identity.businessUid, identity.memberId) : undefined;
    if (!identity || !redeemed) {
      ctx.log.warn('pending.rejected', {});
      return sendErrorPage(reply, 410, 'Link expired or already used', 'This connection link has expired or was already used. Start the connection again.');
    }

    // Mocked provisioning: a real app would call the provider with the
    // credentials here. They are stored encrypted, never echoed.
    const payloadId = ctx.connections.save({
      provider: redeemed.app,
      businessUid: identity.businessUid,
      memberId: identity.memberId,
      secret: redeemed.credentials,
      details: { connectionName: redeemed.connectionName },
    });
    return reply.redirect(`${ctx.cfg.apiOrigin}/integration/connected/${payloadId}`);
  });

  app.get('/integration/connected/:payloadId', async (req, reply) => {
    const identity = getIdentity(ctx, req);
    const { payloadId } = req.params as { payloadId: string };
    const connection = identity
      ? ctx.connections.getFresh(payloadId, identity.businessUid, identity.memberId, COMPLETION_WINDOW_MS)
      : undefined;
    if (!connection) return sendErrorPage(reply, 404, 'Not found', 'There is no recent connection with this id.');
    return sendCompletionPage(reply, { status: 'success', payloadId }, ctx.cfg.appOrigin);
  });
}
