import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { decryptJson, encryptJson } from './crypto.js';

export const PENDING_TTL_MS = 5 * 60 * 1000;

/** Credential-based (non-OAuth) apps and the exact shape each one accepts. */
export const CREDENTIAL_SCHEMAS = {
  'generic-api-key': z.object({ apiKey: z.string().min(16).max(256) }).strict(),
  'smtp-relay': z
    .object({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      username: z.string().min(1).max(128),
      password: z.string().min(1).max(256),
    })
    .strict(),
  'custom-webhook': z
    .object({ url: z.string().url().startsWith('https://'), signingSecret: z.string().min(16).max(256) })
    .strict(),
} as const;

export type CredentialApp = keyof typeof CREDENTIAL_SCHEMAS;

export const PendingRequestSchema = z
  .object({
    app: z.enum(Object.keys(CREDENTIAL_SCHEMAS) as [CredentialApp, ...CredentialApp[]]),
    connectionName: z.string().min(1).max(80),
    credentials: z.record(z.unknown()),
  })
  .strict()
  .superRefine((value, issues) => {
    const result = CREDENTIAL_SCHEMAS[value.app].safeParse(value.credentials);
    // Report the path only; issue messages could echo submitted values.
    if (!result.success) issues.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials'], message: 'invalid_shape' });
  });

export interface Redeemed {
  app: string;
  connectionName: string;
  credentials: Record<string, unknown>;
}

export function createPendingStore(db: Db, now: () => number) {
  const insert = db.prepare(
    `INSERT INTO pending_connections
       (pending_id, business_uid, created_by, app, connection_name, credentials_cipher, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // The WHERE clause is the whole security check: unused, unexpired, same business, same member.
  const consume = db.prepare(
    `UPDATE pending_connections SET consumed = 1, consumed_at = ?
     WHERE pending_id = ? AND consumed = 0 AND expires_at > ? AND business_uid = ? AND created_by = ?
     RETURNING app, connection_name, credentials_cipher`,
  );

  return {
    create(input: {
      businessUid: string;
      createdBy: string;
      app: string;
      connectionName: string;
      credentials: Record<string, unknown>;
    }) {
      const pendingId = randomUUID();
      const expiresAt = now() + PENDING_TTL_MS;
      insert.run(
        pendingId,
        input.businessUid,
        input.createdBy,
        input.app,
        input.connectionName,
        encryptJson(input.credentials),
        expiresAt,
      );
      return { pendingId, expiresAt };
    },

    consume(pendingId: string, businessUid: string, createdBy: string): Redeemed | undefined {
      const t = now();
      const row = consume.get(t, pendingId, t, businessUid, createdBy) as
        | { app: string; connection_name: string; credentials_cipher: string }
        | undefined;
      if (!row) return undefined;
      return {
        app: row.app,
        connectionName: row.connection_name,
        credentials: decryptJson<Record<string, unknown>>(row.credentials_cipher),
      };
    },
  };
}

export type PendingStore = ReturnType<typeof createPendingStore>;
