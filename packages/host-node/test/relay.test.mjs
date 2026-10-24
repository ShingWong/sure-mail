// relay: Node WS client ⇄ relay ⇄ MockIMAP/loopback TCP. Covers the wire
// protocol in docs/relay.md — open/write/data/eof/error, TLS
// (self-signed fixture), multiple transports per connection, failure
// modes, and the dns/http proxies. Zero external network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startRelay } from "../src/index.ts";
import { MockIMAP, loginScripts } from "./mock-imap.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};

async function bootRelay(t, options = {}) {
  const relay = await startRelay({ port: 0, ...options });
  t.after(() => relay.close());
  return relay;
}

function connect(t, relay) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    const frames = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      const idx = waiters.findIndex((w) => w.match(frame));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(frame);
      } else {
        frames.push(frame);
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        send: (frame) => ws.send(JSON.stringify(frame)),
        /** Wait for the next frame matching pred (queued frames count). */
        wait: (pred, timeoutMs = 2000) =>
          new Promise((res, rej) => {
            const idx = frames.findIndex(pred);
            if (idx >= 0) {
              res(frames.splice(idx, 1)[0]);
              return;
            }
            const timer = setTimeout(() => {
              rej(new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`));
            }, timeoutMs);
            waiters.push({ match: pred, resolve: (f) => {
              clearTimeout(timer);
              res(f);
            } });
          }),
      }),
    );
    ws.on("error", reject);
    t.after(() => ws.close());
  });
}

function echoServer(t) {
  return new Promise((resolve) => {
    const sockets = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (buf) => socket.write(Buffer.concat([buf, Buffer.from("!")])));
    });
    server.listen(0, "127.0.0.1", () => {
      t.after(() => {
        for (const s of sockets) s.destroy();
        server.close();
      });
      resolve({ port: server.address().port, sockets });
    });
  });
}

test("open/write/data/eof/close against a loopback echo server", async (t) => {
  const relay = await bootRelay(t);
  const { port } = await echoServer(t);
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "t1", host: "127.0.0.1", port, tls: false });
  const opened = await client.wait((f) => f.kind === "opened");
  assert.equal(opened.transport, "t1");

  client.send({ kind: "write", transport: "t1", b64: Buffer.from("hello").toString("base64") });
  const data = await client.wait((f) => f.kind === "data");
  assert.equal(data.transport, "t1");
  assert.equal(Buffer.from(data.b64, "base64").toString(), "hello!");

  client.send({ kind: "close", transport: "t1" });
  const eof = await client.wait((f) => f.kind === "eof");
  assert.equal(eof.transport, "t1");
});

test("implicit TLS with self-signed certs passes with allowSelfSigned", async (t) => {
  const relay = await bootRelay(t, { allowSelfSigned: true });
  const mock = new MockIMAP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "tls1", host: "127.0.0.1", port, tls: true });
  const opened = await client.wait((f) => f.kind === "opened");
  assert.equal(opened.transport, "tls1");

  const greeting = await client.wait((f) => f.kind === "data");
  assert.match(Buffer.from(greeting.b64, "base64").toString(), /OK.*mock ready/);

  client.send({ kind: "close", transport: "tls1" });
});

test("strict TLS rejects a self-signed cert with an error frame", async (t) => {
  const relay = await bootRelay(t, { allowSelfSigned: false });
  const mock = new MockIMAP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "strict", host: "127.0.0.1", port, tls: true });
  const err = await client.wait((f) => f.kind === "error");
  assert.equal(err.transport, "strict");
  assert.match(err.error, /self.signed|unable to verify|self-signed certificate/i);
});

test("upgrade frame performs STARTTLS over an existing plaintext transport", async (t) => {
  const relay = await bootRelay(t, { allowSelfSigned: true });
  const server = tls.createServer(TLS_OPTS, (socket) => {
    socket.on("data", (buf) => socket.write(Buffer.concat([buf, Buffer.from("!")])));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "st", host: "127.0.0.1", port: server.address().port, tls: false });
  await client.wait((f) => f.kind === "opened" && f.transport === "st");
  client.send({ kind: "upgrade", transport: "st" });
  const upgraded = await client.wait((f) => f.kind === "upgraded" && f.transport === "st");
  assert.equal(upgraded.transport, "st");

  // data flows decrypted after the handshake
  client.send({ kind: "write", transport: "st", b64: Buffer.from("ping").toString("base64") });
  const data = await client.wait((f) => f.kind === "data" && f.transport === "st");
  assert.equal(Buffer.from(data.b64, "base64").toString(), "ping!");
});

test("upgrade failure modes: unknown transport and a non-TLS peer", async (t) => {
  const relay = await bootRelay(t, { allowSelfSigned: true, connectTimeoutMs: 400 });
  const client = await connect(t, relay);

  client.send({ kind: "upgrade", transport: "nope" });
  const unknown = await client.wait((f) => f.kind === "error" && f.transport === "nope");
  assert.match(unknown.error, /unknown transport/);

  // a plain TCP peer that never speaks TLS: the handshake times out
  const silentSockets = [];
  const silent = net.createServer((socket) => silentSockets.push(socket));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of silentSockets) socket.destroy();
    silent.close();
  });
  client.send({ kind: "open", transport: "plain", host: "127.0.0.1", port: silent.address().port, tls: false });
  await client.wait((f) => f.kind === "opened" && f.transport === "plain");
  client.send({ kind: "upgrade", transport: "plain" });
  const failed = await client.wait((f) => f.kind === "error" && f.transport === "plain");
  assert.match(failed.error, /timeout/i);
});

test("one WS connection multiplexes many transports", async (t) => {
  const relay = await bootRelay(t);
  const a = await echoServer(t);
  const b = await echoServer(t);
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "a", host: "127.0.0.1", port: a.port, tls: false });
  client.send({ kind: "open", transport: "b", host: "127.0.0.1", port: b.port, tls: false });
  await client.wait((f) => f.kind === "opened" && f.transport === "a");
  await client.wait((f) => f.kind === "opened" && f.transport === "b");

  client.send({ kind: "write", transport: "a", b64: Buffer.from("A").toString("base64") });
  client.send({ kind: "write", transport: "b", b64: Buffer.from("B").toString("base64") });
  const da = await client.wait((f) => f.kind === "data" && f.transport === "a");
  const db = await client.wait((f) => f.kind === "data" && f.transport === "b");
  assert.equal(Buffer.from(da.b64, "base64").toString(), "A!");
  assert.equal(Buffer.from(db.b64, "base64").toString(), "B!");

  // transports are independent: closing "a" leaves "b" alive
  client.send({ kind: "close", transport: "a" });
  await client.wait((f) => f.kind === "eof" && f.transport === "a");
  client.send({ kind: "write", transport: "b", b64: Buffer.from("C").toString("base64") });
  const still = await client.wait((f) => f.kind === "data" && f.transport === "b");
  assert.equal(Buffer.from(still.b64, "base64").toString(), "C!");
});

test("failure modes: refused port, unknown transport, double open, malformed frames", async (t) => {
  const relay = await bootRelay(t);
  const { port } = await echoServer(t);
  const client = await connect(t, relay);

  // connection refused: grab an ephemeral port that nothing listens on
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  client.send({ kind: "open", transport: "dead", host: "127.0.0.1", port: deadPort, tls: false });
  const refused = await client.wait((f) => f.kind === "error" && f.transport === "dead");
  assert.match(refused.error, /ECONNREFUSED|refused/);

  client.send({ kind: "open", transport: "ok", host: "127.0.0.1", port, tls: false });
  await client.wait((f) => f.kind === "opened" && f.transport === "ok");
  client.send({ kind: "open", transport: "ok", host: "127.0.0.1", port, tls: false });
  const dup = await client.wait((f) => f.kind === "error" && f.transport === "ok");
  assert.match(dup.error, /already open/);

  client.send({ kind: "write", transport: "nope", b64: "" });
  const unknown = await client.wait((f) => f.kind === "error" && f.transport === "nope");
  assert.match(unknown.error, /unknown transport/);

  // bad host name → error for that transport
  client.send({ kind: "open", transport: "badhost", host: "nonexistent.invalid", port: 80, tls: false });
  const bad = await client.wait((f) => f.kind === "error" && f.transport === "badhost");
  assert.ok(bad.error.length > 0);

  // malformed frames answer with a transport-less error; connection survives
  client.ws.send("not json");
  const malformed = await client.wait((f) => f.kind === "error" && f.transport === undefined);
  assert.match(malformed.error, /malformed JSON/);
  client.send({ kind: "write", transport: "ok", b64: Buffer.from("still here").toString("base64") });
  const alive = await client.wait((f) => f.kind === "data" && f.transport === "ok");
  assert.equal(Buffer.from(alive.b64, "base64").toString(), "still here!");
});

test("dns.lookup proxy answers unsupported types without touching the network", async (t) => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());
  const client = await connect(t, relay);
  client.send({ kind: "dns.lookup", id: 7, lookup: "srv", name: "example.invalid" });
  const result = await client.wait((f) => f.kind === "dns.result");
  assert.equal(result.id, 7);
  assert.equal(result.unsupported, true);
});

test("http.fetch proxy serves a loopback GET and reports errors", async (t) => {
  const relay = await bootRelay(t);
  const client = await connect(t, relay);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("autoconfig-body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  client.send({ kind: "http.fetch", id: 3, url: `http://127.0.0.1:${server.address().port}/` });
  const result = await client.wait((f) => f.kind === "http.result");
  assert.equal(result.id, 3);
  assert.equal(result.status, 200);
  assert.equal(result.body, "autoconfig-body");

  client.send({ kind: "http.fetch", id: 4, url: "http://127.0.0.1:1/" });
  const err = await client.wait((f) => f.kind === "http.result" && f.id === 4);
  assert.ok(err.error.length > 0);
});

test("relay answers pings on loopback and exposes the bound port", async (t) => {
  const relay = await startRelay({ port: 0, host: "127.0.0.1" });
  t.after(() => relay.close());
  assert.ok(Number.isInteger(relay.port) && relay.port > 0);
  const client = await connect(t, relay);
  // a protocol error frame proves the loopback socket serves us
  client.ws.send("not json");
  const malformed = await client.wait((f) => f.kind === "error");
  assert.match(malformed.error, /malformed JSON/);
});

test("oversized frames are protocol errors and close the transport cleanly", async (t) => {
  const relay = await bootRelay(t, { maxFrameBytes: 1024 });
  const { port } = await echoServer(t);
  const client = await connect(t, relay);

  client.send({ kind: "open", transport: "t1", host: "127.0.0.1", port, tls: false });
  await client.wait((f) => f.kind === "opened" && f.transport === "t1");

  client.send({ kind: "write", transport: "t1", b64: Buffer.alloc(3000, 7).toString("base64") });
  const err = await client.wait((f) => f.kind === "error" && f.transport === "t1");
  assert.match(err.error, /frame exceeds 1024 bytes/);

  // the offending transport was torn down: further writes feed unknown transport
  client.send({ kind: "write", transport: "t1", b64: Buffer.from("x").toString("base64") });
  const gone = await client.wait(
    (f) => f.kind === "error" && f.transport === "t1" && /unknown transport/.test(f.error),
  );
  assert.match(gone.error, /unknown transport/);

  // the WS connection itself stays usable for other work
  client.ws.send("not json");
  const malformed = await client.wait((f) => f.kind === "error" && /malformed JSON/.test(f.error));
  assert.match(malformed.error, /malformed JSON/);
});

test("relay binds 127.0.0.1 only — never 0.0.0.0 — and refuses non-loopback hosts", async (t) => {
  const relay = await bootRelay(t);
  const address = relay.address();
  assert.equal(address.family, "IPv4");
  assert.equal(address.address, "127.0.0.1");
  assert.notEqual(address.address, "0.0.0.0");

  // If the host has a non-loopback IPv4, connecting to it must not reach
  // the relay — it would if the bind were 0.0.0.0.
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === "IPv4" && !iface.internal);
  if (external) {
    const reached = await new Promise((resolve) => {
      const socket = net.connect({ host: external.address, port: relay.port });
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    assert.equal(reached, false, `relay must not accept connections on ${external.address}`);
  }

  await assert.rejects(startRelay({ port: 0, host: "0.0.0.0" }), /loopback only/);
});
