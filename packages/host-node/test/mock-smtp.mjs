// MockSMTP: a scripted in-process SMTP server on loopback. Tests drive
// the REAL reactor + REAL core.wasm against it — zero external network.
// Scripts are consumed in order; responses may dribble byte-by-byte
// (chunkSize) to prove the core's incremental reply parser.
//
// Connection modes (D13):
//   default          plaintext from connect
//   {tls:{...}}      implicit TLS from connect (465-style; allowSelfSigned)
//   {starttls:{...}} plaintext, then a `STARTTLS` command upgrades the live
//                    socket to TLS (587-style)
//
// The DATA phase is handled specially: the script that matches /DATA/
// carries the FINAL response (2xx/5xx after the body). The mock first
// replies "354 go ahead", accumulates the dot-stuffed body until the lone
// "." terminator, stores the transmitted payload in `messages`, then
// sends the script's response (unless onData(payload) overrides it).
import net from "node:net";
import tls from "node:tls";

export class MockSMTP {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize ?? 0;
    this.greeting = options.greeting ?? "220 mock.test ESMTP ready\r\n";
    this.ehloLines = options.ehloLines ?? ["250-mock.test", "250-AUTH PLAIN LOGIN", "250 SIZE 1048576"];
    this.scripts = [];
    this.received = []; // command lines (DATA marker included)
    this.messages = []; // full DATA payloads as transmitted (dot-stuffed)
    this.unmatched = [];
    this.connections = new Set();
    this.onData = options.onData ?? null; // (payload) => override final response
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

  /** Standard success-path script: EHLO/AUTH/MAIL/RCPT/DATA/QUIT. */
  scriptSuccess(options = {}) {
    const queueId = options.queueId ?? "ABC123";
    this.script(/EHLO/, this.ehloResponse());
    this.script(/AUTH/, options.authResponse ?? "235 2.7.0 Authentication successful\r\n");
    this.script(/MAIL FROM/, options.mailResponse ?? "250 2.1.0 Sender ok\r\n");
    this.script(/RCPT TO/, options.rcptResponse ?? "250 2.1.5 Recipient ok\r\n");
    this.script(/DATA/, `250 2.0.0 Ok: queued as ${queueId}\r\n`);
    this.script(/QUIT/, "221 2.0.0 Bye\r\n");
    return this;
  }

  /** Success-path script for STARTTLS: EHLO/STARTTLS/EHLO/AUTH/.../QUIT. */
  scriptSuccessStartTls(options = {}) {
    const queueId = options.queueId ?? "ABC123";
    this.script(/EHLO/, this.ehloResponseWithStartTls());
    this.script(/STARTTLS/, "220 2.0.0 Ready to start TLS\r\n");
    this.script(/EHLO/, this.ehloResponse());
    this.script(/AUTH/, options.authResponse ?? "235 2.7.0 Authentication successful\r\n");
    this.script(/MAIL FROM/, options.mailResponse ?? "250 2.1.0 Sender ok\r\n");
    this.script(/RCPT TO/, options.rcptResponse ?? "250 2.1.5 Recipient ok\r\n");
    this.script(/DATA/, `250 2.0.0 Ok: queued as ${queueId}\r\n`);
    this.script(/QUIT/, "221 2.0.0 Bye\r\n");
    return this;
  }

  ehloResponse() {
    return () => this.ehloLines.map((l) => (l.endsWith("\r\n") ? l : l + "\r\n")).join("");
  }

  /** Like ehloResponse, but guarantees the pre-STARTTLS EHLO advertises it. */
  ehloResponseWithStartTls() {
    const lines = [...this.ehloLines];
    if (!lines.some((l) => /STARTTLS/i.test(l))) lines.splice(lines.length - 1, 0, "250-STARTTLS");
    return () => lines.map((l) => (l.endsWith("\r\n") ? l : l + "\r\n")).join("");
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
    const state = { socket, onData: null, buffer: "", inData: false, dataBuf: "", finalResponse: null };
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
    if (state.inData) {
      state.dataBuf += data;
      const end = state.dataBuf.indexOf("\r\n.\r\n");
      if (end < 0) return;
      const payload = state.dataBuf.slice(0, end + 2); // keep trailing CRLF
      const rest = state.dataBuf.slice(end + 5);
      state.inData = false;
      state.dataBuf = "";
      this.messages.push(payload);
      this.write(state.socket, this.onData ? this.onData(payload) : state.finalResponse);
      data = rest;
      if (data.length === 0) return;
    }
    state.buffer += data;
    let idx;
    while ((idx = state.buffer.indexOf("\r\n")) >= 0 && !state.inData) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 2);
      const finalResponse = this.onLine(state, line);
      if (finalResponse !== null) {
        // DATA accepted: 354 sent; the rest of the buffer is the body
        state.inData = true;
        state.finalResponse = finalResponse;
        state.dataBuf = state.buffer;
        state.buffer = "";
      }
    }
  }

  /** Handle one command line. Returns the pending DATA final response,
   * or null when no data phase was opened. */
  onLine(state, line) {
    this.received.push(line);
    const script = this.scripts.find((s) => !s.used && s.expect.test(line));
    if (!script) {
      this.unmatched.push(line);
      this.write(state.socket, "500 5.5.2 unexpected command in mock\r\n");
      return null;
    }
    script.used = true;
    const isData = /(^|\s)DATA(\s|$)/.test(line);
    if (isData) {
      // open the body phase; the script's respond is the final reply
      const respond = typeof script.respond === "function" ? script.respond(line) : script.respond;
      this.write(state.socket, "354 End data with <CR><LF>.<CR><LF>\r\n");
      return respond;
    }
    const respond = typeof script.respond === "function" ? script.respond(line) : script.respond;
    this.write(state.socket, respond);
    // A STARTTLS command flips the connection to TLS after the 220 reply.
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
