// store worker main: sqlite3.wasm with one database per store name
// ("registry" | "account:<id>"). In the browser the sahpool OPFS VFS makes
// each database persistent; in the Node test harness (node.mjs build) the
// same exec logic runs against per-store in-memory databases. The schema is
// owned by the core — the worker only executes store.exec requests, never
// invents SQL.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { toBase64 } from "../base64.ts";
import { storePath } from "./layout.ts";
import type {
  StoreWorkerEndpoint,
  StoreError,
  StoreExec,
  StoreReply,
  StoreRequest,
  StoreResult,
} from "./protocol.ts";

type Sqlite3Static = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SqliteDb = InstanceType<Sqlite3Static["oo1"]["DB"]>;

/** Statements that produce rows (vs writes/DDL) — host-node parity. */
function returnsRows(sql: string): boolean {
  return /^\s*(select|with|values)\b/i.test(sql);
}

/** Coerce SQLite values into JSON-safe values for the ABI — host-node parity. */
function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return toBase64(value);
  return String(value);
}

/** JSON params may carry booleans; SQLite binds integers. */
function toBindValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class StoreWorker {
  private sqlite3: Sqlite3Static | null = null;
  private dbs = new Map<string, SqliteDb>();
  private vfs: string | undefined;
  private persistent = false;
  private fatal: StoreError | null = null;
  private readonly endpoint: StoreWorkerEndpoint;
  private readonly setup: Promise<void>;

  constructor(endpoint: StoreWorkerEndpoint) {
    this.endpoint = endpoint;
    endpoint.onRequest((msg) => this.onRequest(msg));
    this.setup = this.init();
  }

  private async init(): Promise<void> {
    try {
      const sqlite3 = await sqlite3InitModule();
      if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
        // One sahpool backs every store. Each account DB consumes a few
        // pool slots (the db plus its rollback journal), and the pool
        // cannot grow after creation, so size it for a realistic mailbox
        // count up front. If installation throws (no OPFS — storage
        // blocked, quota), the store is fatal: better to fail loudly than
        // silently run in memory and lose data on reload.
        const pool = await sqlite3.installOpfsSAHPoolVfs({ initialCapacity: 64 });
        this.vfs = pool.vfsName;
        this.persistent = true;
      }
      // No sahpool API at all (Node harness / node.mjs build): in-memory.
      this.sqlite3 = sqlite3;
      this.reply({ t: "ready", persistent: this.persistent });
    } catch (err) {
      this.fatal = { code: -5, where: "store.init", detail: detail(err) };
      this.reply({ t: "fatal", error: this.fatal });
    }
  }

  private onRequest(msg: StoreRequest): void {
    if (msg.t === "init") return; // setup runs at construction
    if (msg.t === "close") {
      for (const db of this.dbs.values()) db.close();
      this.dbs.clear();
      return;
    }
    void this.onExec(msg);
  }

  private async onExec(msg: StoreExec): Promise<void> {
    await this.setup;
    if (this.fatal) {
      this.reply({ t: "result", id: msg.id, error: this.fatal });
      return;
    }
    try {
      const result = this.exec(msg.store, msg.sql, msg.params);
      this.reply({ t: "result", id: msg.id, result });
    } catch (err) {
      this.reply({
        t: "result",
        id: msg.id,
        error: { code: -5, where: "store.exec", detail: detail(err) },
      });
    }
  }

  private exec(store: string, sql: string, params: unknown[]): StoreResult {
    const db = this.open(store);
    const mapRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(row)) out[key] = toJsonValue(row[key]);
      return out;
    };
    if (params.length > 0) {
      const bind = params.map(toBindValue) as never[];
      if (returnsRows(sql)) {
        const rows = (db.selectObjects(sql, bind) as Record<string, unknown>[]).map(mapRow);
        return { rows, changes: 0, insertId: 0 };
      }
      const stmt = db.prepare(sql);
      stmt.bind(bind);
      stmt.stepFinalize(); // finalizes the statement
      return this.writeInfo(db);
    }
    if (returnsRows(sql)) {
      const rows = (db.selectObjects(sql) as Record<string, unknown>[]).map(mapRow);
      return { rows, changes: 0, insertId: 0 };
    }
    db.exec(sql); // multi-statement DDL etc.
    return this.writeInfo(db);
  }

  private writeInfo(db: SqliteDb): StoreResult {
    const api = this.sqlite3;
    if (!api) throw new Error("store worker not initialized");
    return {
      rows: [],
      changes: Number(db.changes()),
      insertId: Number(api.capi.sqlite3_last_insert_rowid(db)),
    };
  }

  private open(store: string): SqliteDb {
    const existing = this.dbs.get(store);
    if (existing) return existing;
    const path = storePath(store); // throws on unknown store names
    // In-memory mode keeps one private database per store name (each
    // `:memory:` connection is isolated); OPFS mode files them by path.
    const db = this.persistent
      ? new this.sqlite3!.oo1.DB({ filename: path, vfs: this.vfs })
      : new this.sqlite3!.oo1.DB({ filename: ":memory:" });
    // Foreign keys on for both modes. Journal stays at the default
    // (rollback) mode: WAL needs extra pool slots for the -wal/-shm files
    // and the sahpool cannot grow after creation, so WAL would exhaust the
    // pool. host-node keeps WAL because a real filesystem can grow.
    db.exec("PRAGMA foreign_keys = ON;");
    this.dbs.set(store, db);
    return db;
  }

  private reply(msg: StoreReply): void {
    this.endpoint.post(msg);
  }
}

/** Start the store worker loop on the given endpoint. */
export function runStoreWorker(endpoint: StoreWorkerEndpoint): void {
  new StoreWorker(endpoint);
}
