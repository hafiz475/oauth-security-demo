import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireIdentity } from '../session.js';
import { exchangeCode } from '../oauth-flow.js';
import { providerEnvKey } from '../provider-registry.js';
import { HttpError } from '../http-error.js';

const CompleteSchema = z
  .object({
    state: z.string().min(16).max(256),
    code: z.string().min(1).max(2048),
    wabaId: z.string().regex(/^\d{1,32}$/),
    phoneNumberId: z.string().regex(/^\d{1,32}$/),
  })
  .strict();

/**
 * Pattern 3: WhatsApp Embedded Signup. The SDK popup reports progress through
 * postMessage events and returns an auth code through the login callback.
 * The browser-side listener (frontend/src/lib/embeddedSignup.ts) accepts events
 * only from `allowedOrigins`, which this endpoint serves from ORIGIN_ALLOWLIST.
 */
export function registerEmbeddedRoutes(app: FastifyInstance, ctx: AppContext) {
  const embeddedProvider = (id: string) => {
    const p = ctx.providers.get(id);
    return p?.pattern === 'embedded' ? p : undefined;
  };

  app.post('/oauth/embedded/:provider/config', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = embeddedProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    // Embedded Signup codes are exchanged without a redirect_uri.
    const { payloadId, state } = ctx.flows.start({ provider, identity, redirectUri: '' });
    const signupUrl = new URL(`${ctx.cfg.idpPublicBase}/embedded-signup`);
    signupUrl.searchParams.set('client_id', provider.clientId);
    return {
      payloadId,
      state,
      appId: provider.clientId,
      configId: ctx.cfg.env[providerEnvKey(provider.id, 'CONFIG_ID')] ?? null,
      allowedOrigins: ctx.cfg.originAllowlist,
      signupUrl: signupUrl.toString(),
    };
  });

  app.post('/oauth/embedded/:provider/complete', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const provider = embeddedProvider((req.params as { provider: string }).provider);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const parsed = CompleteSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request');
    const flow = ctx.flows.claim(identity, [provider.id], parsed.data.state);
    if (!flow) {
      ctx.log.warn('oauth.state_rejected', { pattern: 'embedded' });
      throw new HttpError(400, 'invalid_state');
    }
    const tokens = await exchangeCode(ctx, provider, flow, parsed.data.code);
    const payloadId = ctx.connections.save({
      payloadId: flow.payload_id,
      provider: provider.id,
      businessUid: identity.businessUid,
      memberId: identity.memberId,
      secret: tokens,
      details: { scopes: provider.scopes, wabaId: parsed.data.wabaId, phoneNumberId: parsed.data.phoneNumberId },
    });
    return { status: 'success', payloadId };
  });
}
