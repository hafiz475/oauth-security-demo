import { randomUUID } from 'node:crypto';
import type { Db } from './db/index.js';
import { decryptJson, encryptJson } from './crypto.js';

export interface PublicConnection {
  payloadId: string;
  provider: string;
  connectedAt: number;
  details: Record<string, unknown>;
}

interface ConnectionRow {
  payload_id: string;
  provider: string;
  business_uid: string;
  member_id: string;
  secret_cipher: string;
  details_json: string;
  created_at: number;
}

const toPublic = (row: ConnectionRow): PublicConnection => ({
  payloadId: row.payload_id,
  provider: row.provider,
  connectedAt: row.created_at,
  details: JSON.parse(row.details_json) as Record<string, unknown>,
});

export function createConnectionStore(db: Db, now: () => number) {
  return {
    save(input: {
      payloadId?: string;
      provider: string;
      businessUid: string;
      memberId: string;
      secret: unknown;
      details?: Record<string, unknown>;
    }): string {
      const payloadId = input.payloadId ?? randomUUID();
      db.prepare(
        `INSERT OR REPLACE INTO connections
           (payload_id, provider, business_uid, member_id, secret_cipher, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        payloadId,
        input.provider,
        input.businessUid,
        input.memberId,
        encryptJson(input.secret),
        JSON.stringify(input.details ?? {}),
        now(),
      );
      return payloadId;
    },

    getPublic(payloadId: string, businessUid: string): PublicConnection | undefined {
      const row = db
        .prepare('SELECT * FROM connections WHERE payload_id = ? AND business_uid = ?')
        .get(payloadId, businessUid) as ConnectionRow | undefined;
      return row ? toPublic(row) : undefined;
    },

    /** Same as getPublic but also requires the member and a recent creation time. */
    getFresh(payloadId: string, businessUid: string, memberId: string, maxAgeMs: number): PublicConnection | undefined {
      const row = db
        .prepare('SELECT * FROM connections WHERE payload_id = ? AND business_uid = ? AND member_id = ? AND created_at > ?')
        .get(payloadId, businessUid, memberId, now() - maxAgeMs) as ConnectionRow | undefined;
      return row ? toPublic(row) : undefined;
    },

    list(businessUid: string): PublicConnection[] {
      const rows = db
        .prepare('SELECT * FROM connections WHERE business_uid = ? ORDER BY created_at DESC')
        .all(businessUid) as ConnectionRow[];
      return rows.map(toPublic);
    },

    /** Server-side only. Nothing that reaches a response may call this. */
    readSecret<T>(payloadId: string): T {
      const row = db.prepare('SELECT secret_cipher FROM connections WHERE payload_id = ?').get(payloadId) as
        | { secret_cipher: string }
        | undefined;
      if (!row) throw new Error('connection not found');
      return decryptJson<T>(row.secret_cipher);
    },
  };
}

export type ConnectionStore = ReturnType<typeof createConnectionStore>;
