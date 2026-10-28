import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { assertKeyConfigured } from './crypto.js';
import { openDb } from './db/index.js';
import { createLogger, requestPath } from './redacting-logger.js';
import { buildRegistry } from './provider-registry.js';
import { createFlowStore } from './oauth-flow.js';
import { createConnectionStore } from './connections.js';
import { createPendingStore } from './pending-connection.js';
import { createPageTokenVault } from './page-token-vault.js';
import { HttpError } from './http-error.js';
import { registerSessionRoutes } from './session.js';
import { registerMockOAuth } from './mock-oauth-server.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(cfg: AppConfig = loadConfig()): Promise<FastifyInstance> {
  assertKeyConfigured();

  const db = await openDb(cfg.dbPath);
  const log = createLogger(cfg.env.LOG_LEVEL ?? 'info');
  const ctx: AppContext = {
    cfg,
    db,
    log,
    providers: buildRegistry(cfg),
    flows: createFlowStore(db, cfg.now),
    connections: createConnectionStore(db, cfg.now),
    pending: createPendingStore(db, cfg.now),
    vault: createPageTokenVault(db, cfg.now),
  };
  const migrated = ctx.vault.migrateLegacyPlaintextTokens();
  if (migrated > 0) log.info('vault.migrated_legacy_rows', { count: migrated });

  // Fastify's own logger would print full URLs; ours prints paths only.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.decorate('demo', ctx);

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Only needed when the SPA and API live on different origins.
  app.addHook('onRequest', async (req, reply) => {
    if (cfg.appOrigin === cfg.apiOrigin || req.headers.origin !== cfg.appOrigin) return;
    reply.header('access-control-allow-origin', cfg.appOrigin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, POST');
      reply.header('access-control-allow-headers', 'content-type');
      return reply.code(204).send();
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.addHook('onResponse', async (req, reply) => {
    log.info('request', { method: req.method, path: requestPath(req.url), status: reply.statusCode });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request' });
    log.error('request.failed', { path: requestPath(req.url), kind: (err as Error).name });
    return reply.code(500).send({ error: 'internal_error' });
  });

  registerSessionRoutes(app, ctx);
  registerMockOAuth(app, ctx);
  registerRoutes(app, ctx);
  app.get('/health', async () => ({ ok: true }));

  app.addHook('onClose', async () => db.close());
  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadConfig();
  try {
    const app = await buildServer(cfg);
    const host = cfg.env.HOST ?? '127.0.0.1';
    await app.listen({ port: cfg.port, host });
    console.log(`backend listening on http://${host}:${cfg.port} (app origin ${cfg.appOrigin})`);
  } catch (err) {
    console.error(`backend failed to start: ${(err as Error).message}`);
    process.exit(1);
  }
}
