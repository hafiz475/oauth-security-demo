import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * SQLite via sql.js (WebAssembly), so `pnpm install` never needs a native
 * toolchain. This adapter exposes the small synchronous subset the app uses:
 * prepare().run/get/all, exec, transaction, close.
 */

type Param = string | number | null | undefined;
// Callers cast rows to their table's shape, as with better-sqlite3.
type Row = Record<string, any>;

export interface Statement {
  run(...params: Param[]): { changes: number };
  get(...params: Param[]): Row | undefined;
  all(...params: Param[]): Row[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

let engine: Promise<SqlJsStatic> | undefined;
function loadEngine() {
  // Hand the wasm bytes over directly so loading works the same under Node and jsdom.
  const wasmPath = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
  engine ??= initSqlJs({ wasmBinary: readFileSync(wasmPath) as unknown as ArrayBuffer });
  return engine;
}

const bindable = (params: Param[]) => params.map((p) => (p === undefined ? null : p));
const isRead = (sql: string) => /^\s*select\b/i.test(sql);

export async function openDb(path: string): Promise<Db> {
  const SQL = await loadEngine();
  const inMemory = path === ':memory:';
  const raw: SqlJsDatabase = new SQL.Database(!inMemory && existsSync(path) ? readFileSync(path) : undefined);
  raw.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'));

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (inMemory) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, raw.export());
    renameSync(`${path}.tmp`, path);
  };
  const markDirty = () => {
    if (!inMemory && !flushTimer) flushTimer = setTimeout(flush, 250);
  };

  // Statements are prepared per call: sql.js frees cached statements on export().
  const execute = <T>(sql: string, params: Param[], read: (stmt: ReturnType<SqlJsDatabase['prepare']>) => T): T => {
    const stmt = raw.prepare(sql);
    try {
      stmt.bind(bindable(params));
      return read(stmt);
    } finally {
      stmt.free();
      if (!isRead(sql)) markDirty();
    }
  };

  return {
    prepare(sql) {
      return {
        run: (...params) =>
          execute(sql, params, (stmt) => {
            while (stmt.step());
            return { changes: raw.getRowsModified() };
          }),
        get: (...params) => execute(sql, params, (stmt) => (stmt.step() ? (stmt.getAsObject() as Row) : undefined)),
        all: (...params) =>
          execute(sql, params, (stmt) => {
            const rows: Row[] = [];
            while (stmt.step()) rows.push(stmt.getAsObject() as Row);
            return rows;
          }),
      };
    },
    exec(sql) {
      raw.exec(sql);
      markDirty();
    },
    transaction(fn) {
      return () => {
        raw.exec('BEGIN');
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        } finally {
          markDirty();
        }
      };
    },
    close() {
      if (flushTimer) flush();
      raw.close();
    },
  };
}
