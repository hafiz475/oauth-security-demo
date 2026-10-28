import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Identity } from '../session.js';
import { requireIdentity } from '../session.js';
import { HttpError } from '../http-error.js';

/** Server-to-server Graph call. Tokens go in the Authorization header, never the URL. */
async function graphGet<T>(ctx: AppContext, path: string, bearerToken: string): Promise<T> {
  const res = await ctx.cfg.fetch(`${ctx.cfg.graphBase}${path}`, {
    headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json' },
  });
  if (res.status === 401) throw new HttpError(401, 'provider_rejected_token');
  if (!res.ok) throw new HttpError(502, 'provider_error');
  return (await res.json()) as T;
}

/** Called after a Lead Ads connection: page tokens go straight into the vault. */
export async function syncPagesFromGraph(ctx: AppContext, identity: Identity, userAccessToken: string, channelUid: string) {
  const { data } = await graphGet<{
    data: Array<{ id: string; name: string; category?: string; tasks?: string[]; access_token: string }>;
  }>(ctx, '/me/accounts', userAccessToken);
  for (const page of data) ctx.vault.upsertPageToken(identity.businessUid, { ...page, channelUid });
}

const pathSegment = (s: string) => encodeURIComponent(s);

/** M2: the browser works in page ids. Every route resolves the token server-side. */
export function registerMetaPagesRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/meta/pages', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const { channelUid } = req.query as { channelUid?: string };
    return { pages: ctx.vault.listPages(identity.businessUid, channelUid) };
  });

  app.get('/meta/pages/:pageId/forms', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const { pageId } = req.params as { pageId: string };
    const pageToken = ctx.vault.getPageToken(identity.businessUid, pageId);
    const { data } = await graphGet<{ data: Array<{ id: string; name: string; status: string }> }>(
      ctx,
      `/${pathSegment(pageId)}/leadgen_forms`,
      pageToken,
    );
    return { forms: data.map(({ id, name, status }) => ({ id, name, status })) };
  });

  app.get('/meta/pages/:pageId/fields', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    const { pageId } = req.params as { pageId: string };
    const { formId } = req.query as { formId?: string };
    if (!formId) return reply.code(400).send({ error: 'formId_required' });
    const pageToken = ctx.vault.getPageToken(identity.businessUid, pageId);
    const { data } = await graphGet<{ data: Array<{ key: string; label: string; type: string }> }>(
      ctx,
      `/${pathSegment(formId)}/questions`,
      pageToken,
    );
    return { fields: data.map(({ key, label, type }) => ({ key, label, type })) };
  });
}
