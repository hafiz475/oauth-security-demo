import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';

const COOKIE_NAME = 'demo_sid';
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export interface Identity {
  sessionId: string;
  businessUid: string;
  memberId: string;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function getIdentity(ctx: AppContext, req: FastifyRequest): Identity | null {
  const sessionId = readCookie(req.headers.cookie, COOKIE_NAME);
  if (!sessionId) return null;
  const row = ctx.db
    .prepare('SELECT business_uid, member_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { business_uid: string; member_id: string } | undefined;
  return row ? { sessionId, businessUid: row.business_uid, memberId: row.member_id } : null;
}

export function requireIdentity(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Identity | null {
  const identity = getIdentity(ctx, req);
  if (!identity) void reply.code(401).send({ error: 'not_signed_in' });
  return identity;
}

/**
 * Demo sign-in. A real deployment replaces this with its auth layer; what the
 * mitigations need is only "a server-side session id in an HttpOnly cookie".
 */
export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/session/demo', async (req, reply) => {
    const body = (req.body ?? {}) as { businessUid?: unknown; memberId?: unknown };
    const businessUid = typeof body.businessUid === 'string' ? body.businessUid : 'demo-business';
    const memberId = typeof body.memberId === 'string' ? body.memberId : 'demo-member';
    if (!ID_SHAPE.test(businessUid) || !ID_SHAPE.test(memberId)) {
      return reply.code(400).send({ error: 'invalid_identity' });
    }
    const sessionId = randomUUID();
    ctx.db
      .prepare('INSERT INTO sessions (session_id, business_uid, member_id, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, businessUid, memberId, ctx.cfg.now());
    const secure = ctx.cfg.apiOrigin.startsWith('https://');
    const sameSite = ctx.cfg.apiOrigin === ctx.cfg.appOrigin ? 'Lax' : 'None';
    void reply.header(
      'set-cookie',
      `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=${sameSite}${secure || sameSite === 'None' ? '; Secure' : ''}`,
    );
    return { businessUid, memberId };
  });

  app.get('/session', async (req, reply) => {
    const identity = requireIdentity(ctx, req, reply);
    if (!identity) return reply;
    return { businessUid: identity.businessUid, memberId: identity.memberId };
  });
}
