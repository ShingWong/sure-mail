// store.query op: named, core-owned reads through store.exec effects.
// Args: {store, query, args?} -> result {rows} (or {error} via feed).
//
// The "schema" query is special: it runs a small migration sequence
// (schema.ts owns every statement — the host never invents SQL):
//   phase 0: SCHEMA_V4 DDL           (idempotent, IF NOT EXISTS)
//   phase 1: check accounts.setup_source (pragma_table_info)
//   phase 2: check accounts.smtp_host
//   phase 6: check accounts.socket_type
//   missing columns: ALTER TABLE ... ADD COLUMN (v1/v2/v3-era files only)
//   phase 4: PRAGMA user_version = 4 -> complete
// Result keeps the generic {rows, changes, insertId} shape.

import { Json, KIND_ARR, KIND_NULL } from "../json/value.ts";
import { Op, OpFactory, OpHandler, Runtime } from "../runtime/ops.ts";
import { ERR_INVALID_ARG } from "../runtime/errors.ts";
import { namedQuery } from "./queries.ts";
import {
  HAS_SETUP_SOURCE,
  HAS_SMTP_HOST,
  HAS_SOCKET_TYPE,
  MIGRATE_ADD_SETUP_SOURCE,
  MIGRATE_ADD_SMTP,
  MIGRATE_ADD_SOCKET_TYPE,
  SCHEMA_V4,
  STAMP_USER_VERSION,
} from "./schema.ts";

class StoreQueryHandler implements OpHandler {
  runtime: Runtime;

  constructor(runtime: Runtime, op: Op, store: string, sql: string, params: Json) {
    this.runtime = runtime;
    const eff = Json.emptyObj();
    eff.setStr("kind", "store.exec");
    eff.setStr("store", store);
    eff.setStr("sql", sql);
    eff.set("params", params);
    runtime.emitEffect(op, eff);
  }

  onFeed(op: Op, kind: string, data: Json): i32 {
    if (kind != "store.result") return 0;
    const err = data.get("error");
    if (err != null && err.kind != KIND_NULL) {
      const code = err.getInt("code", -5);
      op.fail(code, err.getString("where", "store"), err.getString("detail", "store error"));
      return 0;
    }
    const out = Json.emptyObj();
    out.set("rows", data.get("rows") != null ? data.get("rows")! : Json.emptyArr());
    out.setInt("changes", <i64>data.getInt("changes", 0));
    out.setInt("insertId", <i64>data.getInt("insertId", 0));
    op.complete(out);
    return 0;
  }

  onCancel(_op: Op): void {}
}

/** Migration-aware schema op (v1 -> v4: setup_source, smtp + transport columns, drafts). */
class SchemaHandler implements OpHandler {
  runtime: Runtime;
  store: string;
  phase: i32 = 0;
  lastChanges: i32 = 0;
  lastInsertId: i32 = 0;

  constructor(runtime: Runtime, op: Op, store: string) {
    this.runtime = runtime;
    this.store = store;
    this.emit(op, SCHEMA_V4);
  }

  private emit(op: Op, sql: string): void {
    const eff = Json.emptyObj();
    eff.setStr("kind", "store.exec");
    eff.setStr("store", this.store);
    eff.setStr("sql", sql);
    const params = Json.emptyArr();
    eff.set("params", params);
    this.runtime.emitEffect(op, eff);
  }

  onFeed(op: Op, kind: string, data: Json): i32 {
    if (kind != "store.result") return 0;
    const err = data.get("error");
    if (err != null && err.kind != KIND_NULL) {
      const code = err.getInt("code", -5);
      op.fail(code, err.getString("where", "store"), err.getString("detail", "store error"));
      return 0;
    }
    this.lastChanges = data.getInt("changes", 0);
    this.lastInsertId = data.getInt("insertId", 0);
    if (this.phase == 0) {
      this.phase = 1;
      this.emit(op, HAS_SETUP_SOURCE);
      return 0;
    }
    if (this.phase == 1) {
      if (hasRows(data)) {
        this.phase = 2;
        this.emit(op, HAS_SMTP_HOST);
      } else {
        this.phase = 5; // ALTER runs before the next check
        this.emit(op, MIGRATE_ADD_SETUP_SOURCE);
      }
      return 0;
    }
    if (this.phase == 2) {
      if (hasRows(data)) {
        this.phase = 6;
        this.emit(op, HAS_SOCKET_TYPE);
      } else {
        this.phase = 3;
        this.emit(op, MIGRATE_ADD_SMTP);
      }
      return 0;
    }
    if (this.phase == 3) {
      // smtp columns just added on a v1/v2-era file: check the v4 columns.
      this.phase = 6;
      this.emit(op, HAS_SOCKET_TYPE);
      return 0;
    }
    if (this.phase == 5) {
      // setup_source was just added on a v1-era file: continue with the
      // smtp columns check.
      this.phase = 2;
      this.emit(op, HAS_SMTP_HOST);
      return 0;
    }
    if (this.phase == 6) {
      if (hasRows(data)) {
        this.phase = 4;
        this.emit(op, STAMP_USER_VERSION);
      } else {
        this.phase = 7;
        this.emit(op, MIGRATE_ADD_SOCKET_TYPE);
      }
      return 0;
    }
    if (this.phase == 7) {
      this.phase = 4;
      this.emit(op, STAMP_USER_VERSION);
      return 0;
    }
    const out = Json.emptyObj();
    out.set("rows", Json.emptyArr());
    out.setInt("changes", <i64>this.lastChanges);
    out.setInt("insertId", <i64>this.lastInsertId);
    op.complete(out);
    return 0;
  }

  onCancel(_op: Op): void {}
}

function hasRows(data: Json): bool {
  const rows = data.get("rows");
  return rows != null && rows.kind == KIND_ARR && rows.length > 0;
}

export class StoreQueryFactory implements OpFactory {
  runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  create(args: Json, op: Op): OpHandler | null {
    const store = args.getString("store", "");
    const name = args.getString("query", "");
    if (store.length == 0 || name.length == 0) return null;
    if (name == "schema") return new SchemaHandler(this.runtime, op, store);
    const inner = args.get("args");
    const queryArgs = inner != null ? inner : Json.emptyObj();
    const query = namedQuery(name, queryArgs);
    if (query == null) return null;
    return new StoreQueryHandler(this.runtime, op, store, query.sql, query.params);
  }
}

/** Emit a named-query store.exec for an in-flight op; returns the effect id. */
export function emitNamedQuery(runtime: Runtime, op: Op, store: string, name: string, args: Json): i32 {
  const query = namedQuery(name, args);
  if (query == null) {
    op.fail(ERR_INVALID_ARG, "query", name);
    return -1;
  }
  const eff = Json.emptyObj();
  eff.setStr("kind", "store.exec");
  eff.setStr("store", store);
  eff.setStr("sql", query.sql);
  eff.set("params", query.params);
  return runtime.emitEffect(op, eff);
}

/** Convenience for handlers: an inline store.exec with params. */
export function emitSql(runtime: Runtime, op: Op, store: string, sql: string, params: Json): i32 {
  const eff = Json.emptyObj();
  eff.setStr("kind", "store.exec");
  eff.setStr("store", store);
  eff.setStr("sql", sql);
  eff.set("params", params);
  return runtime.emitEffect(op, eff);
}
