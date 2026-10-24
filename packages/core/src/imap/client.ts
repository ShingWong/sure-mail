// IMAP session: connection lifecycle (greeting -> CAPABILITY -> LOGIN)
// plus a tagged-command queue. Subclasses send their op-specific commands
// in onReady and interpret untagged events in onUntagged. Feed-driven:
// bytes in via net.data feeds, effects out via the runtime.
//
// STARTTLS (D13): when the account's transport is "starttls" the session
// connects in the clear, greets, requires STARTTLS in CAPABILITY, sends
// STARTTLS, upgrades the transport (net.upgrade -> net.upgraded), re-reads
// CAPABILITY (it may change after the handshake), then LOGINs. Implicit
// TLS is the unchanged default.

import { Json } from "../json/value.ts";
import { b64Decode, b64Encode } from "../encoding/base64.ts";
import { unlatain, ResponseReader } from "./reader.ts";
import { parseResponse, ImapEvent, EV_BYE, EV_CAPABILITY, EV_CONTINUATION, EV_FETCH, EV_LIST, EV_SELECT, EV_TAGGED } from "./response.ts";
import { Op, OpHandler, OP_PENDING, Runtime } from "../runtime/ops.ts";
import { ERR_HOST, ERR_INVALID_ARG, ERR_PROTOCOL, ERR_UNSUPPORTED } from "../runtime/errors.ts";
import { TRANSPORT_STARTTLS, TRANSPORT_TLS, transportMode } from "../runtime/transport.ts";

class PendingCommand {
  tag: string = "";
  name: string = "";

  constructor(tag: string, name: string) {
    this.tag = tag;
    this.name = name;
  }
}

export class ImapSession implements OpHandler {
  runtime: Runtime;
  op: Op;
  transport: string;
  reader: ResponseReader = new ResponseReader();
  capabilities: string[] = [];
  greeted: bool = false;
  greetingOk: bool = false;
  /** "tls" (implicit, handshake on connect) | "starttls" | "plain". */
  socketType: string = TRANSPORT_TLS;
  /** The STARTTLS upgrade completed; capabilities were re-read after it. */
  upgraded: bool = false;
  private upgrading: bool = false;
  private tagCounter: i32 = 0;
  private pending: PendingCommand[] = [];
  private pendingLiteral: Uint8Array | null = null;
  account: Json;

  constructor(runtime: Runtime, op: Op, account: Json) {
    this.runtime = runtime;
    this.op = op;
    this.account = account;
    const host = account.getString("host", "");
    const port = <i32>account.getNum("port", 993);
    const mode = transportMode(account, false);
    this.socketType = mode;
    if (host.length == 0) {
      this.transport = "";
      op.fail(ERR_INVALID_ARG, "account", "missing host");
    } else {
      // STARTTLS and plaintext connect in the clear; implicit TLS handshakes
      // on connect. The upgrade (when requested) happens mid-session.
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
      // STARTTLS completed: capabilities may have changed, so re-read them
      // before authenticating (RFC 3501 §6.2.1).
      this.upgraded = true;
      this.upgrading = false;
      this.capabilities = [];
      this.send("capability", "CAPABILITY");
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
    if (kind == "store.result") {
      this.onStoreResult(data);
      return 0;
    }
    return 0;
  }

  onCancel(_op: Op): void {
    if (this.transport.length > 0) {
      const eff = Json.emptyObj();
      eff.setStr("kind", "net.close");
      eff.setStr("transport", this.transport);
      this.runtime.emitEffect(this.op, eff);
    }
  }

  // -- command plumbing ----------------------------------------------------

  /** Send a tagged command; the response routes back by name. */
  send(name: string, command: string): void {
    this.tagCounter++;
    const tag = "a" + this.tagCounter.toString();
    this.pending.push(new PendingCommand(tag, name));
    this.write(tag + " " + command + "\r\n");
  }

  protected write(text: string): void {
    this.writeBytes(unlatain(text));
  }

  protected writeBytes(bytes: Uint8Array): void {
    const eff = Json.emptyObj();
    eff.setStr("kind", "net.write");
    eff.setStr("transport", this.transport);
    eff.setStr("b64", b64Encode(bytes));
    this.runtime.emitEffect(this.op, eff);
  }

  /** Send a command whose body is a synchronizing literal ({n}). The
   * server's '+' continuation flushes `payload` (see dispatch). */
  protected sendWithLiteral(name: string, command: string, payload: Uint8Array): void {
    this.tagCounter++;
    const tag = "a" + this.tagCounter.toString();
    this.pending.push(new PendingCommand(tag, name));
    this.pendingLiteral = payload;
    this.write(tag + " " + command + "\r\n");
  }

  /** Quote a string for a command line (rejects CR/LF). */
  protected quote(s: string): string {
    if (s.indexOf("\r") >= 0 || s.indexOf("\n") >= 0) return "";
    let out = "\"";
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      out += (c == "\\" || c == "\"") ? "\\" + c : c;
    }
    return out + "\"";
  }

  private pump(): void {
    for (;;) {
      const resp = this.reader.next();
      if (resp == null) return;
      const ev = parseResponse(resp);
      this.dispatch(ev);
      if (this.op.state != OP_PENDING) return;
    }
  }

  private dispatch(ev: ImapEvent): void {
    if (ev.kind == EV_TAGGED) {
      for (let i = 0; i < this.pending.length; i++) {
        if (this.pending[i].tag == ev.tag) {
          const name = this.pending[i].name;
          this.pending.splice(i, 1);
          this.onTagged(name, ev);
          return;
        }
      }
      return; // unknown tag: tolerate
    }
    if (ev.kind == EV_BYE) {
      this.fail(ERR_PROTOCOL, "bye", ev.text);
      return;
    }
    if (ev.kind == EV_CAPABILITY) {
      this.capabilities = ev.capabilities;
    }
    if (ev.kind == EV_CONTINUATION) {
      // v1 never sends non-sync literals, so a '+' is unexpected unless a
      // subclass declared a pending literal (APPEND).
      if (this.pendingLiteral != null) {
        const bytes = this.pendingLiteral!;
        this.pendingLiteral = null;
        this.onContinuation();
        // the literal is followed by CRLF (RFC 3502 §5)
        const withCrlf = new Uint8Array(bytes.length + 2);
        for (let i = 0; i < bytes.length; i++) withCrlf[i] = bytes[i];
        withCrlf[bytes.length] = 13;
        withCrlf[bytes.length + 1] = 10;
        this.writeBytes(withCrlf);
        return;
      }
      this.fail(ERR_PROTOCOL, "continuation", ev.text);
      return;
    }
    if (!this.greeted) {
      if (ev.kind == EV_SELECT) {
        this.greeted = true;
        this.greetingOk = ev.status == "OK";
        this.onGreeting(ev);
        return;
      }
      this.fail(ERR_PROTOCOL, "greeting", "expected greeting, got: " + ev.text);
      return;
    }
    this.onUntagged(ev);
  }

  /** Greeting handled: run CAPABILITY then LOGIN, then onReady(). */
  protected onGreeting(ev: ImapEvent): void {
    if (!this.greetingOk) {
      this.fail(ERR_HOST, "greeting", ev.text);
      return;
    }
    this.send("capability", "CAPABILITY");
  }

  protected onTagged(name: string, ev: ImapEvent): void {
    if (name == "capability") {
      if (this.socketType == TRANSPORT_STARTTLS && !this.upgraded) {
        // STARTTLS is mandatory in this mode: no plaintext auth fallback.
        if (!this.hasCapability("STARTTLS")) {
          this.fail(ERR_UNSUPPORTED, "starttls", "server does not advertise STARTTLS");
          return;
        }
        this.send("starttls", "STARTTLS");
        return;
      }
      const args = this.loginArgs();
      if (args.length > 0) this.send("login", "LOGIN " + args);
      return;
    }
    if (name == "starttls") {
      if (ev.status != "OK") {
        this.fail(ERR_HOST, "starttls", ev.text.length > 0 ? ev.text : "STARTTLS refused by server");
        return;
      }
      this.upgrading = true;
      const eff = Json.emptyObj();
      eff.setStr("kind", "net.upgrade");
      eff.setStr("transport", this.transport);
      this.runtime.emitEffect(this.op, eff);
      return;
    }
    if (name == "login") {
      if (ev.status != "OK") {
        this.fail(ERR_HOST, "login", ev.text);
        return;
      }
      this.onReady();
      return;
    }
    this.onCommandTagged(name, ev);
  }

  /** Case-insensitive capability lookup (STARTTLS, AUTH=PLAIN, ...). */
  protected hasCapability(name: string): bool {
    const want = name.toUpperCase();
    for (let i = 0; i < this.capabilities.length; i++) {
      if (this.capabilities[i].toUpperCase() == want) return true;
    }
    return false;
  }

  private loginArgs(): string {
    const user = this.quote(this.account.getString("user", this.account.getString("address", "")));
    const password = this.quote(this.account.getString("password", ""));
    if (user.length == 0 || password.length == 0) {
      this.fail(ERR_INVALID_ARG, "login", "missing user or password");
      return "";
    }
    return user + " " + password;
  }

  /** Subclasses send their op commands here. */
  protected onReady(): void {}

  /** A declared literal was flushed after the server's continuation. */
  protected onContinuation(): void {}

  /** Subclasses interpret untagged events here. */
  protected onUntagged(_ev: ImapEvent): void {}

  /** Subclasses interpret their own tagged responses here. */
  protected onCommandTagged(_name: string, _ev: ImapEvent): void {}

  /** store.result feeds (sync's mid-op store queries). */
  protected onStoreResult(_data: Json): void {}

  /** Mark the op failed unless it already finished. */
  protected fail(code: i32, where: string, detail: string): void {
    this.op.fail(code, where, detail);
  }
}
