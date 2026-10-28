import type { Db } from './db/index.js';
import { decrypt, encrypt } from './crypto.js';
import { HttpError } from './http-error.js';

/** The only page shape any route may return. */
export interface PublicPage {
  pageId: string;
  name: string;
  category: string | null;
  tasks: string[];
}

/** What the provider returns. Exists only inside this process. */
export interface ProviderPage {
  id: string;
  name: string;
  category?: string | null;
  tasks?: string[];
  access_token: string;
  expiresAt?: number | null;
  channelUid?: string | null;
}

export function toPublicPage(p: { pageId: string; name: string; category?: string | null; tasks?: string[] }): PublicPage {
  return { pageId: p.pageId, name: p.name, category: p.category ?? null, tasks: p.tasks ?? [] };
}

interface PageRow {
  page_id: string;
  name: string;
  category: string | null;
  tasks_json: string;
}

export function createPageTokenVault(db: Db, now: () => number) {
  const upsert = db.prepare(
    `INSERT INTO meta_page_tokens
       (business_uid, page_id, channel_uid, token_cipher, name, category, tasks_json, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (business_uid, page_id) DO UPDATE SET
       channel_uid = excluded.channel_uid,
       token_cipher = excluded.token_cipher,
       name = excluded.name,
       category = excluded.category,
       tasks_json = excluded.tasks_json,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  );

  const upsertPageToken = (businessUid: string, page: ProviderPage) => {
    upsert.run(
      businessUid,
      page.id,
      page.channelUid ?? null,
      encrypt(page.access_token),
      page.name,
      page.category ?? null,
      JSON.stringify(page.tasks ?? []),
      now(),
      page.expiresAt ?? null,
    );
  };

  return {
    upsertPageToken,

    getPageToken(businessUid: string, pageId: string): string {
      const row = db
        .prepare('SELECT token_cipher, expires_at FROM meta_page_tokens WHERE business_uid = ? AND page_id = ?')
        .get(businessUid, pageId) as { token_cipher: string; expires_at: number | null } | undefined;
      if (!row) throw new HttpError(404, 'page_not_connected');
      if (row.expires_at !== null && row.expires_at <= now()) throw new HttpError(401, 'page_token_expired');
      return decrypt(row.token_cipher);
    },

    listPages(businessUid: string, channelUid?: string): PublicPage[] {
      const rows = (
        channelUid
          ? db
              .prepare('SELECT page_id, name, category, tasks_json FROM meta_page_tokens WHERE business_uid = ? AND channel_uid = ? ORDER BY name')
              .all(businessUid, channelUid)
          : db
              .prepare('SELECT page_id, name, category, tasks_json FROM meta_page_tokens WHERE business_uid = ? ORDER BY name')
              .all(businessUid)
      ) as PageRow[];
      return rows.map((r) =>
        toPublicPage({ pageId: r.page_id, name: r.name, category: r.category, tasks: JSON.parse(r.tasks_json) as string[] }),
      );
    },

    /**
     * One-shot migration for databases created before the vault existed, where
     * page tokens were kept in plaintext in `meta_pages_legacy`. Encrypts every
     * row into the vault, then drops the legacy table. Returns rows migrated.
     */
    migrateLegacyPlaintextTokens(): number {
      const legacy = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta_pages_legacy'")
        .get();
      if (!legacy) return 0;
      const rows = db.prepare('SELECT * FROM meta_pages_legacy').all() as Array<{
        business_uid: string;
        page_id: string;
        name: string;
        category: string | null;
        access_token: string;
      }>;
      db.transaction(() => {
        for (const r of rows) {
          upsertPageToken(r.business_uid, { id: r.page_id, name: r.name, category: r.category, access_token: r.access_token });
        }
        db.exec('DROP TABLE meta_pages_legacy');
      })();
      return rows.length;
    },
  };
}

export type PageTokenVault = ReturnType<typeof createPageTokenVault>;
