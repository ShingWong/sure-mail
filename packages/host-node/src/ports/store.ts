// store port: one SQLite file per store name (node:sqlite). The schema is
// owned by the core — the host only executes store.exec effects, never
// invents SQL.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StoreResult {
  rows: Record<string, unknown>[];
  changes: number;
  insertId: number;
}

/** Statements that produce rows (vs writes/DDL). */
function returnsRows(sql: string): boolean {
  return /^\s*(select|with|values)\b/i.test(sql);
}

/** Coerce node:sqlite values into JSON-safe values for the ABI. */
function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return String(value);
}

export class StorePorts {
  private dbs = new Map<string, DatabaseSync>();
  private resolvePath: (store: string) => string;

  constructor(resolvePath: (store: string) => string) {
    this.resolvePath = resolvePath;
  }

  exec(store: string, sql: string, params: unknown[]): StoreResult {
    const db = this.open(store);
    const mapRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(row)) out[key] = toJsonValue(row[key]);
      return out;
    };
    if (params.length > 0) {
      const stmt = db.prepare(sql);
      if (returnsRows(sql)) {
        const rows = (stmt.all(...(params as never[])) as Record<string, unknown>[]).map(mapRow);
        return { rows, changes: 0, insertId: 0 };
      }
      const info = stmt.run(...(params as never[]));
      return { rows: [], changes: Number(info.changes), insertId: Number(info.lastInsertRowid) };
    }
    if (returnsRows(sql)) {
      const rows = (db.prepare(sql).all() as Record<string, unknown>[]).map(mapRow);
      return { rows, changes: 0, insertId: 0 };
    }
    db.exec(sql); // multi-statement DDL etc.
    const meta = db.prepare("SELECT changes() AS c, last_insert_rowid() AS id").get() as
      | { c: number; id: number }
      | undefined;
    return { rows: [], changes: Number(meta?.c ?? 0), insertId: Number(meta?.id ?? 0) };
  }

  private open(store: string): DatabaseSync {
    const existing = this.dbs.get(store);
    if (existing) return existing;
    const path = this.resolvePath(store);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    this.dbs.set(store, db);
    return db;
  }

  closeAll(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}
