// sure-mail browser host: reactor driver + ports for core.wasm in the
// browser — net via the localhost WS relay, store via a sqlite3.wasm
// worker (OPFS-backed), dns/http via relay proxy or fetch. The wire
// protocol is documented in docs/relay.md; the ABI in
// docs/abi.md.

import { MailHost, type MailHostOptions } from "./core.ts";
import type { RelayNetOptions } from "./ports/net.ts";
import { StoreWorkerClient, type StoreClientEndpoint } from "./store/client.ts";
import type { StoreReply, StoreRequest } from "./store/protocol.ts";

export { MailHost, type CoreExports, type DriveOptions, type MailHostOptions, type OpError, type OpStatus } from "./core.ts";
export { executeEffect, type Effect, type ExecutorContext, type FeedFn } from "./executor.ts";
export { decodeBytes } from "./decode.ts";
export { toBase64, fromBase64 } from "./base64.ts";
export { RelayNetPorts, DEFAULT_RELAY_URL, type NetEventSink, type RelayFrame, type RelayNetOptions, type WebSocketFactory, type WebSocketLike } from "./ports/net.ts";
export { lookupRecord, type DnsResult } from "./ports/dns.ts";
export { fetchText, type HttpOptions, type HttpResult } from "./ports/http.ts";
export { StoreWorkerClient, StoreWorkerError, type StoreClientEndpoint, type StoreExecutor } from "./store/client.ts";
export { runStoreWorker } from "./store/worker-main.ts";
export { storePath } from "./store/layout.ts";
export type { StoreReply, StoreRequest, StoreResult } from "./store/protocol.ts";

export interface CreateMailHostOptions {
  /** core.wasm bytes. Load with `fetch(new URL("core.wasm", import.meta.url))` or read the file. */
  wasm: BufferSource | Promise<Response>;
  /** Relay URL (default ws://127.0.0.1:8787 — `sure-mail serve --relay`). */
  relayUrl?: string;
  /**
   * Store worker endpoint. Defaults to spawning the bundled
   * `store-worker.js` next to this module (browser Worker); tests inject
   * their own (e.g. an in-process endpoint over the same worker main).
   */
  storeEndpoint?: StoreClientEndpoint;
  /** Store worker URL when storeEndpoint is not provided. */
  storeWorkerUrl?: string;
  /** WebSocket constructor override (tests; defaults to the browser global). */
  webSocket?: RelayNetOptions["webSocket"];
  http?: MailHostOptions["http"];
  log?: (level: string, msg: string) => void;
}

/**
 * Build a browser mail host: spawns the store worker, loads core.wasm,
 * and connects the relay net port. The caller owns the returned host —
 * call `host.close()` to tear the worker and relay connection down.
 *
 * The local store is required (it is the source of truth); the relay is
 * NOT. When `sure-mail serve --relay` is not running the host still
 * boots and serves local reads — net-backed ops fail with `net.error`
 * feeds, and the next such op retries the relay connection, so starting
 * the relay later brings the same host online without a reload (M4:
 * "without the relay, the UI runs read-only against the local store").
 */
export async function createMailHost(options: CreateMailHostOptions): Promise<MailHost> {
  const endpoint = options.storeEndpoint ?? spawnStoreWorker(options.storeWorkerUrl ?? defaultStoreWorkerUrl());
  const store = new StoreWorkerClient(endpoint);
  const host = await MailHost.load({
    wasm: options.wasm,
    store,
    storeClient: store,
    net: {
      ...(options.relayUrl !== undefined ? { url: options.relayUrl } : {}),
      ...(options.webSocket !== undefined ? { webSocket: options.webSocket } : {}),
    },
    ...(options.http !== undefined ? { http: options.http } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  await store.ready();
  try {
    await host.net.connect();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    options.log?.("warn", `relay unavailable (${detail}) — local store only until it starts`);
  }
  return host;
}

function defaultStoreWorkerUrl(): string {
  return new URL("store-worker.js", import.meta.url).toString();
}

function spawnStoreWorker(url: string): StoreClientEndpoint {
  const worker = new Worker(url, { type: "module" });
  return {
    post: (msg: StoreRequest) => worker.postMessage(msg),
    onReply: (cb: (msg: StoreReply) => void) => {
      worker.addEventListener("message", (ev: MessageEvent) => cb(ev.data as StoreReply));
    },
    close: () => worker.terminate(),
  };
}
