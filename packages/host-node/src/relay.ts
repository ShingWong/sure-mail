// relay: a localhost-only ws ⇄ node:net TCP/TLS bridge. The browser host
// (packages/host-web) cannot open raw sockets, so its net port speaks this
// wire protocol (docs/relay.md) over one WebSocket; the relay opens
// the real transports. It also proxies dns.lookup and http.fetch for
// hosts whose browser cannot do either (CORS / no DNS API).
//
// One WS connection multiplexes many transports, correlated by the
// client-chosen `transport` string — the same correlation the core ABI
// uses for net.* effects/feeds (docs/abi.md §2).

import net from "node:net";
import tls from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import { lookupRecord } from "./ports/dns.ts";
import { fetchText } from "./ports/http.ts";

/** Default cap for one JSON message (before base64 inflation). */
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
/**
 * Slack above the codec limit at the WS layer: oversized frames up to
 * limit+slack still reach the handler and get a JSON {kind:"error"} reply;
 * beyond that the ws library closes the connection (1009) as a backstop.
 */
const FRAME_SLACK_BYTES = 64 * 1024;
/** Graceful-close force-down timer (host-node net port parity). */
const CLOSE_FORCE_MS = 2000;

export interface RelayOptions {
  /** TCP port to listen on (default 8787). */
  port?: number;
  /** Bind address — loopback only (127.x.x.x, localhost, ::1); anything else is refused. */
  host?: string;
  /** Accept self-signed upstream server certs (MockIMAP/live testing). */
  allowSelfSigned?: boolean;
  /** TCP/TLS connect timeout (default 30000; overridable for tests). */
  connectTimeoutMs?: number;
  /** Per-message JSON frame cap in bytes (default 1 MiB). */
  maxFrameBytes?: number;
  log?: (msg: string) => void;
}

export interface RelayHandle {
  /** The actual bound port (useful with port 0). */
  port: number;
  /** Bound socket address — tests assert this is 127.0.0.1, never 0.0.0.0. */
  address(): net.AddressInfo;
  close(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Best-effort transport extraction so even garbage frames get a tagged error. */
function sniffTransport(text: string): string {
  const match = text.match(/"transport"\s*:\s*"([^"]*)"/);
  return match ? match[1] : "";
}

interface OpenMessage {
  kind: "open";
  transport: string;
  host: string;
  port: number;
  tls: boolean;
}

interface WriteMessage {
  kind: "write";
  transport: string;
  b64: string;
}

interface UpgradeMessage {
  kind: "upgrade";
  transport: string;
}

interface CloseMessage {
  kind: "close";
  transport: string;
}

interface DnsLookupMessage {
  kind: "dns.lookup";
  id: number;
  lookup: string;
  name: string;
}

interface HttpFetchMessage {
  kind: "http.fetch";
  id: number;
  url: string;
}

type ClientMessage = OpenMessage | UpgradeMessage | WriteMessage | CloseMessage | DnsLookupMessage | HttpFetchMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-WS-connection state: the transports this browser tab owns. */
class RelaySession {
  private sockets = new Map<string, net.Socket | tls.TLSSocket>();
  private hosts = new Map<string, string>();
  private readonly ws: WebSocket;
  private readonly allowSelfSigned: boolean;
  private readonly timeoutMs: number;

  constructor(ws: WebSocket, allowSelfSigned: boolean, timeoutMs: number) {
    this.ws = ws;
    this.allowSelfSigned = allowSelfSigned;
    this.timeoutMs = timeoutMs;
  }

  handle(msg: ClientMessage): void {
    switch (msg.kind) {
      case "open":
        this.open(msg);
        return;
      case "upgrade":
        this.upgrade(msg);
        return;
      case "write":
        this.write(msg);
        return;
      case "close":
        this.evict(msg.transport);
        return;
      default:
        this.send({ kind: "error", error: `unsupported message kind` });
    }
  }

  /**
   * Graceful close of one transport (client `close` or protocol violation):
   * flush pending writes and half-close; the peer's FIN still produces an
   * `eof` frame back to the client. Unknown ids are a no-op (double-close
   * race). If the peer never completes the teardown, force it down after
   * CLOSE_FORCE_MS (host-node net port parity).
   */
  evict(transport: string): void {
    const socket = this.sockets.get(transport);
    if (!socket) return;
    this.sockets.delete(transport);
    this.hosts.delete(transport);
    socket.end();
    socket.setTimeout(CLOSE_FORCE_MS, () => {
      if (!socket.destroyed) socket.destroy();
    });
  }

  private open(msg: OpenMessage): void {
    const { transport, host, port } = msg;
    if (typeof transport !== "string" || transport.length === 0) {
      this.send({ kind: "error", error: "malformed open (need transport)" });
      return;
    }
    if (this.sockets.has(transport)) {
      this.send({ kind: "error", transport, error: `transport already open: ${transport}` });
      return;
    }
    if (typeof host !== "string" || host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.send({ kind: "error", transport, error: "malformed open (need host + port 1-65535)" });
      return;
    }
    const useTls = msg.tls === true;
    const timeoutMs = this.timeoutMs;
    let socket: net.Socket | tls.TLSSocket;
    const onError = (err: Error): void => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
      this.send({ kind: "error", transport, error: err.message });
    };
    if (useTls) {
      socket = tls.connect({
        host,
        port,
        // SNI is a hostname extension (RFC 6066): never send an IP literal.
        servername: net.isIP(host) === 0 ? host : undefined,
        rejectUnauthorized: !this.allowSelfSigned,
      });
    } else {
      socket = net.connect({ host, port });
    }
    this.sockets.set(transport, socket);
    this.hosts.set(transport, host);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`connect timeout after ${timeoutMs}ms`));
    });
    socket.once(useTls ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      this.send({ kind: "opened", transport });
    });
    socket.on("data", (buf: Buffer) => {
      this.send({ kind: "data", transport, b64: buf.toString("base64") });
    });
    socket.on("end", () => {
      this.send({ kind: "eof", transport });
    });
    socket.on("error", onError);
    socket.on("close", () => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
    });
  }

  /**
   * STARTTLS (D13): a TLS handshake over the existing plaintext socket.
   * Sends `upgraded` on completion; on failure sends `error` and forgets
   * the transport (relay parity with the host-node net port).
   */
  private upgrade(msg: UpgradeMessage): void {
    const { transport } = msg;
    if (typeof transport !== "string") {
      this.send({ kind: "error", error: "malformed upgrade (need transport)" });
      return;
    }
    const socket = this.sockets.get(transport);
    if (!socket) {
      this.send({ kind: "error", transport, error: `unknown transport: ${transport}` });
      return;
    }
    if (socket instanceof tls.TLSSocket) {
      this.send({ kind: "error", transport, error: `transport already TLS: ${transport}` });
      return;
    }
    const host = this.hosts.get(transport) ?? "";
    const timeoutMs = this.timeoutMs;
    // The TLS socket owns the byte stream now: detach the plaintext wiring
    // so encrypted bytes are never surfaced as `data` frames.
    socket.removeAllListeners("data");
    socket.removeAllListeners("end");
    socket.removeAllListeners("close");
    socket.removeAllListeners("timeout");
    socket.removeAllListeners("error");
    socket.on("error", () => {}); // errors surface on the TLS socket instead
    const secure = tls.connect({
      socket,
      // SNI is a hostname extension (RFC 6066): never send an IP literal.
      servername: host.length > 0 && net.isIP(host) === 0 ? host : undefined,
      rejectUnauthorized: !this.allowSelfSigned,
    });
    this.sockets.set(transport, secure);
    secure.setTimeout(timeoutMs, () => {
      secure.destroy(new Error(`TLS handshake timeout after ${timeoutMs}ms`));
    });
    secure.once("secureConnect", () => {
      secure.setTimeout(0);
      this.send({ kind: "upgraded", transport });
    });
    secure.on("data", (buf: Buffer) => {
      this.send({ kind: "data", transport, b64: buf.toString("base64") });
    });
    secure.on("end", () => {
      this.send({ kind: "eof", transport });
    });
    secure.on("error", (err: Error) => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
      this.send({ kind: "error", transport, error: err.message });
    });
    secure.on("close", () => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
    });
  }

  private write(msg: WriteMessage): void {
    if (typeof msg.transport !== "string") {
      this.send({ kind: "error", error: "malformed write (need transport)" });
      return;
    }
    const socket = this.sockets.get(msg.transport);
    if (!socket) {
      this.send({ kind: "error", transport: msg.transport, error: `unknown transport: ${msg.transport}` });
      return;
    }
    if (typeof msg.b64 !== "string") {
      this.send({ kind: "error", transport: msg.transport, error: "malformed write (need b64)" });
      return;
    }
    socket.write(Buffer.from(msg.b64, "base64"));
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    this.hosts.clear();
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
}

async function proxyDns(msg: DnsLookupMessage): Promise<Record<string, unknown>> {
  const result = await lookupRecord(msg.lookup ?? "a", msg.name);
  return { kind: "dns.result", id: msg.id, ...result };
}

async function proxyHttp(msg: HttpFetchMessage): Promise<Record<string, unknown>> {
  const result = await fetchText(msg.url);
  return {
    kind: "http.result",
    id: msg.id,
    status: result.status,
    body: result.body,
    error: result.error,
  };
}

/**
 * Start the relay. Binds loopback only — the browser reaches it at
 * ws://127.0.0.1:<port>; nothing outside this machine can connect.
 */
export function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    return Promise.reject(new Error(`relay binds loopback only; refusing host '${host}'`));
  }
  const port = options.port ?? 8787;
  const log = options.log ?? ((): void => {});
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const wss = new WebSocketServer({ host, port, maxPayload: maxFrameBytes + FRAME_SLACK_BYTES });
  const sessions = new Set<RelaySession>();
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    const session = new RelaySession(ws, options.allowSelfSigned ?? false, connectTimeoutMs);
    sessions.add(session);
    clients.add(ws);
    log(`relay: client connected (${sessions.size} active)`);
    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = String(raw);
      if (Buffer.byteLength(text, "utf8") > maxFrameBytes) {
        // Oversized frames are a protocol violation: tag the error with the
        // (sniffed) transport, close that transport cleanly, keep the WS up.
        const transport = sniffTransport(text);
        ws.send(JSON.stringify({ kind: "error", transport, error: `frame exceeds ${maxFrameBytes} bytes` }));
        session.evict(transport);
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ kind: "error", error: "malformed JSON frame" }));
        return;
      }
      if (!isRecord(msg) || typeof msg["kind"] !== "string") {
        ws.send(JSON.stringify({ kind: "error", error: "frame needs a string kind" }));
        return;
      }
      const kind = msg["kind"];
      if (kind === "dns.lookup" || kind === "http.fetch") {
        // Proxied host-side effects: answered as one frame, correlated by id.
        const proxied =
          kind === "dns.lookup"
            ? proxyDns(msg as unknown as DnsLookupMessage)
            : proxyHttp(msg as unknown as HttpFetchMessage);
        void proxied
          .then((frame) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
          })
          .catch((err: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ kind: "error", id: (msg as { id?: number }).id, error: detail(err) }));
            }
          });
        return;
      }
      session.handle(msg as unknown as ClientMessage);
    });
    ws.on("close", () => {
      session.closeAll();
      sessions.delete(session);
      clients.delete(ws);
      log(`relay: client disconnected (${sessions.size} active)`);
    });
    ws.on("error", () => {
      session.closeAll();
      sessions.delete(session);
      clients.delete(ws);
    });
  });

  return new Promise<RelayHandle>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      const bound = (wss.address() as net.AddressInfo).port;
      log(`relay: listening on ws://${host}:${bound}`);
      resolve({
        port: bound,
        address: () => wss.address() as net.AddressInfo,
        close: () =>
          new Promise<void>((done) => {
            for (const session of sessions) session.closeAll();
            sessions.clear();
            // Terminate clients so wss.close() doesn't wait on them.
            for (const client of clients) client.terminate();
            clients.clear();
            wss.close(() => done());
          }),
      });
    });
  });
}
