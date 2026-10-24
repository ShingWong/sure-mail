// account.autodiscover op (M2): the
// strategy chain. 1) built-in provider table (offline), 2) Thunderbird
// ISPDB via http.fetch (XML parsed in core), 3) DNS MX heuristic via
// dns.lookup ({unsupported:true} feeds degrade gracefully), 4) optional
// capability probes (--probe): verify presented candidates with a real
// IMAP handshake, and add common-name guesses only when the chain found
// nothing. Every candidate passes the D13 transport filter (candidates.ts:
// implicit TLS or STARTTLS + password auth; plaintext/OAuth discarded);
// results are ranked provider > ispdb > mx > probe and deduped by endpoint
// pair.

import { Json, KIND_ARR } from "../json/value.ts";
import { Op, OpFactory, OpHandler, Runtime } from "../runtime/ops.ts";
import { TRANSPORT_TLS } from "../runtime/transport.ts";
import { lookupProvider } from "./providers.ts";
import { parseIspdbXml } from "./xml.ts";
import { candidatesFromIspdb } from "./ispdb.ts";
import { deriveMxCandidates } from "./mx.ts";
import { dedupe, makeCandidate, SOURCE_PROBE } from "./candidates.ts";
import { ProbeSession, PROBE_ACCEPTED } from "./probe.ts";

export const ISPDB_BASE_DEFAULT: string = "https://autoconfig.thunderbird.net/v1.1/";

/** Cap on network probes per op (--probe is opt-in but stays bounded). */
const PROBE_LIMIT: i32 = 6;

const STAGE_ISPDB: i32 = 0;
const STAGE_MX: i32 = 1;
const STAGE_PROBE: i32 = 2;
const STAGE_DONE: i32 = 3;

/**
 * Domain part of an address, validated for safe URL/host use: letters,
 * digits, dots, hyphens; no empty labels; a letter somewhere. "" = invalid.
 */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1 || at >= address.length - 1) return "";
  const domain = address.slice(at + 1).toLowerCase();
  if (domain.length > 253) return "";
  let hasLetter = false;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    const isLetter = c >= 97 && c <= 122;
    if (isLetter) hasLetter = true;
    const ok = isLetter || (c >= 48 && c <= 57) || c == 46 || c == 45;
    if (!ok) return "";
    if (c == 46 && i > 0 && domain.charCodeAt(i - 1) == 46) return "";
  }
  if (!hasLetter) return "";
  const first = domain.charCodeAt(0);
  const last = domain.charCodeAt(domain.length - 1);
  if (first == 46 || first == 45 || last == 46 || last == 45) return "";
  return domain;
}

function appendAll(target: Json, source: Json): void {
  if (source.kind != KIND_ARR) return;
  for (let i = 0; i < source.length; i++) {
    const item = source.at(i);
    if (item != null) target.push(item);
  }
}

function strategy(name: string, state: string, detail: string, found: i32, rejected: i32): Json {
  const s = Json.emptyObj();
  s.setStr("name", name);
  s.setStr("state", state);
  if (detail.length > 0) s.setStr("detail", detail);
  s.setInt("found", <i64>found);
  s.setInt("rejected", <i64>rejected);
  return s;
}

class AutodiscoverHandler implements OpHandler {
  runtime: Runtime;
  address: string;
  domain: string;
  probeEnabled: bool;
  ispdbBase: string;
  candidates: Json = Json.emptyArr();
  strategies: Json = Json.emptyArr();
  stage: i32 = STAGE_ISPDB;
  probeSession: ProbeSession | null = null;
  probeIndex: i32 = 0;
  probedCount: i32 = 0;

  constructor(runtime: Runtime, op: Op, address: string, domain: string, probeEnabled: bool, ispdbBase: string) {
    this.runtime = runtime;
    this.address = address;
    this.domain = domain;
    this.probeEnabled = probeEnabled;
    this.ispdbBase = ispdbBase;
    // strategy 1: offline provider table (pure, no effects)
    const table = lookupProvider(domain, address);
    appendAll(this.candidates, table.candidates);
    this.strategies.push(strategy("provider", "ok", "", table.candidates.length, table.rejected));
    // strategy 2: ISPDB via http.fetch (or skipped when the base is off)
    this.startIspdb(op);
  }

  // -- strategy chain -------------------------------------------------------

  private startIspdb(op: Op): void {
    let base = this.ispdbBase;
    if (base.length > 0 && !base.endsWith("/")) base += "/";
    const enabled = base.startsWith("https://") || base.startsWith("http://");
    if (!enabled) {
      this.strategies.push(strategy("ispdb", "skipped", "no http(s) base configured", 0, 0));
      this.startMx(op);
      return;
    }
    this.stage = STAGE_ISPDB;
    const eff = Json.emptyObj();
    eff.setStr("kind", "http.fetch");
    eff.setStr("url", base + this.domain);
    this.runtime.emitEffect(op, eff);
  }

  private startMx(op: Op): void {
    this.stage = STAGE_MX;
    const eff = Json.emptyObj();
    eff.setStr("kind", "dns.lookup");
    eff.setStr("lookup", "mx");
    eff.setStr("name", this.domain);
    this.runtime.emitEffect(op, eff);
  }

  private startProbes(op: Op): void {
    if (this.probeEnabled && this.candidates.length == 0) this.addCommonNames();
    this.candidates = dedupe(this.candidates);
    if (!this.probeEnabled) {
      this.strategies.push(strategy("probe", "skipped", "", 0, 0));
      this.complete(op);
      return;
    }
    const limit = this.probeLimit();
    if (limit == 0) {
      this.strategies.push(strategy("probe", "skipped", "no candidates to probe", 0, 0));
      this.complete(op);
      return;
    }
    this.stage = STAGE_PROBE;
    this.probeIndex = 0;
    this.probedCount = 0;
    this.startNextProbe(op);
  }

  /**
   * Strategy 4 as fallback discovery: guess the common mail hostnames
   * (imap.<domain>, mail.<domain>) only when no other strategy produced a
   * candidate — they would only duplicate MX-derived hosts otherwise, and
   * speculative guesses are worth presenting only when they can be verified.
   */
  private addCommonNames(): void {
    const named = makeCandidate(
      this.address, "imap." + this.domain, 993, "ssl", "smtp." + this.domain, 465, "ssl", "plain", this.address, SOURCE_PROBE,
    );
    const mailHost = makeCandidate(
      this.address, "mail." + this.domain, 993, "ssl", "mail." + this.domain, 465, "ssl", "plain", this.address, SOURCE_PROBE,
    );
    if (named != null) this.candidates.push(named);
    if (mailHost != null) this.candidates.push(mailHost);
  }

  private probeLimit(): i32 {
    const n = this.candidates.length;
    return n < PROBE_LIMIT ? n : PROBE_LIMIT;
  }

  private startNextProbe(op: Op): void {
    if (this.probeIndex >= this.probeLimit()) {
      this.strategies.push(strategy("probe", "ok", "", this.probedCount, 0));
      this.stage = STAGE_DONE;
      this.complete(op);
      return;
    }
    const c = this.candidates.at(this.probeIndex);
    if (c == null) {
      this.probeIndex++;
      this.startNextProbe(op);
      return;
    }
    const imap = c.get("imap");
    if (imap == null) {
      this.probeIndex++;
      this.startNextProbe(op);
      return;
    }
    this.probeSession = new ProbeSession(
      this.runtime,
      op,
      imap.getString("host", ""),
      imap.getInt("port", 993),
      this.address,
      imap.getString("socket_type", TRANSPORT_TLS),
    );
  }

  private complete(op: Op): void {
    const out = Json.emptyObj();
    out.setStr("address", this.address);
    out.setStr("domain", this.domain);
    out.setBool("probe", this.probeEnabled);
    out.set("candidates", this.candidates);
    out.set("strategies", this.strategies);
    op.complete(out);
  }

  // -- feeds ---------------------------------------------------------------

  onFeed(op: Op, kind: string, data: Json): i32 {
    if (this.stage == STAGE_ISPDB && kind == "http.result") {
      this.onIspdbResult(op, data);
      return 0;
    }
    if (this.stage == STAGE_MX && kind == "dns.result") {
      this.onDnsResult(op, data);
      return 0;
    }
    if (this.stage == STAGE_PROBE && kind.startsWith("net.")) {
      this.onProbeFeed(op, kind, data);
      return 0;
    }
    return 0; // stale or unrelated feed: acknowledge and keep waiting
  }

  private onIspdbResult(op: Op, data: Json): void {
    const err = data.getString("error", "");
    const status = <i32>data.getNum("status", -1);
    const body = data.getString("body", "");
    if (err.length > 0) {
      this.strategies.push(strategy("ispdb", "error", err, 0, 0));
      this.startMx(op);
      return;
    }
    if (status != 200 || body.length == 0) {
      const state = status == 404 || status == 410 ? "not-found" : "error";
      const detail = status < 0 ? "no http status" : "http status " + status.toString();
      this.strategies.push(strategy("ispdb", state, detail, 0, 0));
      this.startMx(op);
      return;
    }
    const r = candidatesFromIspdb(parseIspdbXml(body), this.address, this.domain);
    appendAll(this.candidates, r.candidates);
    this.strategies.push(strategy("ispdb", "ok", "", r.candidates.length, r.rejected));
    this.startMx(op);
  }

  private onDnsResult(op: Op, data: Json): void {
    if (data.getBool("unsupported", false)) {
      // e.g. the browser host: no dns port — degrade, never error (M2 spec)
      this.strategies.push(strategy("mx", "unsupported", "", 0, 0));
      this.startProbes(op);
      return;
    }
    const err = data.getString("error", "");
    if (err.length > 0) {
      this.strategies.push(strategy("mx", "error", err, 0, 0));
      this.startProbes(op);
      return;
    }
    const records = data.get("records");
    if (records == null || records.kind != KIND_ARR) {
      this.strategies.push(strategy("mx", "error", "malformed dns feed", 0, 0));
      this.startProbes(op);
      return;
    }
    const r = deriveMxCandidates(this.address, this.domain, records);
    appendAll(this.candidates, r.candidates);
    const s = strategy("mx", r.nullMx ? "null-mx" : "ok", "", r.candidates.length, 0);
    s.setInt("mxCount", <i64>r.mxCount);
    this.strategies.push(s);
    this.startProbes(op);
  }

  private onProbeFeed(op: Op, kind: string, data: Json): void {
    const session = this.probeSession;
    if (session == null) return;
    session.onFeed(op, kind, data);
    if (!session.done) return;
    // record the verdict on the candidate that was probed
    const c = this.candidates.at(this.probeIndex);
    if (c != null) {
      c.setStr("probe", session.verdict);
      if (session.verdict == PROBE_ACCEPTED) {
        const caps = Json.emptyArr();
        for (let i = 0; i < session.capabilities.length; i++) caps.push(Json.ofStr(session.capabilities[i]));
        c.set("capabilities", caps);
      }
    }
    this.probeIndex++;
    this.probedCount++;
    this.probeSession = null;
    this.startNextProbe(op);
  }

  onCancel(_op: Op): void {
    const session = this.probeSession;
    if (session != null) session.onCancel(_op);
  }
}

export class AutodiscoverFactory implements OpFactory {
  runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  create(args: Json, op: Op): OpHandler | null {
    const address = args.getString("address", "");
    const domain = domainOf(address);
    if (domain.length == 0) return null; // invalid address: -1 before any effect
    const probe = args.getBool("probe", false);
    // Host/test override of the ISPDB base; "" disables the strategy.
    const ispdbBase = args.has("ispdbBase") ? args.getString("ispdbBase", ISPDB_BASE_DEFAULT) : ISPDB_BASE_DEFAULT;
    return new AutodiscoverHandler(this.runtime, op, address, domain, probe, ispdbBase);
  }
}
