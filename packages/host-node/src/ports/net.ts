// net port: node:net + node:tls transports driven by net.* effects.
// The host never parses protocol bytes — it moves opaque byte buffers and
// reports events back to the core as feeds (net.opened/net.data/net.eof/
// net.error, correlated by `transport`). net.upgrade performs a TLS
// handshake on a live plaintext transport (STARTTLS) and feeds
// net.upgraded (docs/abi.md §2).

import net from "node:net";
import tls from "node:tls";

export type NetEventSink = (kind: string, data: Record<string, unknown>) => void;

export interface NetOptions {
  /** Accept self-signed server certs (MockIMAP/live testing). */
  allowSelfSigned?: boolean;
  connectTimeoutMs?: number;
}

export class NetPorts {
  private sockets = new Map<string, net.Socket | tls.TLSSocket>();
  private hosts = new Map<string, string>();
  private sink: NetEventSink;
  private options: NetOptions;

  constructor(sink: NetEventSink, options: NetOptions = {}) {
    this.sink = sink;
    this.options = options;
  }

  open(transport: string, host: string, port: number, useTls: boolean): void {
    if (this.sockets.has(transport)) {
      this.sink("net.error", { transport, error: `transport already open: ${transport}` });
      return;
    }
    const timeoutMs = this.options.connectTimeoutMs ?? 30000;
    let socket: net.Socket | tls.TLSSocket;
    const onError = (err: Error): void => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
      this.sink("net.error", { transport, error: err.message });
    };
    if (useTls) {
      socket = tls.connect({
        host,
        port,
        // SNI is a hostname extension (RFC 6066): never send an IP literal.
        servername: net.isIP(host) === 0 ? host : undefined,
        rejectUnauthorized: !this.options.allowSelfSigned,
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
      this.sink("net.opened", { transport });
    });
    socket.on("data", (buf: Buffer) => {
      this.sink("net.data", { transport, b64: buf.toString("base64") });
    });
    socket.on("end", () => {
      this.sink("net.eof", { transport });
    });
    socket.on("error", onError);
    socket.on("close", () => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
    });
  }

  /**
   * Upgrade an existing plaintext transport to TLS (STARTTLS, D13): the
   * live socket is wrapped by `tls.connect({socket})` and the port's event
   * wiring moves to the TLS socket, so subsequent `write`/`close` use it.
   * The port's existing SNI / self-signed / timeout rules apply to the
   * handshake. Feeds `net.upgraded` on completion; on failure feeds
   * `net.error` and forgets the transport (same as a failed open).
   */
  upgrade(transport: string): void {
    const socket = this.sockets.get(transport);
    if (!socket) {
      this.sink("net.error", { transport, error: `unknown transport: ${transport}` });
      return;
    }
    if (socket instanceof tls.TLSSocket) {
      this.sink("net.error", { transport, error: `transport already TLS: ${transport}` });
      return;
    }
    const host = this.hosts.get(transport) ?? "";
    const timeoutMs = this.options.connectTimeoutMs ?? 30000;
    // The TLS socket owns the byte stream now: detach the plaintext wiring
    // so encrypted bytes are never surfaced as net.data.
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
      rejectUnauthorized: !this.options.allowSelfSigned,
    });
    this.sockets.set(transport, secure);
    secure.setTimeout(timeoutMs, () => {
      secure.destroy(new Error(`TLS handshake timeout after ${timeoutMs}ms`));
    });
    secure.once("secureConnect", () => {
      secure.setTimeout(0);
      this.sink("net.upgraded", { transport });
    });
    secure.on("data", (buf: Buffer) => {
      this.sink("net.data", { transport, b64: buf.toString("base64") });
    });
    secure.on("end", () => {
      this.sink("net.eof", { transport });
    });
    secure.on("error", (err: Error) => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
      this.sink("net.error", { transport, error: err.message });
    });
    secure.on("close", () => {
      this.sockets.delete(transport);
      this.hosts.delete(transport);
    });
  }

  write(transport: string, bytes: Uint8Array): void {
    const socket = this.sockets.get(transport);
    if (!socket) {
      this.sink("net.error", { transport, error: `unknown transport: ${transport}` });
      return;
    }
    socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  }

  close(transport: string): void {
    const socket = this.sockets.get(transport);
    if (!socket) return;
    this.sockets.delete(transport);
    // Graceful close: let pending writes (e.g. SMTP QUIT, IMAP LOGOUT)
    // flush before tearing the socket down.
    socket.end(() => {
      if (!socket.destroyed) socket.destroy();
    });
    // If the peer never completes the teardown, force it.
    socket.setTimeout(2000, () => {
      if (!socket.destroyed) socket.destroy();
    });
  }

  closeAll(): void {
    for (const transport of [...this.sockets.keys()]) this.close(transport);
  }
}
