// MockIMAP: a scripted in-process IMAP server on loopback. Tests drive
// the REAL reactor + REAL core.wasm against it — zero external network.
// Scripts are consumed in order; {tag} in a response template expands to
// the client command's tag; responses may dribble out byte-by-byte
// (chunkSize) to prove the core's incremental parser.
//
// Three connection modes (D13):
//   default        plaintext from connect
//   {tls:{...}}    implicit TLS from connect (993-style; allowSelfSigned)
//   {starttls:{...}} plaintext, then a `STARTTLS` command upgrades the live
//                    socket to TLS (143-style)
import net from "node:net";
import tls from "node:tls";

export class MockIMAP {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize ?? 0;
    this.greeting = options.greeting ?? "* OK [CAPABILITY IMAP4rev1] mock ready\r\n";
    this.scripts = [];
    this.received = [];
    this.literals = []; // synchronizing-literal payloads (APPEND bodies)
    this.unmatched = [];
    this.connections = new Set();
    this.destroyAfter = new Map(); // transport index -> lines until destroy
    this.starttlsOptions = options.starttls ?? null;
    this.server = options.tls
      ? tls.createServer(options.tls, (socket) => this.onConnection(socket))
      : net.createServer((socket) => this.onConnection(socket));
    this.port = 0;
  }

  /** Queue a scripted exchange: expect matches the client line. */
  script(expect, respond) {
    this.scripts.push({ expect, respond, used: false });
    return this;
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    for (const socket of this.connections) socket.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }

  onConnection(socket) {
    this.connections.add(socket);
    const state = {
      socket,
      onData: null,
      buffer: "",
      literalRemaining: 0,
      literalRespond: null,
      literalBuf: "",
      waitCrlf: false,
    };
    this.attach(state);
    this.write(socket, this.greeting);
  }

  /** (Re)wire the data/close handlers for the connection's current socket. */
  attach(state) {
    const socket = state.socket;
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => {});
    state.onData = (chunk) => this.onChunk(state, chunk);
    socket.on("data", state.onData);
  }

  /** STARTTLS: wrap the live plaintext socket in a server TLS handshake. */
  startTls(state) {
    const raw = state.socket;
    raw.removeListener("data", state.onData);
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      secureContext: tls.createSecureContext(this.starttlsOptions),
    });
    this.connections.delete(raw);
    this.connections.add(secure);
    state.socket = secure;
    this.attach(state);
  }

  onChunk(state, chunk) {
    let data = chunk.toString("latin1");
    if (state.literalRemaining > 0) {
      const take = Math.min(state.literalRemaining, data.length);
      state.literalBuf += data.slice(0, take);
      state.literalRemaining -= take;
      data = data.slice(take);
      if (state.literalRemaining === 0) {
        this.literals.push(state.literalBuf);
        state.literalBuf = "";
        state.waitCrlf = true;
      } else {
        return;
      }
    }
    if (state.waitCrlf) {
      // the literal is followed by CRLF, then the scripted response
      state.buffer += data;
      const idx = state.buffer.indexOf("\r\n");
      if (idx < 0) return;
      state.waitCrlf = false;
      state.buffer = state.buffer.slice(idx + 2);
      const respond = state.literalRespond;
      state.literalRespond = null;
      if (respond) this.write(state.socket, respond);
      this.processBuffer(state);
      return;
    }
    state.buffer += data;
    this.processBuffer(state);
  }

  /** Split buffered text into lines and dispatch each to onLine. */
  processBuffer(state) {
    let idx;
    while ((idx = state.buffer.indexOf("\r\n")) >= 0) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 2);
      const literal = this.onLine(state, line);
      if (literal !== null) {
        // command carries a {n} literal: wait for the payload
        state.literalRemaining = literal.size;
        state.literalRespond = literal.respond;
        state.literalBuf = "";
        return;
      }
    }
  }

  onLine(state, line) {
    this.received.push(line);
    const script = this.scripts.find((s) => !s.used && s.expect.test(line));
    if (!script) {
      this.unmatched.push(line);
      const tag = line.split(" ")[0];
      this.write(state.socket, `${tag} BAD unexpected command in mock\r\n`);
      return null;
    }
    script.used = true;
    const respond = typeof script.respond === "function" ? script.respond(line) : script.respond;
    const tag = line.split(" ")[0];
    const text = respond.replaceAll("{tag}", tag);
    // synchronizing literal: `APPEND ... {n}` — acknowledge, then flush
    // the scripted response after the payload arrives.
    const lit = line.match(/\{(\d+)\+?\}\s*$/);
    if (lit) {
      this.write(state.socket, "+ ready for literal\r\n");
      return { size: Number(lit[1]), respond: text };
    }
    this.write(state.socket, text);
    // A STARTTLS command flips the connection to TLS after the OK reply.
    if (this.starttlsOptions && /(^|\s)STARTTLS(\s|$)/i.test(line)) this.startTls(state);
    return null;
  }

  write(socket, text) {
    const bytes = Buffer.from(text, "latin1");
    if (this.chunkSize > 0) {
      let i = 0;
      const step = () => {
        if (socket.destroyed) return;
        if (i >= bytes.length) return;
        socket.write(bytes.subarray(i, i + this.chunkSize));
        i += this.chunkSize;
        setTimeout(step, 0);
      };
      step();
      return;
    }
    socket.write(bytes);
  }
}

/** A tiny RFC-ish mail store the mock serves from (for sync scripts). */
export function envelopeLine(seq, uid, subject, from, to, date) {
  const env =
    `(${JSON.stringify(date)} ${JSON.stringify(subject)} ` +
    `((NIL NIL ${JSON.stringify(from)} "example.com")) ((NIL NIL ${JSON.stringify(from)} "example.com")) ` +
    `((NIL NIL ${JSON.stringify(from)} "example.com")) ((NIL NIL ${JSON.stringify(to)} "example.com")) ` +
    `((NIL NIL ${JSON.stringify(to)} "example.com")) NIL NIL "<${uid}@example.com>")`;
  return `* ${seq} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE ${JSON.stringify(date)} RFC822.SIZE 260 ENVELOPE ${env})`;
}

/** A FETCH response whose BODY[] literal is a full raw message. */
export function bodyLine(seq, uid, raw, date = "16-Oct-2026 12:00:00 +0000") {
  const bytes = Buffer.from(raw, "latin1");
  return (
    `* ${seq} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE ${JSON.stringify(date)} BODY[] {${bytes.length}}\r\n` +
    `${raw})`
  );
}

/** Script helper: the standard connect handshake (capability + login OK). */
export function loginScripts(mock, { loginStatus = "OK", capabilities = "IMAP4rev1 AUTH=PLAIN" } = {}) {
  mock.script(/CAPABILITY/, `* CAPABILITY ${capabilities}\r\n{tag} OK CAPABILITY done\r\n`);
  mock.script(/LOGIN/, `{tag} ${loginStatus} LOGIN done\r\n`);
}

/**
 * Script helper for the STARTTLS connect handshake: CAPABILITY advertises
 * STARTTLS, the STARTTLS command gets an OK (the mock then upgrades the
 * socket), and the post-handshake CAPABILITY + LOGIN complete the session.
 */
export function starttlsLoginScripts(mock, { capabilities = "IMAP4rev1 STARTTLS AUTH=PLAIN" } = {}) {
  mock.script(/CAPABILITY/, `* CAPABILITY ${capabilities}\r\n{tag} OK CAPABILITY done\r\n`);
  mock.script(/STARTTLS/, "{tag} OK Begin TLS negotiation now\r\n");
  mock.script(/CAPABILITY/, `* CAPABILITY ${capabilities}\r\n{tag} OK CAPABILITY done\r\n`);
  mock.script(/LOGIN/, "{tag} OK LOGIN done\r\n");
}
