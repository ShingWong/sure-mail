// imap.append op (M3): {account, folder, rawB64, flags?} -> {uid, ...}.
// APPEND is a synchronizing-literal command (RFC 3502): the client sends
// `TAG APPEND "folder" [(flags)] {size}`, waits for the server's '+'
// continuation, then flushes the literal bytes. The new UID comes from
// the [APPENDUID uidvalidity uid] response code (RFC 4315) when the
// server offers it; otherwise uid is -1 and the caller can resync.

import { Json, KIND_ARR, KIND_STR } from "../json/value.ts";
import { b64Decode } from "../encoding/base64.ts";
import { Op, OpFactory, Runtime } from "../runtime/ops.ts";
import { Accounts } from "../runtime/accounts.ts";
import { ERR_INVALID_ARG, ERR_PROTOCOL } from "../runtime/errors.ts";
import { ImapSession } from "../imap/client.ts";
import { EV_SELECT, ImapEvent } from "../imap/response.ts";

const SYSTEM_FLAGS: string[] = ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"];

class AppendSession extends ImapSession {
  folder: string = "";
  flags: string[] = [];
  payload: Uint8Array = new Uint8Array(0);
  appendUv: f64 = -1;
  sawContinuation: bool = false;

  constructor(runtime: Runtime, op: Op, account: Json, folder: string, flags: string[], payload: Uint8Array) {
    super(runtime, op, account);
    this.folder = folder;
    this.flags = flags;
    this.payload = payload;
  }

  protected onContinuation(): void {
    this.sawContinuation = true;
  }

  protected onReady(): void {
    const quoted = this.quote(this.folder);
    if (quoted.length == 0) {
      this.fail(ERR_INVALID_ARG, "folder", "invalid folder name");
      return;
    }
    let cmd = "APPEND " + quoted;
    if (this.flags.length > 0) {
      let flagList = "";
      for (let i = 0; i < this.flags.length; i++) {
        if (i > 0) flagList += " ";
        flagList += this.flags[i];
      }
      cmd += " (" + flagList + ")";
    }
    cmd += " {" + this.payload.length.toString() + "}";
    this.sendWithLiteral("append", cmd, this.payload);
  }

  protected onUntagged(ev: ImapEvent): void {
    // some servers surface APPENDUID on an untagged OK before the tagged one
    if (ev.kind == EV_SELECT && ev.code == "APPENDUID" && this.appendUv < 0) {
      this.appendUv = ev.num;
    }
  }

  protected onCommandTagged(name: string, ev: ImapEvent): void {
    if (name != "append") return;
    if (ev.status != "OK") {
      this.fail(ERR_PROTOCOL, "append", ev.text);
      return;
    }
    if (ev.code == "APPENDUID") this.appendUv = ev.num;
    const out = Json.emptyObj();
    out.setInt("uid", ev.uid >= 0 ? ev.uid : -1);
    if (this.appendUv >= 0) out.setInt("uidValidity", <i64>this.appendUv);
    out.setBool("literalAccepted", this.sawContinuation);
    this.op.complete(out);
  }
}

/**
 * Flags must be known system flags (canonical casing) or $keywords —
 * anything else is dropped rather than risking a malformed command.
 */
function sanitizeFlags(flags: Json | null): string[] {
  const out: string[] = [];
  if (flags == null || flags.kind != KIND_ARR) return out;
  for (let i = 0; i < flags.length && out.length < 16; i++) {
    const f = flags.at(i);
    if (f == null || f.kind != KIND_STR) continue;
    const raw = f.strVal;
    if (raw == null || raw.length == 0) continue;
    const text = raw;
    if (text.charCodeAt(0) == 36) {
      out.push(text); // $keyword as given
      continue;
    }
    const low = text.toLowerCase();
    for (let p = 0; p < SYSTEM_FLAGS.length; p++) {
      if (low == SYSTEM_FLAGS[p].toLowerCase()) {
        out.push(SYSTEM_FLAGS[p]);
        break;
      }
    }
  }
  return out;
}

export class AppendFactory implements OpFactory {
  runtime: Runtime;
  accounts: Accounts;

  constructor(runtime: Runtime, accounts: Accounts) {
    this.runtime = runtime;
    this.accounts = accounts;
  }

  create(args: Json, op: Op): AppendSession | null {
    const account = this.accounts.get(args.getInt("account", -1));
    if (account == null) return null;
    const folder = args.getString("folder", "");
    if (folder.length == 0) return null;
    const rawBytes = b64Decode(args.getString("rawB64", ""));
    if (rawBytes == null) return null;
    const flags = sanitizeFlags(args.get("flags"));
    return new AppendSession(this.runtime, op, account, folder, flags, rawBytes);
  }
}
