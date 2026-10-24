// smtp.send op (M3): {account, envelope, rawB64} -> {messageId, ...}.
// The envelope carries the sender and every envelope recipient (to+cc+bcc
// flattened by the caller — the core does not re-parse headers for the
// envelope). Raw bytes are the exact message to transmit; dot-stuffing
// and CRLF discipline happen in the session.

import { Json, KIND_ARR } from "../json/value.ts";
import { b64Decode } from "../encoding/base64.ts";
import { Op, OpFactory, Runtime } from "../runtime/ops.ts";
import { Accounts } from "../runtime/accounts.ts";
import { SmtpSession } from "./session.ts";

/** Collect envelope recipient strings (deduped, order kept). */
function envelopeRecipients(envelope: Json): string[] {
  const out: string[] = [];
  const lists = ["to", "cc", "bcc"];
  for (let li = 0; li < lists.length; li++) {
    const arr = envelope.get(lists[li]);
    if (arr == null || arr.kind != KIND_ARR) continue;
    for (let i = 0; i < arr.length; i++) {
      const item = arr.at(i);
      if (item == null) continue;
      let address = "";
      if (item.kind == 3 /* KIND_STR */) {
        const direct = item.strVal;
        address = direct == null ? "" : direct;
      } else address = item.getString("address", "");
      if (address.length == 0 || address.indexOf("@") < 0) continue;
      let seen = false;
      for (let j = 0; j < out.length; j++) {
        if (out[j].toLowerCase() == address.toLowerCase()) seen = true;
      }
      if (!seen) out.push(address);
    }
  }
  return out;
}

export class SmtpSendFactory implements OpFactory {
  runtime: Runtime;
  accounts: Accounts;

  constructor(runtime: Runtime, accounts: Accounts) {
    this.runtime = runtime;
    this.accounts = accounts;
  }

  create(args: Json, op: Op): SmtpSession | null {
    const account = this.accounts.get(args.getInt("account", -1));
    if (account == null) return null;
    const envelope = args.get("envelope");
    if (envelope == null) return null;
    const from = envelope.getString("from", "");
    if (from.length == 0 || from.indexOf("@") < 0) return null;
    const recipients = envelopeRecipients(envelope);
    if (recipients.length == 0) return null;
    const rawB64 = args.getString("rawB64", "");
    const rawBytes = b64Decode(rawB64);
    if (rawBytes == null) return null;
    // raw crosses as base64; the session treats it as byte-per-char text
    let raw = "";
    for (let i = 0; i < rawBytes.length; i++) raw += String.fromCharCode(rawBytes[i]);
    return new SmtpSession(this.runtime, op, account, from, recipients, raw);
  }
}
