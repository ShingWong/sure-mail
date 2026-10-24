// net port (browser): translates the core's net.* effects into relay wire
// frames (docs/relay.md) and re-emits server frames as net.* feeds.
// The browser never sees a socket — the relay owns TCP/TLS; one WebSocket
// multiplexes every transport, correlated by the core's transport ids.

import { toBase64 } from "../base64.ts";

export type NetEventSink = (kind: string, data: Record<string, unknown>) => void;

export interface RelayFrame {
  kind: string;
  transport?: string;
  b64?: string;
  id?: number;
  error?: string;
  [key: string]: unknown;
}

/** The subset of WebSocket this port needs (real WS or a test double). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export interface RelayNetOptions {
  /** Relay URL (default ws://127.0.0.1:8787). */
  url?: string;
  /** WebSocket constructor (browser global, or `ws` in Node tests). */
  webSocket?: WebSocketFactory;
  /** Proxy dns.lookup through the relay (default true — browsers have no DNS API). */
  proxyDns?: boolean;
  /** Proxy http.fetch through the relay when direct fetch fails (default true). */
  proxyHttp?: boolean;
}

export const DEFAULT_RELAY_URL = "ws://127.0.0.1:8787";

/**
 * The browser net port. Outbound: `open`/`write`/`close`/`dns.lookup`/
 * `http.fetch` frames. Inbound frames resolve id-correlated requests
 * (dns/http) or become net.* feeds (opened/data/eof/error). The client is
 * usable before the socket opens only after `open()` resolves.
 */
export class RelayNetPorts {
  readonly url: string;
  private readonly sink: NetEventSink;
  private readonly webSocket: WebSocketFactory;
  readonly proxyDns: boolean;
  readonly proxyHttp: boolean;
  private ws: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly transports = new Set<string>();
  private readonly waiters = new Map<number, { resolve: (f: RelayFrame) => void; reject: (e: Error) => void }>();
  private connectWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private lastClose = "relay connection closed";

  constructor(sink: NetEventSink, options: RelayNetOptions = {}) {
    this.sink = sink;
    this.url = options.url ?? DEFAULT_RELAY_URL;
    this.webSocket =
      options.webSocket ?? ((url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike);
    this.proxyDns = options.proxyDns ?? true;
    this.proxyHttp = options.proxyHttp ?? true;
  }

  /**
   * Open the relay WebSocket; resolves on `open`, rejects on failure.
   * Concurrent calls share one in-flight attempt. A failed connect is not
   * fatal — the host stays usable read-only against the local store, and
   * the next net op retries via `open()` (see `retryConnect`).
   */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = this.webSocket(this.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      this.connectWaiters.push({ resolve, reject });
      ws.addEventListener("open", () => {
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const w of waiters) w.resolve();
      });
      ws.addEventListener("message", (ev) => this.onFrame(String(ev.data)));
      ws.addEventListener("error", () => {
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const w of waiters) w.reject(new Error(`relay connection failed: ${this.url}`));
      });
      ws.addEventListener("close", (ev) => this.onClose(ev.reason ?? this.lastClose));
    });
  }

  /** Best-effort background connect; never throws (read-only-until-relay). */
  private retryConnect(): void {
    void this.connect().catch(() => {});
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  // ---- net.* effect surface (host-node NetPorts parity) ----

  open(transport: string, host: string, port: number, tls: boolean): void {
    if (this.transports.has(transport)) {
      this.sink("net.error", { transport, error: `transport already open: ${transport}` });
      return;
    }
    // Lazy reconnect: a relay started after boot is picked up by the next
    // op. This attempt still reports net.error (the core retries), so the
    // behaviour is identical to a permanently absent relay.
    if (!this.connected) this.retryConnect();
    if (!this.send({ kind: "open", transport, host, port, tls })) return;
    this.transports.add(transport);
  }

  /** STARTTLS: ask the relay to upgrade an existing plaintext transport. */
  upgrade(transport: string): void {
    if (!this.transports.has(transport)) {
      this.sink("net.error", { transport, error: `unknown transport: ${transport}` });
      return;
    }
    this.send({ kind: "upgrade", transport });
  }

  write(transport: string, bytes: Uint8Array): void {
    if (!this.transports.has(transport)) {
      this.sink("net.error", { transport, error: `unknown transport: ${transport}` });
      return;
    }
    this.send({ kind: "write", transport, b64: toBase64(bytes) });
  }

  close(transport: string): void {
    if (!this.transports.has(transport)) return;
    // Graceful close: the relay half-closes; a peer FIN still yields `eof`.
    this.send({ kind: "close", transport });
  }

  /** dns.lookup via the relay proxy, correlated by the core's effect id. Never throws. */
  async lookup(id: number, name: string, type: string): Promise<Record<string, unknown>> {
    if (!this.proxyDns || !this.connected) return { unsupported: true };
    return this.awaitResult({ kind: "dns.lookup", id, lookup: type, name });
  }

  /** http.fetch via the relay proxy (direct fetch is tried first by http port). */
  async fetchViaRelay(id: number, url: string): Promise<Record<string, unknown>> {
    if (!this.connected) return { id, error: "relay not connected" };
    return this.awaitResult({ kind: "http.fetch", id, url });
  }

  closeAll(): void {
    this.transports.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WS_OPEN) ws.close(1000, "host closing");
  }

  // ---- inbound frame handling ----

  private onFrame(text: string): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(text) as RelayFrame;
    } catch {
      return; // not JSON — nothing sensible to correlate
    }
    if (typeof frame.kind !== "string") return;
    // dns/http results are correlated by `id`.
    if ((frame.kind === "dns.result" || frame.kind === "http.result") && typeof frame.id === "number") {
      const waiter = this.waiters.get(frame.id);
      if (waiter) {
        this.waiters.delete(frame.id);
        waiter.resolve(frame);
      }
      return;
    }
    if (frame.kind === "error" && typeof frame.id === "number" && frame.transport === undefined) {
      // proxy failure for an id-correlated request
      const waiter = this.waiters.get(frame.id);
      if (waiter) {
        this.waiters.delete(frame.id);
        waiter.reject(new Error(frame.error ?? "proxy request failed"));
      }
      return;
    }
    const transport = frame.transport;
    if (typeof transport !== "string") return;
    switch (frame.kind) {
      case "opened":
        this.transports.add(transport);
        this.sink("net.opened", { transport });
        return;
      case "upgraded":
        this.sink("net.upgraded", { transport });
        return;
      case "data":
        this.sink("net.data", { transport, b64: frame.b64 ?? "" });
        return;
      case "eof":
        this.transports.delete(transport);
        this.sink("net.eof", { transport });
        return;
      case "error":
        this.transports.delete(transport);
        this.sink("net.error", { transport, error: frame.error ?? "relay error" });
        return;
      default:
        return; // unknown frame kind — ignore (forward compatible)
    }
  }

  private onClose(reason: string): void {
    this.lastClose = reason || "relay connection closed";
    // The relay destroys every transport it opened for us; the host reports
    // them as errored and lets the core retry (docs/relay.md).
    const gone = [...this.transports];
    this.transports.clear();
    for (const transport of gone) {
      this.sink("net.error", { transport, error: this.lastClose });
    }
    for (const [, waiter] of this.waiters) waiter.reject(new Error(this.lastClose));
    this.waiters.clear();
    this.ws = null;
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.reject(new Error(`relay connection closed: ${this.lastClose}`));
  }

  private send(frame: RelayFrame): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      if (typeof frame.transport === "string") {
        this.sink("net.error", { transport: frame.transport, error: `relay not connected: ${this.url}` });
      }
      return false;
    }
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** Send a proxy request frame and resolve to its ABI feed payload. */
  private awaitResult(frame: RelayFrame): Promise<Record<string, unknown>> {
    const id = frame.id as number;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiters.set(id, { resolve: (f) => resolve(frameToFeed(f, id)), reject });
      if (!this.send(frame)) {
        this.waiters.delete(id);
        reject(new Error(`relay not connected: ${this.url}`));
      }
    }).catch((err: unknown) => ({
      id,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/** Turn a dns/http result frame into the ABI feed payload. */
function frameToFeed(frame: RelayFrame, id: number): Record<string, unknown> {
  const out: Record<string, unknown> = { id };
  for (const key of ["records", "unsupported", "status", "body", "error"]) {
    if (frame[key] !== undefined) out[key] = frame[key];
  }
  return out;
}
