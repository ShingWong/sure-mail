// The browser host driver: loads core.wasm through asc's raw bindings
// (decision D7), wires the `sm.host` ports, and runs the reactor loop
// (drain → execute → feed → observe) until an op completes. Same reactor
// contract as the Node host — only the ports differ (docs/abi.md §4).

import { instantiate } from "@shing.wong/sure-mail-core";
import { decodeBytes } from "./decode.ts";
import { executeEffect, type Effect, type ExecutorContext } from "./executor.ts";
import { RelayNetPorts, type RelayNetOptions } from "./ports/net.ts";
import { StoreWorkerClient, type StoreExecutor } from "./store/client.ts";

export interface OpError {
  code: number;
  name: string;
  where: string;
  detail: string;
}

export interface OpStatus {
  state: "pending" | "done" | "error" | "cancelled";
  result: unknown;
  error: OpError | null;
}

export interface DriveOptions {
  /** Give up after this long: the op is cancelled and its status returned. */
  timeoutMs?: number;
}

/**
 * The wasm export surface the host relies on — the TypeScript mirror of
 * the ABI in docs/abi.md §3. The generated bindings d.ts tracks
 * whatever the current build tree-shakes in, so the host states its own
 * contract and casts.
 */
export interface CoreExports {
  readonly memory: WebAssembly.Memory;
  sm_version(): string;
  sm_init(configJson: string): number;
  account_add(json: string): number;
  account_update(id: number, json: string): number;
  account_remove(id: number): number;
  account_list(): string;
  op_start(kind: string, argsJson: string): number;
  op_status(opId: number): string;
  op_effects(): string;
  op_feed(kind: string, dataJson: string): number;
  op_cancel(opId: number): number;
}

export interface MailHostOptions {
  /** core.wasm bytes (or a Response-able source, e.g. a URL string). */
  wasm: BufferSource | Promise<Response>;
  /** net port options (relay URL, WebSocket factory, proxy toggles). */
  net?: RelayNetOptions;
  /** store port (already-connected worker client). */
  store: StoreExecutor;
  /** The StoreWorkerClient behind `store`, when there is one (exposes ready()). */
  storeClient?: StoreWorkerClient;
  /** http port knobs (fetch impl, caps). */
  http?: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch };
  /** Effect log sink (default: console, skipping debug). */
  log?: (level: string, msg: string) => void;
}

function defaultLog(level: string, msg: string): void {
  if (level !== "debug") console.log(`[${level}] ${msg}`);
}

/**
 * The reference browser host: loads core.wasm, wires the ports, and runs
 * the reactor loop. `createMailHost()` in index.ts builds the ports and
 * returns one of these.
 */
export class MailHost {
  readonly core: CoreExports;
  readonly net: RelayNetPorts;
  readonly store: StoreExecutor;
  /** The store client, when the host built it (createMailHost) — exposes ready(). */
  readonly storeClient?: StoreWorkerClient;
  private readonly ctx: ExecutorContext;
  private readonly logSink: (level: string, msg: string) => void;
  private wakeResolve: (() => void) | null = null;
  private wakePending = false;

  constructor(
    core: CoreExports,
    store: StoreExecutor,
    netOptions: RelayNetOptions = {},
    log: (level: string, msg: string) => void = defaultLog,
    httpOptions: MailHostOptions["http"] = {},
    storeClient?: StoreWorkerClient,
  ) {
    this.core = core;
    this.store = store;
    this.storeClient = storeClient;
    this.logSink = log;
    this.net = new RelayNetPorts((kind, data) => this.feedExternal(kind, data), netOptions);
    this.ctx = {
      feed: (kind, data) => this.feedExternal(kind, data),
      log: (level, msg) => this.logSink(level, msg),
      net: this.net,
      store: this.store,
      http: httpOptions,
    };
  }

  static async load(options: MailHostOptions): Promise<MailHost> {
    const log = options.log ?? defaultLog;
    const bytes = await wasmBytes(options.wasm);
    const mod = await WebAssembly.compile(bytes);
    const state: { core: CoreExports | null } = { core: null };
    const host = {
      now_ms: (): number => Date.now(),
      random_bytes: (dst: number, n: number): void => {
        const memory = state.core?.memory;
        if (!memory) throw new Error("core memory unavailable");
        const cryptoApi = globalThis.crypto;
        if (!cryptoApi?.getRandomValues) throw new Error("crypto.getRandomValues unavailable");
        cryptoApi.getRandomValues(new Uint8Array(memory.buffer, dst, n));
      },
      decode_text: (ptr: number, len: number, charset: string): string => {
        const memory = state.core?.memory;
        if (!memory) throw new Error("core memory unavailable");
        return decodeBytes(new Uint8Array(memory.buffer, ptr, len), charset);
      },
    };
    const core = (await instantiate(
      mod,
      { "sm.host": host, env: {} } as unknown as Parameters<typeof instantiate>[1],
    )) as unknown as CoreExports;
    state.core = core;
    return new MailHost(core, options.store, options.net, log, options.http, options.storeClient);
  }

  /** Deliver a feed (from a port or the host itself) and wake the reactor. */
  feedExternal(kind: string, data: Record<string, unknown>): void {
    this.core.op_feed(kind, JSON.stringify(data));
    this.notify();
  }

  version(): string {
    return this.core.sm_version();
  }

  init(config: Record<string, unknown> = {}): number {
    return this.core.sm_init(JSON.stringify(config));
  }

  accountAdd(account: Record<string, unknown>): number {
    return this.core.account_add(JSON.stringify(account));
  }

  accountUpdate(id: number, account: Record<string, unknown>): number {
    return this.core.account_update(id, JSON.stringify(account));
  }

  accountRemove(id: number): number {
    return this.core.account_remove(id);
  }

  accountList(): unknown[] {
    return JSON.parse(this.core.account_list()) as unknown[];
  }

  startOp(kind: string, args: Record<string, unknown> = {}): number {
    return this.core.op_start(kind, JSON.stringify(args));
  }

  status(opId: number): OpStatus {
    return JSON.parse(this.core.op_status(opId)) as OpStatus;
  }

  drainEffects(): Effect[] {
    return JSON.parse(this.core.op_effects()) as Effect[];
  }

  cancel(opId: number): number {
    return this.core.op_cancel(opId);
  }

  /**
   * Run the reactor until `opId` leaves `pending`: drain and execute
   * effects, feed results back (ports do this asynchronously), and wait
   * for activity. With `timeoutMs`, a stalled op is cancelled.
   */
  async drive(opId: number, options: DriveOptions = {}): Promise<OpStatus> {
    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : 0;
    for (;;) {
      // Drain first: an op that completed on its last feed may have
      // queued final effects (store writes) — those must execute before
      // we report completion.
      const effects = this.drainEffects();
      if (effects.length > 0) {
        for (const eff of effects) await executeEffect(eff, this.ctx);
        continue;
      }
      const status = this.status(opId);
      if (status.state !== "pending") return status;
      if (deadline && Date.now() >= deadline) {
        this.core.op_cancel(opId);
        return this.status(opId);
      }
      await this.waitForWake(deadline ? deadline - Date.now() : 0);
    }
  }

  /** Drain and execute effects until the queue is empty (no op in flight). */
  async flush(): Promise<void> {
    for (;;) {
      const effects = this.drainEffects();
      if (effects.length === 0) return;
      for (const eff of effects) await executeEffect(eff, this.ctx);
    }
  }

  /** Apply the core-owned schema to a store ("registry", "account:<id>"). */
  async ensureSchema(store: string): Promise<void> {
    const opId = this.startOp("store.query", { store, query: "schema" });
    if (opId < 0) throw new Error(`schema op failed to start: ${opId}`);
    const status = await this.drive(opId, { timeoutMs: 15000 });
    if (status.state !== "done") {
      throw new Error(`schema bootstrap failed on ${store}: ${JSON.stringify(status.error)}`);
    }
  }

  close(): void {
    this.net.closeAll();
    this.store.close();
  }

  private notify(): void {
    const wake = this.wakeResolve;
    if (wake) {
      this.wakeResolve = null;
      wake();
    } else {
      this.wakePending = true;
    }
  }

  private waitForWake(timeoutMs: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = (): void => {
        if (timer !== null) clearTimeout(timer);
        if (this.wakeResolve === wake) this.wakeResolve = null;
        resolve();
      };
      this.wakeResolve = wake;
      if (timeoutMs > 0) {
        timer = setTimeout(wake, timeoutMs);
      }
    });
  }
}

async function wasmBytes(wasm: BufferSource | Promise<Response>): Promise<BufferSource> {
  if (wasm instanceof Promise) {
    const res = await wasm;
    if (!res.ok) throw new Error(`failed to fetch core.wasm: ${res.status} ${res.statusText}`);
    return await res.arrayBuffer();
  }
  return wasm;
}
