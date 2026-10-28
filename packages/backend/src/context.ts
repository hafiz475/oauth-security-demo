import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Logger } from './redacting-logger.js';
import type { Provider } from './provider-registry.js';
import type { FlowStore } from './oauth-flow.js';
import type { ConnectionStore } from './connections.js';
import type { PendingStore } from './pending-connection.js';
import type { PageTokenVault } from './page-token-vault.js';

export interface AppContext {
  cfg: AppConfig;
  db: Db;
  log: Logger;
  providers: Map<string, Provider>;
  flows: FlowStore;
  connections: ConnectionStore;
  pending: PendingStore;
  vault: PageTokenVault;
}

declare module 'fastify' {
  interface FastifyInstance {
    demo: AppContext;
  }
}
