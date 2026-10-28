import type { AppContext } from '../context.js';
import type { Provider } from '../provider-registry.js';
import type { Identity } from '../session.js';
import { exchangeCode, type TokenSet } from '../oauth-flow.js';
import { HttpError } from '../http-error.js';

/**
 * Shared by Pattern 2 (Meta redirect) and Pattern 4 (Instagram callback page):
 * the provider redirects to an SPA route, the SPA strips code/state from the
 * address bar, then asks the backend to verify and exchange.
 */

export function verifySpaState(ctx: AppContext, identity: Identity, providers: string[], body: unknown) {
  const state = (body as { state?: unknown } | null)?.state;
  return { valid: ctx.flows.peek(identity, providers, state) !== undefined };
}

export async function exchangeSpaCode(
  ctx: AppContext,
  identity: Identity,
  providers: string[],
  body: unknown,
  afterConnect?: (provider: Provider, tokens: TokenSet, payloadId: string) => Promise<void>,
) {
  const { code, state } = (body ?? {}) as { code?: unknown; state?: unknown };
  if (typeof code !== 'string' || code.length === 0 || code.length > 2048) throw new HttpError(400, 'invalid_request');

  const flow = ctx.flows.claim(identity, providers, state);
  if (!flow) {
    ctx.log.warn('oauth.state_rejected', { pattern: 'spa-callback' });
    throw new HttpError(400, 'invalid_state');
  }
  const provider = ctx.providers.get(flow.provider)!;
  const tokens = await exchangeCode(ctx, provider, flow, code);
  const payloadId = ctx.connections.save({
    payloadId: flow.payload_id,
    provider: provider.id,
    businessUid: identity.businessUid,
    memberId: identity.memberId,
    secret: tokens,
    details: { scopes: provider.scopes },
  });
  await afterConnect?.(provider, tokens, payloadId);
  return { status: 'success' as const, provider: provider.id, payloadId };
}
