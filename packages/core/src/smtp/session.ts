// SMTP session (D5/D13: password auth over TLS only). Drives one send:
// greeting -> EHLO (capability negotiation, HELO fallback) -> [STARTTLS ->
// upgrade -> re-EHLO when the account transport is starttls] -> AUTH
// PLAIN/LOGIN -> MAIL FROM -> RCPT TO (per-recipient results) -> DATA
// (dot-stuffing) -> final 250 with queue-id capture -> QUIT. Implicit TLS
// (handshake on connect) is the unchanged default. Feed-driven like
// ImapSession: bytes in via net.data feeds, effects out via the runtime.

import { Json } from "../json/value.ts";
import { b64Decode, b64Encode } from "../encoding/base64.ts";
import { unlatain } from "../imap/reader.ts";
import { Op, OpHandler, OP_PENDING, Runtime } from "../runtime/ops.ts";
import { ERR_HOST, ERR_INVALID_ARG, ERR_PROTOCOL, ERR_UNSUPPORTED } from "../runtime/errors.ts";
import { TRANSPORT_STARTTLS, TRANSPORT_TLS, transportMode } from "../runtime/transport.ts";
import { SmtpReply, SmtpReplyReader } from "./reply.ts";

export const SMTP_SIZE_DEFAULT: i32 = 1024 * 1024; // assume 1 MiB when no SIZE cap

/** Dot-stuff and CRLF-normalize a raw message for the DATA phase. */
export function dotStuff(raw: string): string {
  // normalize to CRLF first
  let normalized = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c == 13) {
      if (i + 1 < raw.length && raw.charCodeAt(i + 1) == 10) i++;
      normalized += "\r\n";
    } else if (c == 10) normalized += "\r\n";
    else normalized += raw.charAt(i);
  }
  // ensure trailing CRLF before the terminator
  if (!normalized.endsWith("\r\n")) normalized += "\r\n";
  // dot-stuff any line beginning with '.'
  let out = "";
  let i = 0;
  while (i < normalized.length) {
    const atLineStart = i == 0 || normalized.charCodeAt(i - 1) == 10;
    if (atLineStart && normalized.charCodeAt(i) == 46) out += ".";
    const nl = normalized.indexOf("\n", i);
    if (nl < 0) {
      out += normalized.substring(i);
      break;
    }
    out += normalized.substring(i, nl + 1);
    i = nl + 1;
  }
  return out;
}

/** Result row for one envelope recipient. */
function recipientRow(address: string, code: i32, detail: string): Json {
  const row = Json.emptyObj();
  row.setStr("address", address);
  row.setInt("code", <i64>code);
  row.setBool("accepted", code >= 200 && code < 300);
  row.setStr("detail", detail);
  return row;
}

/** Best-effort queue id from a final "250 ..." reply. */
function queueIdOf(reply: SmtpReply): string {
  // Postfix: "250 2.0.0 Ok: queued as ABC123"; sendmail-ish: "250 Ok, queued as ..."
  for (let li = 0; li < reply.lines.length; li++) {
    const line = reply.lines[li];
    const low = line.toLowerCase();
    const marker = low.indexOf("queued as ");
    if (marker >= 0) {
      let id = line.substring(marker + 10).trim();
      const sp = indexOfSpace(id);
      if (sp > 0) id = id.substring(0, sp);
      if (id.length > 0) return id;
    }
    const idMarker = low.indexOf("id=");
    if (idMarker >= 0) {
      let id = line.substring(idMarker + 3).trim();
      const sp = indexOfSpace(id);
      if (sp > 0) id = id.substring(0, sp);
      if (id.length > 0) return id;
    }
  }
  return "";
}

function indexOfSpace(s: string): i32 {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 32 || c == 9) return i;
  }
  return -1;
}

function parsePositiveInt(s: string): i32 {
  let n: i64 = 0;
  if (s.length == 0) return 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return 0;
    n = n * 10 + (c - 48);
    if (n > 2147483647) return 0;
  }
  return <i32>n;
}

type Phase =
  i32; // 0 greeting, 1 ehlo, 2 helo, 3 auth, 4 auth-cont, 5 mail, 6 rcpt, 7 data-accept, 8 data-reply, 9 quit, 10 done, 11 starttls

const PH_GREETING: i32 = 0;
const PH_EHLO: i32 = 1;
const PH_HELO: i32 = 2;
const PH_AUTH: i32 = 3;
const PH_AUTH_CONT: i32 = 4;
const PH_MAIL: i32 = 5;
const PH_RCPT: i32 = 6;
const PH_DATA_ACCEPT: i32 = 7;
const PH_DATA_REPLY: i32 = 8;
const PH_QUIT: i32 = 9;
const PH_DONE: i32 = 10;
const PH_STARTTLS: i32 = 11;

export class SmtpSession implements OpHandler {
  runtime: Runtime;
  op: Op;
  transport: string = "";
  reader: SmtpReplyReader = new SmtpReplyReader();
  account: Json;
  from: string = "";
  recipients: string[] = [];
  raw: string = ""; // byte-per-char message text
  rawSize: i32 = 0;

  capabilities: string[] = []; // EHLO keywords (AUTH, SIZE, PIPELINING, ...)
  authMechanisms: string[] = [];
  serverSizeLimit: i32 = -1; // SIZE parameter when advertised
  pipelining: bool = false;

  phase: Phase = PH_GREETING;
  rcptIndex: i32 = 0;
  rcptResults: Json = Json.emptyArr();
  queueId: string = "";
  /** "tls" (implicit) | "starttls" | "plain" — the account's SMTP transport. */
  socketType: string = TRANSPORT_TLS;
  upgraded: bool = false;
  private upgrading: bool = false;
  private greeted: bool = false;

  /** Best-effort SMTP host from an IMAP host ("imap.x" -> "smtp.x"). */
  static deriveSmtpHost(imapHost: string): string {
    if (imapHost.length == 0) return "";
    if (imapHost.startsWith("imap.")) return "smtp." + imapHost.substring(5);
    return imapHost;
  }

  constructor(runtime: Runtime, op: Op, account: Json, from: string, recipients: string[], raw: string) {
    this.runtime = runtime;
    this.op = op;
    this.account = account;
    this.from = from;
    this.recipients = recipients;
    this.raw = raw;
    this.rawSize = raw.length;
    const host = account.getString("smtp_host", SmtpSession.deriveSmtpHost(account.getString("host", "")));
    const port = <i32>account.getNum("smtp_port", 465);
    // D13: the SMTP endpoint's transport is `smtp_socket_type` (falling back
    // to the legacy tls boolean / in-memory smtp_tls override). STARTTLS
    // and plaintext connect in the clear; implicit TLS handshakes on connect.
    const mode = transportMode(account, true);
    this.socketType = mode;
    if (host.length == 0) {
      this.transport = "";
      op.fail(ERR_INVALID_ARG, "account", "missing smtp host");
    } else if (recipients.length == 0) {
      this.transport = "";
      op.fail(ERR_INVALID_ARG, "envelope", "no recipients");
    } else {
      this.transport = runtime.openTransport(op, host, port, mode == TRANSPORT_TLS);
    }
  }

  // -- OpHandler -----------------------------------------------------------

  onFeed(_op: Op, kind: string, data: Json): i32 {
    if (kind == "net.data") {
      const b64 = data.getString("b64", "");
      const bytes = b64Decode(b64);
      if (bytes != null) this.reader.feed(bytes);
      this.pump();
      return 0;
    }
    if (kind == "net.opened") return 0;
    if (kind == "net.upgraded") {
      // STARTTLS done: capabilities may have changed, so re-EHLO (which
      // re-parses AUTH/SIZE/PIPELINING) before authenticating.
      this.upgraded = true;
      this.upgrading = false;
      this.capabilities = [];
      this.authMechanisms = [];
      this.serverSizeLimit = -1;
      this.pipelining = false;
      this.write("EHLO " + this.clientDomain() + "\r\n");
      this.phase = PH_EHLO;
      return 0;
    }
    if (kind == "net.error") {
      const detail = data.getString("error", "unknown net error");
      this.fail(ERR_HOST, this.upgrading ? "starttls" : "net", detail);
      return 0;
    }
    if (kind == "net.eof") {
      this.fail(ERR_PROTOCOL, "net", "connection closed by server");
      return 0;
    }
    return 0;
  }

  onCancel(_op: Op): void {
    this.closeTransport();
  }

  // -- plumbing ------------------------------------------------------------

  private write(text: string): void {
    const eff = Json.emptyObj();
    eff.setStr("kind", "net.write");
    eff.setStr("transport", this.transport);
    eff.setStr("b64", b64Encode(unlatain(text)));
    this.runtime.emitEffect(this.op, eff);
  }

  private closeTransport(): void {
    if (this.transport.length == 0) return;
    const eff = Json.emptyObj();
    eff.setStr("kind", "net.close");
    eff.setStr("transport", this.transport);
    this.runtime.emitEffect(this.op, eff);
    this.transport = "";
  }

  private fail(code: i32, where: string, detail: string): void {
    this.phase = PH_DONE;
    this.closeTransport();
    this.op.fail(code, where, detail);
  }

  private pump(): void {
    for (;;) {
      const reply = this.reader.next();
      if (reply == null) return;
      this.dispatch(reply);
      if (this.op.state != OP_PENDING || this.phase == PH_DONE) return;
    }
  }

  /** "SMTP <code> <text>" — the detail string every failure carries. */
  private static replyDetail(reply: SmtpReply): string {
    let detail = "SMTP " + reply.code.toString();
    // text usually begins with the enhanced code itself; only add ours
    // when the server did not print it.
    const text = reply.text;
    if (reply.enhanced.length > 0 && !text.startsWith(reply.enhanced)) {
      detail += " " + reply.enhanced;
    }
    if (text.length > 0) detail += " " + text;
    return detail;
  }

  private dispatch(reply: SmtpReply): void {
    if (!this.greeted) {
      this.greeted = true;
      if (reply.code != 220) {
        this.fail(ERR_HOST, "greeting", SmtpSession.replyDetail(reply));
        return;
      }
      this.write("EHLO " + this.clientDomain() + "\r\n");
      this.phase = PH_EHLO;
      return;
    }
    switch (this.phase) {
      case PH_EHLO: {
        if (reply.code == 250) {
          this.parseCapabilities(reply);
          if (this.socketType == TRANSPORT_STARTTLS && !this.upgraded) {
            // STARTTLS is mandatory in this mode: no plaintext auth fallback.
            if (!this.hasCapability("STARTTLS")) {
              this.fail(ERR_UNSUPPORTED, "starttls", "server does not advertise STARTTLS");
              return;
            }
            this.write("STARTTLS\r\n");
            this.phase = PH_STARTTLS;
            return;
          }
          this.afterCaps();
          return;
        }
        if (reply.code >= 500) {
          if (this.socketType == TRANSPORT_STARTTLS) {
            // Without EHLO the server cannot advertise STARTTLS.
            this.fail(ERR_HOST, "starttls", "EHLO refused; cannot negotiate STARTTLS");
            return;
          }
          // EHLO unsupported: HELO fallback (no capabilities, plain auth
          // attempt still allowed by servers that accept it silently).
          this.write("HELO " + this.clientDomain() + "\r\n");
          this.phase = PH_HELO;
          return;
        }
        this.fail(ERR_HOST, "ehlo", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_STARTTLS: {
        if (reply.code == 220) {
          this.upgrading = true;
          const eff = Json.emptyObj();
          eff.setStr("kind", "net.upgrade");
          eff.setStr("transport", this.transport);
          this.runtime.emitEffect(this.op, eff);
          return;
        }
        this.fail(ERR_HOST, "starttls", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_HELO: {
        if (reply.code != 250) {
          this.fail(ERR_HOST, "ehlo", SmtpSession.replyDetail(reply));
          return;
        }
        // no capability knowledge: try AUTH PLAIN anyway
        this.afterCaps();
        return;
      }
      case PH_AUTH: {
        if (reply.code == 235 || reply.code == 234) {
          if (reply.code == 234) {
            // AUTH LOGIN username step
            this.write(b64Encode(unlatain(this.user())) + "\r\n");
            this.phase = PH_AUTH_CONT;
            return;
          }
          this.sendMailFrom();
          return;
        }
        if (reply.code == 334) {
          // AUTH LOGIN username prompt (RFC 4954 challenge)
          if (this.authMethod() == "login") {
            this.write(b64Encode(unlatain(this.user())) + "\r\n");
            this.phase = PH_AUTH_CONT;
            return;
          }
          // PLAIN already sent its initial response with the command —
          // a challenge here is a protocol violation.
          this.fail(ERR_PROTOCOL, "auth", SmtpSession.replyDetail(reply));
          return;
        }
        if (reply.code >= 500) {
          this.fail(ERR_HOST, "auth", SmtpSession.replyDetail(reply));
          return;
        }
        this.fail(ERR_PROTOCOL, "auth", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_AUTH_CONT: {
        if (reply.code == 334) {
          // LOGIN password step
          this.write(b64Encode(unlatain(this.password())) + "\r\n");
          return;
        }
        if (reply.code == 235) {
          this.sendMailFrom();
          return;
        }
        this.fail(ERR_HOST, "auth", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_MAIL: {
        if (reply.code == 250) {
          this.rcptIndex = 0;
          this.sendNextRcpt();
          return;
        }
        if (reply.code == 552) {
          this.fail(ERR_HOST, "mail-from", "size exceeded: " + SmtpSession.replyDetail(reply));
          return;
        }
        this.fail(ERR_HOST, "mail-from", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_RCPT: {
        this.rcptResults.push(recipientRow(this.recipients[this.rcptIndex], reply.code, reply.text));
        this.rcptIndex++;
        if (this.rcptIndex < this.recipients.length) {
          this.sendNextRcpt();
          return;
        }
        this.finishRcpts();
        return;
      }
      case PH_DATA_ACCEPT: {
        if (reply.code == 354) {
          // dotStuff guarantees the message ends with CRLF; the dot
          // terminator reuses that CRLF (RFC 5321 §4.5.2: <CRLF>.<CRLF>).
          this.write(dotStuff(this.raw) + ".\r\n");
          this.phase = PH_DATA_REPLY;
          return;
        }
        this.fail(ERR_HOST, "data", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_DATA_REPLY: {
        if (reply.code == 250 || reply.code == 251) {
          this.queueId = queueIdOf(reply);
          this.complete();
          return;
        }
        if (reply.code == 552) {
          this.fail(ERR_HOST, "data", "size exceeded: " + SmtpSession.replyDetail(reply));
          return;
        }
        this.fail(ERR_HOST, "data", SmtpSession.replyDetail(reply));
        return;
      }
      case PH_QUIT: {
        // 221 goodbye — or anything else; the send already completed.
        this.closeTransport();
        this.phase = PH_DONE;
        return;
      }
      default:
        return;
    }
  }

  // -- command senders -----------------------------------------------------

  private clientDomain(): string {
    const addr = this.account.getString("address", "");
    const at = addr.indexOf("@");
    if (at >= 0 && at + 1 < addr.length) return addr.substring(at + 1);
    return "localhost";
  }

  private user(): string {
    return this.account.getString("user", this.account.getString("address", ""));
  }

  private password(): string {
    return this.account.getString("password", "");
  }

  private authMethod(): string {
    return this.account.getString("auth", "plain");
  }

  /** Case-insensitive EHLO keyword lookup (STARTTLS, PIPELINING, ...). */
  private hasCapability(name: string): bool {
    const want = name.toUpperCase();
    for (let i = 0; i < this.capabilities.length; i++) {
      if (this.capabilities[i].toUpperCase() == want) return true;
    }
    return false;
  }

  private parseCapabilities(reply: SmtpReply): void {
    for (let i = 0; i < reply.lines.length; i++) {
      const line = reply.lines[i].trim();
      if (line.length == 0) continue;
      const sp = indexOfSpace(line);
      const keyword = (sp < 0 ? line : line.substring(0, sp)).toUpperCase();
      const arg = sp < 0 ? "" : line.substring(sp + 1).trim();
      this.capabilities.push(keyword);
      if (keyword == "AUTH") {
        const mechs = arg.split(" ");
        for (let m = 0; m < mechs.length; m++) {
          if (mechs[m].length > 0) this.authMechanisms.push(mechs[m].toUpperCase());
        }
      } else if (keyword == "SIZE") {
        const n = parsePositiveInt(arg);
        if (n > 0) this.serverSizeLimit = n;
      } else if (keyword == "PIPELINING") {
        this.pipelining = true;
      }
    }
  }

  /** Post-capability step: authenticate when possible, else MAIL FROM. */
  private afterCaps(): void {
    const started = this.startAuth();
    // startAuth either entered the auth phase or failed the op; only a
    // skipped auth (no password) continues to MAIL FROM.
    if (!started && this.phase != PH_DONE && this.op.state == OP_PENDING) {
      this.sendMailFrom();
    }
  }

  /** Start authentication when the server supports it; false = skip. */
  private startAuth(): bool {
    const password = this.password();
    if (password.length == 0) return false;
    const want = this.authMethod() == "login" ? "LOGIN" : "PLAIN";
    if (this.authMechanisms.length > 0) {
      let offered = false;
      for (let i = 0; i < this.authMechanisms.length; i++) {
        if (this.authMechanisms[i] == want) offered = true;
      }
      if (!offered) {
        // fall back to the other password mechanism if offered
        const other = want == "PLAIN" ? "LOGIN" : "PLAIN";
        let otherOffered = false;
        for (let i = 0; i < this.authMechanisms.length; i++) {
          if (this.authMechanisms[i] == other) otherOffered = true;
        }
        if (!otherOffered) {
          this.fail(ERR_UNSUPPORTED, "auth", "server offers no supported AUTH mechanism (" + this.authMechanisms.join(" ") + ")");
          return false;
        }
      }
    }
    if (want == "LOGIN") {
      this.write("AUTH LOGIN\r\n");
    } else {
      const initial = b64Encode(unlatain("\x00" + this.user() + "\x00" + password));
      this.write("AUTH PLAIN " + initial + "\r\n");
    }
    this.phase = PH_AUTH;
    return true;
  }

  private sendMailFrom(): void {
    this.write("MAIL FROM:<" + this.from + ">\r\n");
    this.phase = PH_MAIL;
  }

  private sendNextRcpt(): void {
    this.write("RCPT TO:<" + this.recipients[this.rcptIndex] + ">\r\n");
    this.phase = PH_RCPT;
  }

  private finishRcpts(): void {
    let accepted = 0;
    for (let i = 0; i < this.rcptResults.length; i++) {
      const row = this.rcptResults.at(i)!;
      if (row.getBool("accepted", false)) accepted++;
    }
    if (accepted == 0) {
      // relaying denied / mailbox unavailable across the board
      let detail = "no recipient accepted:";
      for (let i = 0; i < this.rcptResults.length; i++) {
        const row = this.rcptResults.at(i)!;
        detail +=
          " " + row.getString("address", "") + " -> " +
          row.getInt("code", 0).toString() + " " + row.getString("detail", "");
      }
      this.fail(ERR_HOST, "rcpt", detail);
      return;
    }
    if (this.serverSizeLimit > 0 && this.rawSize > this.serverSizeLimit) {
      this.fail(
        ERR_HOST,
        "data",
        "message size " + this.rawSize.toString() + " exceeds server SIZE " + this.serverSizeLimit.toString(),
      );
      return;
    }
    this.write("DATA\r\n");
    this.phase = PH_DATA_ACCEPT;
  }

  private complete(): void {
    this.phase = PH_QUIT;
    this.write("QUIT\r\n");
    this.closeTransport();
    const out = Json.emptyObj();
    out.setStr("messageId", this.messageIdFromRaw());
    if (this.queueId.length > 0) out.setStr("queueId", this.queueId);
    out.setInt("size", <i64>this.rawSize);
    out.setBool("pipelining", this.pipelining);
    const caps = Json.emptyArr();
    for (let i = 0; i < this.capabilities.length; i++) caps.push(Json.ofStr(this.capabilities[i]));
    out.set("capabilities", caps);
    out.set("recipients", this.rcptResults);
    this.phase = PH_DONE;
    this.op.complete(out);
  }

  /** Message-ID header from the raw message ("" when absent). */
  private messageIdFromRaw(): string {
    let i = this.raw.indexOf("\r\n\r\n");
    if (i < 0) i = this.raw.length;
    let pos = 0;
    while (pos < i) {
      const nl = this.raw.indexOf("\n", pos);
      const end = nl < 0 || nl > i ? i : nl;
      let line = this.raw.substring(pos, end);
      if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
      const low = line.toLowerCase();
      if (low.startsWith("message-id:")) {
        return line.substring(11).trim();
      }
      pos = end + 1;
    }
    return "";
  }
}
