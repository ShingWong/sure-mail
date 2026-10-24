// sure-mail core — public exports (the wasm ABI, docs/abi.md §3).
// The host drives everything: effects out via op_effects(), results in via
// op_feed(), completion observed through op_status().

import { Json, KIND_ARR } from "./json/value.ts";
import { parseJson } from "./json/parse.ts";
import { stringifyJson } from "./json/stringify.ts";
import { Runtime } from "./runtime/ops.ts";
import { EchoFactory } from "./runtime/echo.ts";
import { Accounts } from "./runtime/accounts.ts";
import { ERR_INVALID_ARG, ERR_STATE } from "./runtime/errors.ts";
import { ConnectFactory, FoldersFactory, SyncFactory, FetchFactory } from "./imap/handlers.ts";
import { AppendFactory } from "./imap/append.ts";
import { StoreQueryFactory } from "./store/handler.ts";
import { AutodiscoverFactory } from "./autodiscover/handler.ts";
import { SmtpSendFactory } from "./smtp/handler.ts";
import { MimeBuildFactory } from "./mime/handler.ts";

export const CORE_VERSION = "0.5.0";

const runtime = new Runtime();
const accounts = new Accounts();

runtime.register("echo", new EchoFactory(runtime));
runtime.register("imap.connect", new ConnectFactory(runtime, accounts));
runtime.register("imap.folders", new FoldersFactory(runtime, accounts));
runtime.register("imap.sync", new SyncFactory(runtime, accounts));
runtime.register("imap.fetch", new FetchFactory(runtime, accounts));
runtime.register("imap.append", new AppendFactory(runtime, accounts));
runtime.register("store.query", new StoreQueryFactory(runtime));
runtime.register("account.autodiscover", new AutodiscoverFactory(runtime));
runtime.register("smtp.send", new SmtpSendFactory(runtime, accounts));
runtime.register("mime.build", new MimeBuildFactory(runtime));

/** Core API semver. */
export function sm_version(): string {
  return CORE_VERSION;
}

/**
 * Initialize the core. Config: {accounts?: [...], logLevel?: string}.
 * The host loads persisted account rows and passes them here so the
 * in-memory registry is warm before account or op calls. Required
 * before op_start (error -3 otherwise).
 */
export function sm_init(configJson: string): i32 {
  if (runtime.hasPendingOps()) return ERR_STATE;
  const config = parseJson(configJson);
  if (config == null) return ERR_INVALID_ARG;
  const seed = config.get("accounts");
  if (seed != null) {
    if (seed.kind != KIND_ARR) return ERR_INVALID_ARG;
    const rc = accounts.load(seed);
    if (rc < 0) return rc;
  }
  runtime.markBooted();
  return 0;
}

/** Add an account; returns its id (> 0) or a negative error code. */
export function account_add(json: string): i32 {
  const obj = parseJson(json);
  if (obj == null) return ERR_INVALID_ARG;
  const id = accounts.add(obj);
  if (id > 0) {
    const rec = accounts.get(id);
    if (rec != null) persistAccountUpsert(rec);
  }
  return id;
}

/** Replace an account's fields (id is preserved). 0 ok, <0 error. */
export function account_update(id: i32, json: string): i32 {
  const obj = parseJson(json);
  if (obj == null) return ERR_INVALID_ARG;
  const rc = accounts.update(id, obj);
  if (rc == 0) {
    const rec = accounts.get(id);
    if (rec != null) persistAccountUpsert(rec);
  }
  return rc;
}

/** Remove an account. 0 ok, <0 error. */
export function account_remove(id: i32): i32 {
  const rc = accounts.remove(id);
  if (rc == 0) {
    const eff = Json.emptyObj();
    eff.setStr("kind", "store.exec");
    eff.setStr("store", "registry");
    eff.setStr("sql", "DELETE FROM accounts WHERE id = ?");
    const params = Json.emptyArr();
    params.push(Json.ofInt(id));
    eff.set("params", params);
    runtime.emitDetached(eff);
  }
  return rc;
}

/**
 * Registry write for account mutations. The CLI (or any host) drains
 * these detached effects with its reactor right after the call; schema
 * lives in store/schema.ts.
 */
function persistAccountUpsert(rec: Json): void {
  const eff = Json.emptyObj();
  eff.setStr("kind", "store.exec");
  eff.setStr("store", "registry");
  eff.setStr(
    "sql",
    "INSERT INTO accounts (id, address, host, port, tls, \"user\", auth, password, setup_source, smtp_host, smtp_port, socket_type, smtp_socket_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET address = excluded.address, host = excluded.host, port = excluded.port, " +
      "tls = excluded.tls, \"user\" = excluded.\"user\", auth = excluded.auth, password = excluded.password, " +
      "setup_source = excluded.setup_source, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, " +
      "socket_type = excluded.socket_type, smtp_socket_type = excluded.smtp_socket_type",
  );
  const params = Json.emptyArr();
  params.push(Json.ofInt(rec.getInt("id", 0)));
  params.push(Json.ofStr(rec.getString("address", "")));
  params.push(Json.ofStr(rec.getString("host", "")));
  params.push(Json.ofInt(rec.getInt("port", 993)));
  params.push(Json.ofInt(rec.getBool("tls", true) ? 1 : 0));
  params.push(Json.ofStr(rec.getString("user", rec.getString("address", ""))));
  params.push(Json.ofStr(rec.getString("auth", "plain")));
  const pw = rec.getString("password", "");
  params.push(pw.length > 0 ? Json.ofStr(pw) : Json.nil());
  const source = rec.getString("setup_source", "");
  params.push(source.length > 0 ? Json.ofStr(source) : Json.nil());
  const smtpHost = rec.getString("smtp_host", "");
  params.push(smtpHost.length > 0 ? Json.ofStr(smtpHost) : Json.nil());
  const smtpPort = rec.getNum("smtp_port", 0);
  params.push(smtpPort > 0 ? Json.ofInt(<i64>smtpPort) : Json.nil());
  const socketType = rec.getString("socket_type", "");
  params.push(socketType.length > 0 ? Json.ofStr(socketType) : Json.nil());
  const smtpSocketType = rec.getString("smtp_socket_type", "");
  params.push(smtpSocketType.length > 0 ? Json.ofStr(smtpSocketType) : Json.nil());
  eff.set("params", params);
  runtime.emitDetached(eff);
}

/** JSON array of accounts. */
export function account_list(): string {
  return stringifyJson(accounts.list());
}

/** Start an op; returns its id (> 0) or a negative error code. */
export function op_start(kind: string, argsJson: string): i32 {
  return runtime.startOp(kind, argsJson);
}

/** Observe an op: {"state":"pending|done|error|cancelled","result":...,"error":...}. */
export function op_status(opId: i32): string {
  return runtime.status(opId);
}

/** Drain the effect queue (one drain per call). JSON array. */
export function op_effects(): string {
  return runtime.drainEffects();
}

/** Deliver a feed to the op that owns it. 0 ok (stale feeds discarded). */
export function op_feed(kind: string, dataJson: string): i32 {
  return runtime.feed(kind, dataJson);
}

/** Cancel a pending op. 0 ok, <0 error. */
export function op_cancel(opId: i32): i32 {
  return runtime.cancel(opId);
}
