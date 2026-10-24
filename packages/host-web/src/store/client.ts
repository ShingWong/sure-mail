// store client (main thread): RPC wrapper over the store worker's
// endpoint. One exec in, one reply out, correlated by `id` — the same
// discipline the core ABI uses for store.exec effects (docs/abi.md §2).

import type { StoreClientEndpoint, StoreError, StoreReply, StoreResult } from "./protocol.ts";

export type { StoreClientEndpoint, StoreResult } from "./protocol.ts";

/** What the executor needs from a store port (browser or Node). */
export interface StoreExecutor {
  exec(store: string, sql: string, params: unknown[]): Promise<StoreResult>;
  close(): void;
}

/** A store worker error — carries the ABI error shape the feed expects. */
export class StoreWorkerError extends Error {
  readonly code: number;
  readonly where: string;
  readonly detail: string;

  constructor(error: StoreError) {
    super(error.detail);
    this.name = "StoreWorkerError";
    this.code = error.code;
    this.where = error.where;
    this.detail = error.detail;
  }
}

interface Pending {
  resolve: (result: StoreResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StoreWorkerClient {
  private readonly endpoint: StoreClientEndpoint;
  private readonly execTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<boolean>;
  private resolveReady!: (persistent: boolean) => void;
  private rejectReady!: (err: Error) => void;
  private closed = false;

  constructor(endpoint: StoreClientEndpoint, execTimeoutMs = 15000) {
    this.endpoint = endpoint;
    this.execTimeoutMs = execTimeoutMs;
    this.readyPromise = new Promise<boolean>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Avoid an unhandled rejection when nobody awaits ready().
    this.readyPromise.catch(() => {});
    endpoint.onReply((msg) => this.onReply(msg));
    endpoint.post({ t: "init" });
  }

  /** Resolves true when the worker DB layer is persistent (OPFS). */
  ready(): Promise<boolean> {
    return this.readyPromise;
  }

  exec(store: string, sql: string, params: unknown[]): Promise<StoreResult> {
    if (this.closed) return Promise.reject(new Error("store client closed"));
    const id = this.nextId++;
    return new Promise<StoreResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`store.exec timed out after ${this.execTimeoutMs}ms`));
      }, this.execTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.endpoint.post({ t: "exec", id, store, sql, params });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.post({ t: "close" });
    this.endpoint.close?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("store client closed"));
    }
    this.pending.clear();
  }

  private onReply(msg: StoreReply): void {
    if (msg.t === "ready") {
      this.resolveReady(msg.persistent);
      return;
    }
    if (msg.t === "fatal") {
      this.rejectReady(new StoreWorkerError(msg.error));
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return; // late reply after timeout/close — discard
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new StoreWorkerError(msg.error));
    else pending.resolve(msg.result ?? { rows: [], changes: 0, insertId: 0 });
  }
}
