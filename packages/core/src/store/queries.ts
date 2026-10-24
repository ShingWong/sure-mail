// Named store queries: the CLI and IMAP handlers never invent SQL — they
// pick a query by name and the core owns the statement. Writes are emitted
// directly by the handlers (schema.ts is the single schema source).

import { FTS_SEARCH_SQL } from "./fts.generated";
import { Json } from "../json/value.ts";

class Query {
  sql: string = "";
  params: Json = Json.emptyArr();

  constructor(sql: string, params: Json) {
    this.sql = sql;
    this.params = params;
  }
}

function p(): Json {
  return Json.emptyArr();
}

function arr1(a: Json): Json {
  const out = Json.emptyArr();
  out.push(a);
  return out;
}

function arr2(a: Json, b: Json): Json {
  const out = Json.emptyArr();
  out.push(a);
  out.push(b);
  return out;
}

function arr3(a: Json, b: Json, c: Json): Json {
  const out = Json.emptyArr();
  out.push(a);
  out.push(b);
  out.push(c);
  return out;
}

/** Resolve a named query; null when the name or args are invalid. */
export function namedQuery(name: string, args: Json): Query | null {
  if (name == "accounts") {
    return new Query(
      'SELECT id, address, host, port, tls, "user", auth, password, setup_source, smtp_host, smtp_port, socket_type, smtp_socket_type FROM accounts ORDER BY id',
      p(),
    );
  }
  if (name == "folders") {
    const account = args.getNum("account", -1);
    if (account < 0) return null;
    return new Query(
      "SELECT path, name, delimiter, flags, uidvalidity, last_seen_uid FROM folders WHERE account = ? ORDER BY path",
      arr1(Json.ofInt(<i64>account)),
    );
  }
  if (name == "folder_meta") {
    const account = args.getNum("account", -1);
    const folder = args.getString("folder", "");
    if (account < 0 || folder.length == 0) return null;
    return new Query(
      "SELECT uidvalidity, last_seen_uid FROM folders WHERE account = ? AND path = ?",
      arr2(Json.ofInt(<i64>account), Json.ofStr(folder)),
    );
  }
  if (name == "messages") {
    const account = args.getNum("account", -1);
    const folder = args.getString("folder", "");
    if (account < 0 || folder.length == 0) return null;
    const limit = <i32>args.getNum("limit", 50);
    const unread = args.getBool("unread", false);
    const sql = unread
      ? "SELECT uid, flags, internaldate, size, subject, fromaddr FROM messages WHERE account = ? AND folder = ? AND flags NOT LIKE '%\\Seen%' ORDER BY uid DESC LIMIT ?"
      : "SELECT uid, flags, internaldate, size, subject, fromaddr FROM messages WHERE account = ? AND folder = ? ORDER BY uid DESC LIMIT ?";
    return new Query(sql, arr3(Json.ofInt(<i64>account), Json.ofStr(folder), Json.ofInt(<i64>limit)));
  }
  if (name == "message") {
    const account = args.getNum("account", -1);
    const folder = args.getString("folder", "");
    const uid = args.getNum("uid", -1);
    if (account < 0 || folder.length == 0 || uid < 0) return null;
    return new Query(
      "SELECT uid, flags, internaldate, size, headers, subject, fromaddr, toaddr, thread_key, body_text, body_html, attachments, raw FROM messages WHERE account = ? AND folder = ? AND uid = ?",
      arr3(Json.ofInt(<i64>account), Json.ofStr(folder), Json.ofInt(<i64>uid)),
    );
  }
  if (name == "search") {
    const q = args.getString("q", "");
    if (q.length == 0) return null;
    const limit = <i32>args.getNum("limit", 50);
    // Quote every whitespace-delimited term so FTS5 metacharacters in
    // user input cannot break the MATCH expression.
    let match = "";
    let i = 0;
    while (i < q.length) {
      while (i < q.length && (q.charCodeAt(i) == 32 || q.charCodeAt(i) == 9)) i++;
      let end = i;
      let term = "";
      while (end < q.length && q.charCodeAt(end) != 32 && q.charCodeAt(end) != 9) {
        const c = q.charAt(end);
        if (c != "\"") term += c; // quotes would break the FTS phrase
        end++;
      }
      if (term.length > 0) {
        if (match.length > 0) match += " ";
        match += '"' + term + '"';
      }
      i = end;
    }
    if (match.length == 0) return null;
    return new Query(
      FTS_SEARCH_SQL,
      arr2(Json.ofStr(match), Json.ofInt(<i64>limit)),
    );
  }
  // -- drafts + send audit (M3, schema v3) ----------------------------------
  if (name == "drafts") {
    const account = args.getNum("account", -1);
    if (account < 0) return null;
    const limit = <i32>args.getNum("limit", 100);
    const status = args.getString("status", "");
    if (status.length > 0) {
      return new Query(
        "SELECT id, subject, fromaddr, toaddrs, ccaddrs, bccaddrs, status, message_id, sent_at, created_at, updated_at FROM drafts WHERE account = ? AND status = ? ORDER BY updated_at DESC LIMIT ?",
        arr3(Json.ofInt(<i64>account), Json.ofStr(status), Json.ofInt(<i64>limit)),
      );
    }
    return new Query(
      "SELECT id, subject, fromaddr, toaddrs, ccaddrs, bccaddrs, status, message_id, sent_at, created_at, updated_at FROM drafts WHERE account = ? ORDER BY updated_at DESC LIMIT ?",
      arr2(Json.ofInt(<i64>account), Json.ofInt(<i64>limit)),
    );
  }
  if (name == "draft") {
    const account = args.getNum("account", -1);
    const id = args.getNum("id", -1);
    if (account < 0 || id < 0) return null;
    return new Query(
      "SELECT id, account, subject, fromaddr, toaddrs, ccaddrs, bccaddrs, body_text, body_html, attachments, in_reply_to, references_hdr, status, message_id, sent_at, sent_folder, sent_uid, created_at, updated_at FROM drafts WHERE account = ? AND id = ?",
      arr2(Json.ofInt(<i64>account), Json.ofInt(<i64>id)),
    );
  }
  if (name == "draft_save") {
    // INSERT (no id) or UPDATE (id given) — returns the draft id.
    const account = args.getNum("account", -1);
    if (account < 0) return null;
    const id = args.getNum("id", -1);
    const subject = args.getString("subject", "");
    const fromaddr = args.getString("fromaddr", "");
    const toaddrs = args.getString("toaddrs", "[]");
    const ccaddrs = args.getString("ccaddrs", "[]");
    const bccaddrs = args.getString("bccaddrs", "[]");
    const bodyText = args.getString("body_text", "");
    const bodyHtml = args.getString("body_html", "");
    const attachments = args.getString("attachments", "[]");
    const inReplyTo = args.getString("in_reply_to", "");
    const referencesHdr = args.getString("references_hdr", "");
    const now = <i64>args.getNum("now", 0);
    if (id < 0) {
      const params = Json.emptyArr();
      params.push(Json.ofInt(<i64>account));
      params.push(Json.ofStr(subject));
      params.push(Json.ofStr(fromaddr));
      params.push(Json.ofStr(toaddrs));
      params.push(Json.ofStr(ccaddrs));
      params.push(Json.ofStr(bccaddrs));
      params.push(Json.ofStr(bodyText));
      params.push(Json.ofStr(bodyHtml));
      params.push(Json.ofStr(attachments));
      params.push(inReplyTo.length > 0 ? Json.ofStr(inReplyTo) : Json.nil());
      params.push(referencesHdr.length > 0 ? Json.ofStr(referencesHdr) : Json.nil());
      params.push(Json.ofInt(now));
      params.push(Json.ofInt(now));
      return new Query(
        "INSERT INTO drafts (account, subject, fromaddr, toaddrs, ccaddrs, bccaddrs, body_text, body_html, attachments, in_reply_to, references_hdr, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params,
      );
    }
    const params = Json.emptyArr();
    params.push(Json.ofStr(subject));
    params.push(Json.ofStr(toaddrs));
    params.push(Json.ofStr(ccaddrs));
    params.push(Json.ofStr(bccaddrs));
    params.push(Json.ofStr(bodyText));
    params.push(Json.ofStr(bodyHtml));
    params.push(Json.ofStr(attachments));
    params.push(inReplyTo.length > 0 ? Json.ofStr(inReplyTo) : Json.nil());
    params.push(referencesHdr.length > 0 ? Json.ofStr(referencesHdr) : Json.nil());
    params.push(Json.ofInt(now));
    params.push(Json.ofInt(<i64>account));
    params.push(Json.ofInt(<i64>id));
    return new Query(
      "UPDATE drafts SET subject = ?, toaddrs = ?, ccaddrs = ?, bccaddrs = ?, body_text = ?, body_html = ?, attachments = ?, in_reply_to = ?, references_hdr = ?, updated_at = ? WHERE account = ? AND id = ?",
      params,
    );
  }
  if (name == "draft_mark_sent") {
    // A send succeeded: flip the draft to 'sent' with its delivery record.
    const account = args.getNum("account", -1);
    const id = args.getNum("id", -1);
    const sentAt = <i64>args.getNum("sent_at", 0);
    if (account < 0 || id < 0) return null;
    const messageId = args.getString("message_id", "");
    const sentFolder = args.getString("sent_folder", "");
    const sentUid = args.getNum("sent_uid", -1);
    const params = Json.emptyArr();
    params.push(Json.ofStr("sent"));
    params.push(messageId.length > 0 ? Json.ofStr(messageId) : Json.nil());
    params.push(Json.ofInt(sentAt));
    params.push(sentFolder.length > 0 ? Json.ofStr(sentFolder) : Json.nil());
    params.push(sentUid >= 0 ? Json.ofInt(<i64>sentUid) : Json.nil());
    params.push(Json.ofInt(sentAt)); // updated_at follows the send too
    params.push(Json.ofInt(<i64>account));
    params.push(Json.ofInt(<i64>id));
    return new Query(
      "UPDATE drafts SET status = ?, message_id = ?, sent_at = ?, sent_folder = ?, sent_uid = ?, updated_at = ? WHERE account = ? AND id = ?",
      params,
    );
  }
  if (name == "draft_delete") {
    const account = args.getNum("account", -1);
    const id = args.getNum("id", -1);
    if (account < 0 || id < 0) return null;
    return new Query(
      "DELETE FROM drafts WHERE account = ? AND id = ?",
      arr2(Json.ofInt(<i64>account), Json.ofInt(<i64>id)),
    );
  }
  if (name == "sent_audit") {
    // Audit row for one successful send (M3 doc: audit trail of sends).
    const account = args.getNum("account", -1);
    if (account < 0) return null;
    const messageId = args.getString("message_id", "");
    const envelope = args.getString("envelope", "{}");
    const subject = args.getString("subject", "");
    const size = <i64>args.getNum("size", 0);
    const queueId = args.getString("queue_id", "");
    const appended = args.getBool("appended", false);
    const sentFolder = args.getString("sent_folder", "");
    const sentUid = args.getNum("sent_uid", -1);
    const sentAt = <i64>args.getNum("sent_at", 0);
    const params = Json.emptyArr();
    params.push(Json.ofInt(<i64>account));
    params.push(messageId.length > 0 ? Json.ofStr(messageId) : Json.nil());
    params.push(Json.ofStr(envelope));
    params.push(Json.ofStr(subject));
    params.push(Json.ofInt(size));
    params.push(queueId.length > 0 ? Json.ofStr(queueId) : Json.nil());
    params.push(appended ? Json.ofInt(1) : Json.ofInt(0));
    params.push(sentFolder.length > 0 ? Json.ofStr(sentFolder) : Json.nil());
    params.push(sentUid >= 0 ? Json.ofInt(<i64>sentUid) : Json.nil());
    params.push(Json.ofInt(sentAt));
    return new Query(
      "INSERT INTO sent_messages (account, message_id, envelope, subject, size, queue_id, appended, sent_folder, sent_uid, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      params,
    );
  }
  if (name == "sent_messages") {
    const account = args.getNum("account", -1);
    if (account < 0) return null;
    const limit = <i32>args.getNum("limit", 50);
    return new Query(
      "SELECT id, message_id, envelope, subject, size, queue_id, appended, sent_folder, sent_uid, sent_at FROM sent_messages WHERE account = ? ORDER BY sent_at DESC LIMIT ?",
      arr2(Json.ofInt(<i64>account), Json.ofInt(<i64>limit)),
    );
  }
  return null;
}
