// IMAP op sessions: connect / folders / sync / fetch. Each session runs
// the login flow from ImapSession, then drives its op to completion with
// tagged commands, untagged event collection, and store.exec effects
// (schema owned by core: store/schema.ts).

import { Json, KIND_ARR, KIND_NULL, KIND_NUM } from "../json/value.ts";
import { stringifyJson } from "../json/stringify.ts";
import { b64Encode } from "../encoding/base64.ts";
import { Op, OpFactory, Runtime } from "../runtime/ops.ts";
import { Accounts } from "../runtime/accounts.ts";
import { ERR_HOST, ERR_INVALID_ARG, ERR_NOT_FOUND, ERR_PROTOCOL } from "../runtime/errors.ts";
import { ImapSession } from "./client.ts";
import { EV_FETCH, EV_LIST, EV_SELECT, ImapEvent } from "./response.ts";
import { latin1 } from "./reader.ts";
import { parseMessage, firstAddress, addressList } from "../mime/parse.ts";
import { parseImapDate } from "../util/datetime.ts";
import { emitNamedQuery, emitSql } from "../store/handler.ts";

const BODY_BATCH: i32 = 100;

function flagsJson(flags: string[]): Json {
  const out = Json.emptyArr();
  for (let i = 0; i < flags.length; i++) out.push(Json.ofStr(flags[i]));
  return out;
}

function hasSeen(flags: string[]): bool {
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] == "\\Seen") return true;
  }
  return false;
}

function intStr(n: f64): string {
  return (<i64>n).toString();
}

function storeName(account: Json): string {
  return "account:" + account.getInt("id", 0).toString();
}

/** Upsert one message row (COALESCE preserves bodies across passes). */
function emitMessageUpsert(
  runtime: Runtime,
  op: Op,
  store: string,
  account: i32,
  folder: string,
  uid: i32,
  flags: Json,
  internaldate: Json,
  size: i32,
  headers: Json,
  subject: string,
  fromaddr: string,
  toaddr: string,
  threadKey: string,
  bodyText: Json,
  bodyHtml: Json,
  attachments: Json,
  raw: Json,
): i32 {
  const sql =
    "INSERT INTO messages (account, folder, uid, flags, internaldate, size, headers, subject, fromaddr, toaddr, thread_key, body_text, body_html, attachments, raw) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(account, folder, uid) DO UPDATE SET " +
    "flags = excluded.flags, " +
    "internaldate = COALESCE(excluded.internaldate, messages.internaldate), " +
    "size = COALESCE(excluded.size, messages.size), " +
    "headers = COALESCE(excluded.headers, messages.headers), " +
    "subject = COALESCE(excluded.subject, messages.subject), " +
    "fromaddr = COALESCE(excluded.fromaddr, messages.fromaddr), " +
    "toaddr = COALESCE(excluded.toaddr, messages.toaddr), " +
    "thread_key = COALESCE(excluded.thread_key, messages.thread_key), " +
    "body_text = COALESCE(excluded.body_text, messages.body_text), " +
    "body_html = COALESCE(excluded.body_html, messages.body_html), " +
    "attachments = COALESCE(excluded.attachments, messages.attachments), " +
    "raw = COALESCE(excluded.raw, messages.raw)";
  const params = Json.emptyArr();
  params.push(Json.ofInt(account));
  params.push(Json.ofStr(folder));
  params.push(Json.ofInt(uid));
  params.push(Json.ofStr(stringifyJson(flags)));
  params.push(internaldate);
  params.push(size >= 0 ? Json.ofInt(size) : Json.nil());
  params.push(Json.ofStr(stringifyJson(headers)));
  params.push(Json.ofStr(subject));
  params.push(Json.ofStr(fromaddr));
  params.push(Json.ofStr(toaddr));
  params.push(Json.ofStr(threadKey));
  params.push(bodyText);
  params.push(bodyHtml);
  params.push(attachments);
  params.push(raw);
  return emitSql(runtime, op, store, sql, params);
}

/**
 * Store a fully parsed FETCH response as a message row.
 *
 * The search index needs no explicit statement here: schema.ts declares
 * messages_fts_ai / _ad / _au, so the upsert below maintains the external-content
 * index itself. A hand-rolled DELETE + INSERT pair used to do this and was
 * wrong — a direct DELETE on an external-content table raises "database disk
 * image is malformed" for a rowid that is not yet in the index, which is the
 * normal first-store case (measured on SQLite 3.45.1 and 3.51.3). It only
 * appeared to work because the error was ignored and the INSERT alone populated
 * the index.
 */
function storeParsedMessage(
  runtime: Runtime,
  op: Op,
  store: string,
  account: i32,
  folder: string,
  ev: ImapEvent,
  addSeen: bool,
): i32 {
  if (ev.raw == null || ev.uid < 0) return -1;
  const rawBytes = ev.raw!;
  const raw = latin1(rawBytes);
  const msg = parseMessage(raw);
  const flags = flagsJson(ev.flags);
  if (addSeen && !hasSeen(ev.flags)) flags.push(Json.ofStr("\\Seen"));
  const internaldate = parseImapDate(ev.internalDate);
  const subject = msg.headers.getOr("subject", "");
  const fromaddr = firstAddress(msg.headersJson.get("from") != null ? msg.headersJson.get("from")! : Json.emptyArr());
  const toaddr = addressList(msg.headersJson.get("to") != null ? msg.headersJson.get("to")! : Json.emptyArr());
  return emitMessageUpsert(
    runtime,
    op,
    store,
    account,
    folder,
    ev.uid,
    flags,
    isNaN(internaldate) ? Json.nil() : Json.ofInt(<i64>internaldate),
    ev.size >= 0 ? ev.size : rawBytes.length,
    msg.headersJson,
    subject,
    fromaddr,
    toaddr,
    msg.threadKey,
    Json.ofStr(msg.bodyText),
    Json.ofStr(msg.bodyHtml),
    Json.ofStr(stringifyJson(msg.attachments)),
    Json.ofStr(b64Encode(rawBytes)),
  );
}

// ---------------------------------------------------------------------------
// imap.connect
// ---------------------------------------------------------------------------

class ConnectSession extends ImapSession {
  constructor(runtime: Runtime, op: Op, account: Json) {
    super(runtime, op, account);
  }

  protected onReady(): void {
    const out = Json.emptyObj();
    const caps = Json.emptyArr();
    for (let i = 0; i < this.capabilities.length; i++) caps.push(Json.ofStr(this.capabilities[i]));
    out.set("capabilities", caps);
    this.op.complete(out);
  }
}

// ---------------------------------------------------------------------------
// imap.folders
// ---------------------------------------------------------------------------

class FoldersSession extends ImapSession {
  listed: Json = Json.emptyArr();

  constructor(runtime: Runtime, op: Op, account: Json) {
    super(runtime, op, account);
  }

  protected onReady(): void {
    this.send("list", 'LIST "" "*"');
  }

  protected onUntagged(ev: ImapEvent): void {
    if (ev.kind != EV_LIST) return;
    const row = Json.emptyObj();
    row.setStr("path", ev.mailbox);
    row.setStr("name", ev.mailbox);
    row.setStr("delimiter", ev.delimiter);
    row.set("flags", flagsJson(ev.flags));
    this.listed.push(row);
  }

  protected onCommandTagged(name: string, ev: ImapEvent): void {
    if (name != "list") return;
    if (ev.status != "OK") {
      this.fail(ERR_PROTOCOL, "list", ev.text);
      return;
    }
    const store = storeName(this.account);
    const account = this.account.getInt("id", 0);
    for (let i = 0; i < this.listed.length; i++) {
      const row = this.listed.at(i)!;
      const params = Json.emptyArr();
      params.push(Json.ofInt(account));
      params.push(Json.ofStr(row.getString("path", "")));
      params.push(Json.ofStr(row.getString("name", "")));
      params.push(Json.ofStr(row.getString("delimiter", "")));
      params.push(Json.ofStr(stringifyJson(row.get("flags") != null ? row.get("flags")! : Json.emptyArr())));
      emitSql(
        this.runtime,
        this.op,
        store,
        "INSERT INTO folders (account, path, name, delimiter, flags) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(account, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter, flags = excluded.flags",
        params,
      );
    }
    const out = Json.emptyObj();
    out.set("folders", this.listed);
    this.op.complete(out);
  }
}

// ---------------------------------------------------------------------------
// imap.fetch — full source for one UID (marks \Seen locally)
// ---------------------------------------------------------------------------

class FetchSession extends ImapSession {
  folder: string = "";
  uid: i32 = -1;
  collected: ImapEvent[] = [];

  constructor(runtime: Runtime, op: Op, account: Json, folder: string, uid: i32) {
    super(runtime, op, account);
    this.folder = folder;
    this.uid = uid;
  }

  protected onReady(): void {
    const quoted = this.quote(this.folder);
    if (quoted.length == 0) {
      this.fail(ERR_INVALID_ARG, "folder", "invalid folder name");
      return;
    }
    this.send("select", "SELECT " + quoted);
  }

  protected onUntagged(ev: ImapEvent): void {
    if (ev.kind == EV_FETCH) this.collected.push(ev);
  }

  protected onCommandTagged(name: string, ev: ImapEvent): void {
    if (name == "select") {
      if (ev.status != "OK") {
        this.fail(ERR_PROTOCOL, "select", ev.text);
        return;
      }
      this.collected = [];
      this.send("fetchone", "UID FETCH " + this.uid.toString() + " (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])");
      return;
    }
    if (name != "fetchone") return;
    if (ev.status != "OK") {
      this.fail(ERR_PROTOCOL, "fetch", ev.text);
      return;
    }
    if (this.collected.length == 0) {
      this.fail(ERR_NOT_FOUND, "fetch", "uid " + this.uid.toString() + " not found");
      return;
    }
    const fetchEv = this.collected[0];
    const rawBytes = fetchEv.raw;
    if (rawBytes == null) {
      this.fail(ERR_PROTOCOL, "fetch", "missing BODY[] literal");
      return;
    }
    const store = storeName(this.account);
    const accountId = this.account.getInt("id", 0);
    storeParsedMessage(this.runtime, this.op, store, accountId, this.folder, fetchEv, true);

    const msg = parseMessage(latin1(rawBytes));
    const out = Json.emptyObj();
    out.setInt("uid", fetchEv.uid);
    out.set("flags", flagsJson(fetchEv.flags));
    if (!hasSeen(fetchEv.flags)) out.get("flags")!.push(Json.ofStr("\\Seen"));
    out.setStr("internalDate", fetchEv.internalDate);
    out.setInt("size", fetchEv.size >= 0 ? fetchEv.size : fetchEv.raw!.length);
    out.set("headers", msg.headersJson);
    out.set("structure", msg.structure);
    out.setStr("bodyText", msg.bodyText);
    out.setStr("bodyHtml", msg.bodyHtml);
    out.set("attachments", msg.attachments);
    out.setStr("threadKey", msg.threadKey);
    out.setStr("rawB64", b64Encode(fetchEv.raw!));
    this.op.complete(out);
  }
}

// ---------------------------------------------------------------------------
// imap.sync — LIST/SELECT, UIDVALIDITY resync, incremental UID fetch
// ---------------------------------------------------------------------------

class SyncSession extends ImapSession {
  store: string = "";
  accountId: i32 = 0;
  folderArg: string = "";
  folderQueue: string[] = [];
  listedPaths: string[] = [];
  results: Json = Json.emptyArr();
  currentFolder: string = "";
  uidValidity: f64 = -1;
  storedUv: f64 = -1;
  hasStoredUv: bool = false;
  lastSeen: f64 = 0;
  newUids: i32[] = [];
  bodyQueue: i32[] = [];
  collected: ImapEvent[] = [];
  awaitingMeta: bool = false;
  /** store.exec effects this op emitted that have not reported back yet. */
  pendingWrites: i32 = 0;
  /** The folder queue drained; finish once every write has reported. */
  finishWanted: bool = false;
  /** Progress the host can show: folders completed / total. */
  progressTotal: i32 = 0;
  progressDone: i32 = 0;

  constructor(runtime: Runtime, op: Op, account: Json, folderArg: string) {
    super(runtime, op, account);
    this.store = storeName(account);
    this.accountId = account.getInt("id", 0);
    this.folderArg = folderArg;
  }

  protected onReady(): void {
    if (this.folderArg.length > 0) {
      this.folderQueue.push(this.folderArg);
      this.progressTotal = 1;
      this.startNextFolder();
      return;
    }
    this.reportProgress("listing", "");
    this.send("list", 'LIST "" "*"');
  }

  /** Publish what this op is doing, so a host can show progress and a cancel. */
  private reportProgress(phase: string, folder: string): void {
    const p = Json.emptyObj();
    p.setStr("phase", phase);
    p.setStr("folder", folder);
    p.setInt("done", <i64>this.progressDone);
    p.setInt("total", <i64>this.progressTotal);
    this.op.setProgress(p);
  }

  protected onUntagged(ev: ImapEvent): void {
    if (ev.kind == EV_LIST) {
      this.listedPaths.push(ev.mailbox);
      return;
    }
    if (ev.kind == EV_FETCH) {
      this.collected.push(ev);
      return;
    }
    if (ev.kind == EV_SELECT && ev.code == "UIDVALIDITY") {
      this.uidValidity = ev.num;
    }
  }

  protected onStoreResult(data: Json): void {
    if (this.pendingWrites > 0) this.pendingWrites--;

    // ANY store failure fails the sync.
    //
    // This used to inspect only the folder_meta result and discard every
    // message write's result, so a failed write left the op reporting "done"
    // with the uids listed and nothing stored. Measured: two injected write
    // failures, state done, error null, newUids [1,2], 0 rows in messages.
    //
    // The reason it could not work before: the op completed on the last network
    // feed, BEFORE drive() executed the writes it had emitted, and Op.fail() is
    // a no-op once an op is done. Completion now waits for the writes.
    const err = data.get("error");
    if (err != null && err.kind != KIND_NULL) {
      this.fail(ERR_HOST, err.getString("where", "store"), err.getString("detail", "store error"));
      return;
    }
    if (!this.awaitingMeta) {
      this.maybeFinish();
      return;
    }
    this.awaitingMeta = false;
    const rows = data.get("rows");
    this.lastSeen = 0;
    this.hasStoredUv = false;
    this.storedUv = -1;
    if (rows != null && rows.kind == KIND_ARR && rows.length > 0) {
      const row = rows.at(0)!;
      this.lastSeen = row.getNum("last_seen_uid", 0);
      const uv = row.get("uidvalidity");
      if (uv != null && uv.kind == KIND_NUM) {
        this.storedUv = uv.numVal;
        this.hasStoredUv = true;
      }
    }
    const quoted = this.quote(this.currentFolder);
    if (quoted.length == 0) {
      this.fail(ERR_INVALID_ARG, "folder", "invalid folder name");
      return;
    }
    this.uidValidity = -1;
    this.send("select", "SELECT " + quoted);
  }

  protected onCommandTagged(name: string, ev: ImapEvent): void {
    if (ev.status != "OK") {
      this.fail(ERR_PROTOCOL, name, ev.text);
      return;
    }
    if (name == "list") {
      for (let i = 0; i < this.listedPaths.length; i++) this.folderQueue.push(this.listedPaths[i]);
      this.progressTotal = this.listedPaths.length;
      this.progressDone = 0;
      this.startNextFolder();
      return;
    }
    if (name == "select") {
      // UIDVALIDITY changed (or first sync) -> resync from uid 1
      if (!this.hasStoredUv || this.storedUv != this.uidValidity) this.lastSeen = 0;
      this.emitFolderMeta();
      this.collected = [];
      const start = this.lastSeen + 1;
      this.send(
        "uidmeta",
        "UID FETCH " + intStr(start) + ":* (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)",
      );
      return;
    }
    if (name == "uidmeta") {
      this.newUids = [];
      for (let i = 0; i < this.collected.length; i++) {
        const uid = this.collected[i].uid;
        if (uid > this.lastSeen && !contains(this.newUids, uid)) this.newUids.push(uid);
      }
      this.collected = [];
      if (this.newUids.length == 0) {
        this.finishFolder();
        return;
      }
      for (let i = 0; i < this.newUids.length; i++) this.bodyQueue.push(this.newUids[i]);
      this.sendBodyBatch();
      return;
    }
    if (name == "uidbody") {
      for (let i = 0; i < this.collected.length; i++) {
        this.track(storeParsedMessage(this.runtime, this.op, this.store, this.accountId, this.currentFolder, this.collected[i], false));
      }
      this.collected = [];
      if (this.bodyQueue.length > 0) {
        this.sendBodyBatch();
        return;
      }
      if (this.newUids.length > 0) {
        // Advance the cursor only if the rows it claims are actually there.
        //
        // This UPDATE is emitted the moment the writes are EMITTED, not
        // confirmed. Unguarded, a failed write still moved the cursor past the
        // message: the next sync began beyond it and the message was lost until
        // a full resync. Measured: two injected write failures, sync reported
        // "done" with newUids [1,2], 0 rows stored, last_seen_uid advanced to 2.
        //
        // The guard counts exactly the messages this run was responsible for
        // — uid in (lastSeen, maxUid] — so a short write leaves the cursor put
        // and the next sync re-fetches instead of skipping.
        const maxUid = maxOf(this.newUids);
        const params = Json.emptyArr();
        params.push(Json.ofStr(intStr(maxUid)));
        params.push(Json.ofInt(this.accountId));
        params.push(Json.ofStr(this.currentFolder));
        params.push(Json.ofInt(this.accountId));
        params.push(Json.ofStr(this.currentFolder));
        params.push(Json.ofInt(<i64>this.lastSeen));
        params.push(Json.ofInt(maxUid));
        params.push(Json.ofInt(this.newUids.length));
        this.track(emitSql(
          this.runtime,
          this.op,
          this.store,
          "UPDATE folders SET last_seen_uid = ? WHERE account = ? AND path = ? " +
            "AND (SELECT COUNT(*) FROM messages WHERE account = ? AND folder = ? AND uid > ? AND uid <= ?) = ?",
          params,
        ));
      }
      this.finishFolder();
    }
  }

  // -- helpers -------------------------------------------------------------

  /** Count a store.exec against completion. */
  private track(id: i32): void {
    if (id >= 0) this.pendingWrites++;
  }

  /** Complete once the queue is drained AND every write has reported back. */
  private maybeFinish(): void {
    if (!this.finishWanted || this.pendingWrites > 0) return;
    const out = Json.emptyObj();
    out.set("folders", this.results);
    this.op.complete(out);
  }

  private startNextFolder(): void {
    if (this.folderQueue.length == 0) {
      this.finishWanted = true;
      this.maybeFinish();
      return;
    }
    this.currentFolder = this.folderQueue[0];
    this.folderQueue.splice(0, 1);
    this.reportProgress("folder", this.currentFolder);
    this.uidValidity = -1;
    this.awaitingMeta = true;
    const args = Json.emptyObj();
    args.setNum("account", this.accountId);
    args.setStr("folder", this.currentFolder);
    this.track(emitNamedQuery(this.runtime, this.op, this.store, "folder_meta", args));
  }

  private emitFolderMeta(): void {
    const params = Json.emptyArr();
    params.push(Json.ofInt(this.accountId));
    params.push(Json.ofStr(this.currentFolder));
    params.push(Json.ofStr(this.currentFolder)); // name: path until LIST says otherwise
    params.push(this.uidValidity >= 0 ? Json.ofNum(this.uidValidity) : Json.nil());
    params.push(Json.ofNum(this.lastSeen));
    this.track(emitSql(
      this.runtime,
      this.op,
      this.store,
      "INSERT INTO folders (account, path, name, uidvalidity, last_seen_uid) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(account, path) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_seen_uid = excluded.last_seen_uid",
      params,
    ));
  }

  private sendBodyBatch(): void {
    const batch: i32[] = [];
    while (this.bodyQueue.length > 0 && batch.length < BODY_BATCH) {
      batch.push(this.bodyQueue[0]);
      this.bodyQueue.splice(0, 1);
    }
    let list = "";
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) list += ",";
      list += batch[i].toString();
    }
    this.collected = [];
    this.send("uidbody", "UID FETCH " + list + " (UID FLAGS INTERNALDATE BODY.PEEK[])");
  }

  protected finishFolder(): void {
    this.progressDone++;
    const res = Json.emptyObj();
    res.setStr("folder", this.currentFolder);
    const uids = Json.emptyArr();
    for (let i = 0; i < this.newUids.length; i++) uids.push(Json.ofInt(this.newUids[i]));
    res.set("newUids", uids);
    this.results.push(res);
    this.startNextFolder();
  }
}

function contains(list: i32[], v: i32): bool {
  for (let i = 0; i < list.length; i++) {
    if (list[i] == v) return true;
  }
  return false;
}

function maxOf(list: i32[]): i32 {
  let m = list[0];
  for (let i = 1; i < list.length; i++) {
    if (list[i] > m) m = list[i];
  }
  return m;
}

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

class ImapFactory implements OpFactory {
  runtime: Runtime;
  accounts: Accounts;

  constructor(runtime: Runtime, accounts: Accounts) {
    this.runtime = runtime;
    this.accounts = accounts;
  }

  protected make(_runtime: Runtime, _op: Op, _account: Json): ImapSession | null {
    return null;
  }

  create(args: Json, op: Op): ImapSession | null {
    const account = this.accounts.get(args.getInt("account", -1));
    if (account == null) return null;
    return this.make(this.runtime, op, account);
  }
}

export class ConnectFactory extends ImapFactory {
  protected make(runtime: Runtime, op: Op, account: Json): ImapSession {
    return new ConnectSession(runtime, op, account);
  }
}

export class FoldersFactory extends ImapFactory {
  protected make(runtime: Runtime, op: Op, account: Json): ImapSession {
    return new FoldersSession(runtime, op, account);
  }
}

export class SyncFactory extends ImapFactory {
  create(args: Json, op: Op): ImapSession | null {
    const account = this.accounts.get(args.getInt("account", -1));
    if (account == null) return null;
    return new SyncSession(this.runtime, op, account, args.getString("folder", ""));
  }
}

export class FetchFactory extends ImapFactory {
  create(args: Json, op: Op): ImapSession | null {
    const account = this.accounts.get(args.getInt("account", -1));
    if (account == null) return null;
    const folder = args.getString("folder", "");
    const uid = args.getInt("uid", -1);
    if (folder.length == 0 || uid < 0) return null;
    return new FetchSession(this.runtime, op, account, folder, uid);
  }
}
