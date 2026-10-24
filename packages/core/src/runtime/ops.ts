// Op registry, effect queue, and feed routing (docs/abi.md).
//
// The core never performs I/O: ops queue effects (drained by the host via
// op_effects()) and receive results as feeds (op_feed). Effects are
// correlated to their owning op — by `transport` for net.* and by `id`
// for store/dns/http — so feeds land back on the right op handler.

import { Json, KIND_OBJ } from "../json/value.ts";
import { parseJson } from "../json/parse.ts";
import { stringifyJson } from "../json/stringify.ts";
import {
  ERR_CANCELLED,
  ERR_INVALID_ARG,
  ERR_NOT_FOUND,
  ERR_STATE,
  ERR_UNSUPPORTED,
  errorCodeName,
} from "./errors.ts";

export const OP_PENDING: i32 = 0;
export const OP_DONE: i32 = 1;
export const OP_ERROR: i32 = 2;
export const OP_CANCELLED: i32 = 3;

/** A pending operation. Handlers drive it to completion via feeds. */
export class Op {
  id: i32;
  kind: string;
  state: i32 = OP_PENDING;
  result: Json | null = null;
  /**
   * What the op is doing right now, for a host that wants to show it.
   *
   * Ops can run for minutes (a full sync downloads bodies for every folder), and
   * a UI with no progress and no cancel looks hung. The shape is the handler's;
   * the registry only carries it.
   */
  progress: Json | null = null;
  errCode: i32 = 0;
  errWhere: string = "";
  errDetail: string = "";
  handler: OpHandler | null = null;

  constructor(id: i32, kind: string) {
    this.id = id;
    this.kind = kind;
  }

  complete(result: Json): void {
    if (this.state == OP_PENDING) {
      this.state = OP_DONE;
      this.result = result;
    }
  }

  fail(code: i32, where: string, detail: string): void {
    if (this.state == OP_PENDING) {
      this.state = OP_ERROR;
      this.errCode = code;
      this.errWhere = where;
      this.errDetail = detail;
    }
  }

  /** Replace the progress snapshot (ignored once the op has finished). */
  setProgress(json: Json): void {
    if (this.state == OP_PENDING) this.progress = json;
  }

  stateName(): string {
    if (this.state == OP_DONE) return "done";
    if (this.state == OP_ERROR) return "error";
    if (this.state == OP_CANCELLED) return "cancelled";
    return "pending";
  }

  statusJson(): Json {
    const out = Json.emptyObj();
    out.setStr("state", this.stateName());
    out.set("result", this.result != null ? this.result! : Json.nil());
    out.set("progress", this.progress != null ? this.progress! : Json.nil());
    if (this.state == OP_ERROR || this.state == OP_CANCELLED) {
      const err = Json.emptyObj();
      err.setInt("code", <i64>this.errCode);
      err.setStr("name", errorCodeName(this.errCode));
      err.setStr("where", this.errWhere);
      err.setStr("detail", this.errDetail);
      out.set("error", err);
    } else {
      out.set("error", Json.nil());
    }
    return out;
  }
}

/**
 * Per-op feed consumer. The runtime routes feeds to the owning op;
 * the handler interprets them, queues further effects, and completes or
 * fails the op. Return 0 on success, a negative ABI error code on a
 * rejected feed (the runtime then fails the op with that code).
 */
export interface OpHandler {
  onFeed(op: Op, kind: string, data: Json): i32;
  onCancel(op: Op): void;
}

export interface OpFactory {
  create(args: Json, op: Op): OpHandler | null;
}

const EFFECT_RESULT_KINDS: string[] = ["store.result", "dns.result", "http.result"];

export class Runtime {
  private booted: bool = false;
  private effects: Json[] = [];
  private nextEffectId: i32 = 1;
  private nextTransport: i32 = 1;
  private nextOpId: i32 = 1;
  private ops: Map<i32, Op> = new Map();
  private effectOwner: Map<i32, i32> = new Map();
  private transportOwner: Map<string, i32> = new Map();
  private factories: Map<string, OpFactory> = new Map();

  register(kind: string, factory: OpFactory): void {
    this.factories.set(kind, factory);
  }

  isRegistered(kind: string): bool {
    return this.factories.has(kind);
  }

  markBooted(): void {
    this.booted = true;
  }

  isBooted(): bool {
    return this.booted;
  }

  hasPendingOps(): bool {
    const ops = this.ops.values();
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].state == OP_PENDING) return true;
    }
    return false;
  }

  // -- effects -------------------------------------------------------------

  /**
   * Queue an effect owned by `op`. Effects that expect a feed get a
   * unique `id` for correlation (store/dns/http). Returns the correlation
   * id, or 0 for fire-and-forget effects (log, net.write, net.close).
   */
  emitEffect(op: Op, effect: Json): i32 {
    const kind = effect.getString("kind", "");
    if (kind == "store.exec" || kind == "dns.lookup" || kind == "http.fetch") {
      const id = this.nextEffectId++;
      effect.setInt("id", id);
      this.effectOwner.set(id, op.id);
      this.effects.push(effect);
      return id;
    }
    this.effects.push(effect);
    return 0;
  }

  /** Open a net transport for `op`; the id doubles as the transport handle. */
  openTransport(op: Op, host: string, port: i32, tls: bool): string {
    const transport = "t" + this.nextTransport.toString();
    this.nextTransport++;
    const eff = Json.emptyObj();
    eff.setStr("kind", "net.open");
    eff.setStr("transport", transport);
    eff.setStr("host", host);
    eff.setNum("port", <f64>port);
    eff.setBool("tls", tls);
    this.transportOwner.set(transport, op.id);
    this.effects.push(eff);
    return transport;
  }

  /**
   * Queue an effect with no owning op (account registry writes from the
   * synchronous account_* exports). The correlation id still routes
   * store.result feeds — to nowhere — so late results are discarded.
   */
  emitDetached(effect: Json): i32 {
    const kind = effect.getString("kind", "");
    if (kind == "store.exec" || kind == "dns.lookup" || kind == "http.fetch") {
      const id = this.nextEffectId++;
      effect.setInt("id", id);
      this.effects.push(effect);
      return id;
    }
    this.effects.push(effect);
    return 0;
  }

  drainEffects(): string {
    if (this.effects.length == 0) return "[]";
    const arr = Json.emptyArr();
    for (let i = 0; i < this.effects.length; i++) arr.push(this.effects[i]);
    this.effects = new Array<Json>();
    return stringifyJson(arr);
  }

  // -- ops -----------------------------------------------------------------

  startOp(kind: string, argsJson: string): i32 {
    if (!this.booted) return ERR_STATE;
    if (kind.length == 0) return ERR_INVALID_ARG;
    if (!this.factories.has(kind)) return ERR_UNSUPPORTED;
    const args = parseJson(argsJson);
    if (args == null) return ERR_INVALID_ARG;
    const id = this.nextOpId++;
    const op = new Op(id, kind);
    const factory = this.factories.get(kind);
    const handler = factory.create(args, op);
    if (handler == null) {
      // Factory rejected the args before any effect was queued. A well-
      // behaved factory queues no effects before its first return; the
      // host drains op_effects() only after a successful op_start.
      return ERR_INVALID_ARG;
    }
    op.handler = handler;
    this.ops.set(id, op);
    return id;
  }

  status(opId: i32): string {
    if (!this.ops.has(opId)) {
      const out = Json.emptyObj();
      out.setStr("state", "error");
      out.set("result", Json.nil());
      const err = Json.emptyObj();
      err.setInt("code", <i64>ERR_NOT_FOUND);
      err.setStr("name", errorCodeName(ERR_NOT_FOUND));
      err.setStr("where", "op_status");
      err.setStr("detail", "unknown op id " + opId.toString());
      out.set("error", err);
      return stringifyJson(out);
    }
    const op = this.ops.get(opId);
    return stringifyJson(op.statusJson());
  }

  feed(kind: string, dataJson: string): i32 {
    const data = parseJson(dataJson);
    if (data == null || data.kind != KIND_OBJ) return ERR_INVALID_ARG;
    let opId = -1;
    if (kind.startsWith("net.")) {
      const transport = data.getString("transport", "");
      if (this.transportOwner.has(transport)) opId = this.transportOwner.get(transport);
    } else if (EFFECT_RESULT_KINDS.indexOf(kind) >= 0) {
      const id = data.getInt("id", -1);
      if (id >= 0 && this.effectOwner.has(id)) opId = this.effectOwner.get(id);
    } else {
      const id = data.getInt("id", -1);
      if (id >= 0 && this.ops.has(id)) opId = id;
    }
    if (opId < 0 || !this.ops.has(opId)) return 0; // stale feed: acknowledge + discard
    const op = this.ops.get(opId);
    if (op.state != OP_PENDING) {
      this.releaseOp(op);
      return 0; // dead op: acknowledge + discard
    }
    const handler = op.handler;
    if (handler == null) {
      op.fail(ERR_STATE, "feed", kind);
      return ERR_STATE;
    }
    const rc = handler.onFeed(op, kind, data);
    if (op.state != OP_PENDING) this.releaseOp(op);
    if (rc < 0) return rc;
    return 0;
  }

  cancel(opId: i32): i32 {
    if (!this.ops.has(opId)) return ERR_NOT_FOUND;
    const op = this.ops.get(opId);
    if (op.state != OP_PENDING) return ERR_STATE;
    op.state = OP_CANCELLED;
    op.errCode = ERR_CANCELLED;
    op.errWhere = "cancel";
    op.errDetail = op.kind;
    const handler = op.handler;
    if (handler != null) handler.onCancel(op);
    this.releaseOp(op);
    return 0;
  }

  /** Drop correlation state for a finished op (stale feeds get discarded). */
  private releaseOp(op: Op): void {
    const transports = this.transportOwner.keys();
    for (let i = 0; i < transports.length; i++) {
      if (this.transportOwner.get(transports[i]) == op.id) {
        this.transportOwner.delete(transports[i]);
      }
    }
    const eids = this.effectOwner.keys();
    for (let i = 0; i < eids.length; i++) {
      if (this.effectOwner.get(eids[i]) == op.id) {
        this.effectOwner.delete(eids[i]);
      }
    }
    // Keep finished ops around so op_status still answers; prune old ones
    // when the registry grows beyond a generous bound.
    if (this.ops.size > 1024) this.pruneFinished();
  }

  private pruneFinished(): void {
    const ids = this.ops.keys();
    let removed = 0;
    for (let i = 0; i < ids.length && removed < 512; i++) {
      if (this.ops.get(ids[i]).state != OP_PENDING) {
        this.ops.delete(ids[i]);
        removed++;
      }
    }
  }
}
