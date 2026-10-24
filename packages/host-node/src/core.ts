// Effect executor: dispatches drained effects to the Node ports and
// feeds results back into the core. Unknown effects are logged; when they
// carry an `id` the host rejects them with an error feed on `<kind>.result`.

// The reference host driver: loads core.wasm through asc's raw bindings,
// wires the `sm.host` ports, and runs the reactor loop (drain → execute →
// feed → observe) until an op completes.

import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { instantiate } from "@shing.wong/sure-mail-core";
import { decodeBytes } from "./decode.ts";
import { executeEffect, type Effect, type ExecutorContext } from "./executor.ts";
import { NetPorts } from "./ports/net.ts";
import { StorePorts } from "./ports/store.ts";
import { dataPaths, storePath, type Paths } from "./paths.ts";

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
  /** What the op is doing, when its handler reports it (sync does). */
  progress?: { phase: string; folder: string; done: number; total: number } | null;
}

export interface DriveOptions {
  /** Give up after this long: the op is cancelled and its status returned. */
  timeoutMs?: number;
}

export interface MailCoreOptions {
  /** Data root (registry + per-account stores). Default: SURE_MAIL_HOME or ~/.sure-mail. */
  dataDir?: string;
  /** Pre-built paths (overrides dataDir). */
  paths?: Paths;
  /** Explicit core.wasm path (default: resolved from the core package). */
  wasmPath?: string;
  /** net port options. */
  net?: { allowSelfSigned?: boolean; connectTimeoutMs?: number };
  /** DNS port off: dns.lookup effects feed {unsupported:true} (browser/offline hosts). */
  dns?: { disabled?: boolean };
  /** Effect log sink (default: stderr, skipping debug). */
  log?: (level: string, msg: string) => void;
}

type Core = CoreExports;

/**
 * The wasm export surface the host relies on — the TypeScript mirror of
 * the ABI in packages/core/API.md. The generated bindings d.ts tracks
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

function defaultLog(level: string, msg: string): void {
  if (level !== "debug") console.error(`[${level}] ${msg}`);
}

/**
 * The reference host driver: loads core.wasm through asc's raw bindings,
 * wires the `sm.host` ports, and runs the reactor loop (drain → execute →
 * feed → observe) until an op completes.
 */
export class MailCore {
  readonly core: Core;
  readonly paths: Paths;
  readonly net: NetPorts;
  readonly store: StorePorts;
  readonly wasmPath: string;
  private readonly ctx: ExecutorContext;
  private readonly logSink: (level: string, msg: string) => void;
  private wakeResolve: (() => void) | null = null;
  private wakePending = false;

  constructor(
    core: Core,
    paths: Paths,
    wasmPath: string,
    netOptions: MailCoreOptions["net"] = {},
    log: (level: string, msg: string) => void = defaultLog,
    dnsDisabled = false,
  ) {
    this.core = core;
    this.paths = paths;
    this.wasmPath = wasmPath;
    this.logSink = log;
    this.net = new NetPorts((kind, data) => this.feedExternal(kind, data), netOptions);
    this.store = new StorePorts((store) => storePath(paths, store));
    this.ctx = {
      feed: (kind, data) => this.feedExternal(kind, data),
      log: (level, msg) => this.logSink(level, msg),
      net: this.net,
      store: this.store,
      dnsDisabled,
    };
  }

  static async load(options: MailCoreOptions = {}): Promise<MailCore> {
    // Three ways to find core.wasm, in order of explicitness:
    //   1. the caller passes a path;
    //   2. the environment names one — this is how a packaged launcher (SEA,
    //      single binary) points at the copy it extracted, because there is no
    //      node_modules beside a double-clickable file;
    //   3. the workspace package, which is the repository case.
    const wasmPath =
      options.wasmPath ??
      process.env.SURE_MAIL_CORE_WASM ??
      createRequire(import.meta.url).resolve("@shing.wong/sure-mail-core/wasm");
    const paths = options.paths ?? dataPaths(options.dataDir);
    const mod = await WebAssembly.compile(readFileSync(wasmPath));
    const state: { core: Core | null } = { core: null };
    const host = {
      now_ms: (): number => Date.now(),
      random_bytes: (dst: number, n: number): void => {
        const memory = state.core?.memory;
        if (!memory) throw new Error("core memory unavailable");
        randomFillSync(new Uint8Array(memory.buffer, dst, n));
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
    return new MailCore(core, paths, wasmPath, options.net, options.log, options.dns?.disabled ?? false);
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
    this.store.closeAll();
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
