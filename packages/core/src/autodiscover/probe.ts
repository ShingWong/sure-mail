// Probe session (M2 strategy 4): a stripped IMAP capability handshake
// against one autodiscover candidate — greeting -> CAPABILITY -> LOGOUT —
// reusing the ImapSession machinery. A probe NEVER fails the owning op:
// any failure path records a verdict (accepted | refused | timeout) and
// closes its transport so the strategy chain can move on. "timeout"
// comes from the host's connect-phase timeout error; a stall after the
// handshake falls back to the host drive's own timeoutMs backstop.

import { Json } from "../json/value.ts";
import { ImapSession } from "../imap/client.ts";
import { ImapEvent } from "../imap/response.ts";
import { Op, Runtime } from "../runtime/ops.ts";
import { TRANSPORT_STARTTLS, TRANSPORT_TLS } from "../runtime/transport.ts";

export const PROBE_ACCEPTED: string = "accepted";
export const PROBE_REFUSED: string = "refused";
export const PROBE_TIMEOUT: string = "timeout";

export class ProbeSession extends ImapSession {
  done: bool = false;
  verdict: string = "";
  detail: string = "";
  gotCaps: bool = false;

  constructor(runtime: Runtime, op: Op, host: string, port: i32, user: string, socketType: string = TRANSPORT_TLS) {
    super(runtime, op, ProbeSession.pseudoAccount(host, port, user, socketType));
  }

  /** The candidate as an account shape the session machinery understands. */
  private static pseudoAccount(host: string, port: i32, user: string, socketType: string): Json {
    const account = Json.emptyObj();
    account.setStr("host", host);
    account.setInt("port", <i64>port);
    account.setStr("socket_type", socketType); // D13: tls or starttls
    account.setStr("user", user);
    account.setStr("password", ""); // probes never log in
    return account;
  }

  onFeed(op: Op, kind: string, data: Json): i32 {
    if (this.done) return 0;
    if (kind == "net.error") {
      const err = data.getString("error", "net error");
      const lower = err.toLowerCase();
      const timeout = lower.indexOf("timeout") >= 0 || lower.indexOf("timedout") >= 0;
      this.finish(timeout ? PROBE_TIMEOUT : PROBE_REFUSED, err);
      return 0;
    }
    if (kind == "net.eof") {
      this.finish(this.gotCaps ? PROBE_ACCEPTED : PROBE_REFUSED, "connection closed by server");
      return 0;
    }
    return super.onFeed(op, kind, data);
  }

  /** Greeting: an OK greeting earns a CAPABILITY; anything else refuses. */
  protected onGreeting(ev: ImapEvent): void {
    if (!this.greetingOk) {
      this.finish(PROBE_REFUSED, ev.text);
      return;
    }
    this.send("capability", "CAPABILITY");
  }

  protected onTagged(name: string, ev: ImapEvent): void {
    if (name == "capability") {
      if (ev.status != "OK") {
        this.finish(PROBE_REFUSED, ev.text);
        return;
      }
      if (this.socketType == TRANSPORT_STARTTLS && !this.upgraded) {
        // A STARTTLS candidate that does not offer STARTTLS is unusable.
        if (!this.hasCapability("STARTTLS")) {
          this.finish(PROBE_REFUSED, "server does not advertise STARTTLS");
          return;
        }
        this.send("starttls", "STARTTLS");
        return;
      }
      this.gotCaps = true;
      this.send("logout", "LOGOUT");
      return;
    }
    if (name == "starttls") {
      // Reuse the base upgrade plumbing (net.upgrade -> net.upgraded ->
      // re-CAPABILITY); the next capability response lands back here.
      super.onTagged(name, ev);
      return;
    }
    if (name == "logout") {
      this.finish(PROBE_ACCEPTED, "");
      return;
    }
    // A probe never logs in and sends no other commands: ignore strays.
  }

  /**
   * Failure hook: the probe absorbs errors instead of failing the op.
   * Once CAPABILITY succeeded the candidate has answered — a BYE during
   * LOGOUT (the common close) still counts as accepted.
   */
  protected fail(_code: i32, _where: string, detail: string): void {
    this.finish(this.gotCaps ? PROBE_ACCEPTED : PROBE_REFUSED, detail);
  }

  /** Record the verdict once and close the transport (idempotent). */
  finish(verdict: string, detail: string): void {
    if (this.done) return;
    this.done = true;
    this.verdict = verdict;
    this.detail = detail;
    if (this.transport.length > 0) {
      const eff = Json.emptyObj();
      eff.setStr("kind", "net.close");
      eff.setStr("transport", this.transport);
      this.runtime.emitEffect(this.op, eff);
    }
  }
}
