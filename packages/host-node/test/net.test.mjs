// net port against a loopback TCP server: open/write/data/eof/error
// events as feeds, transport lifecycle, no external network. Includes the
// STARTTLS upgrade path (net.upgrade -> net.upgraded) against a real TLS
// listener (D13).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NetPorts } from "../src/index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};

function loopbackServer(t) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const sockets = [];
    server.on("connection", (socket) => {
      sockets.push(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      t.after(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      });
      resolve({ server, port: server.address().port, sockets });
    });
  });
}

function collector() {
  const events = [];
  const sink = (kind, data) => events.push({ kind, ...data });
  return { events, sink };
}

function waitFor(events, kind, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find((e) => e.kind === kind);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${kind}; got ${JSON.stringify(events)}`));
      }
    }, 5);
  });
}

test("net.open/write/data/eof roundtrip on loopback", async (t) => {
  const { port, sockets } = await loopbackServer(t);
  const { events, sink } = collector();
  const netPort = new NetPorts(sink);
  t.after(() => netPort.closeAll());

  netPort.open("t1", "127.0.0.1", port, false);
  const opened = await waitFor(events, "net.opened");
  assert.equal(opened.transport, "t1");

  sockets[0].on("data", (buf) => {
    // echo server: send back what the client wrote, with a suffix
    sockets[0].write(Buffer.concat([buf, Buffer.from("!")]));
  });

  netPort.write("t1", Buffer.from("ping"));
  const data = await waitFor(events, "net.data");
  assert.equal(Buffer.from(data.b64, "base64").toString(), "ping!");

  sockets[0].end();
  await waitFor(events, "net.eof");
});

test("connection refused feeds net.error", async (t) => {
  // Bind then close a server to get a port that is definitely refused.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  const { events, sink } = collector();
  const netPort = new NetPorts(sink, { connectTimeoutMs: 2000 });
  t.after(() => netPort.closeAll());
  netPort.open("tX", "127.0.0.1", port, false);
  const err = await waitFor(events, "net.error");
  assert.equal(err.transport, "tX");
  assert.match(String(err.error), /ECONNREFUSED|refused/);
});

test("writes to unknown transports feed net.error", async () => {
  const { events, sink } = collector();
  const netPort = new NetPorts(sink);
  netPort.write("nope", Buffer.from("x"));
  const err = await waitFor(events, "net.error");
  assert.match(String(err.error), /unknown transport/);
  netPort.closeAll();
});

test("close of an unknown transport is a no-op", () => {
  const netPort = new NetPorts(() => {});
  netPort.close("nope");
  netPort.closeAll();
});

test("net.upgrade performs STARTTLS on a live plaintext socket", async (t) => {
  // A real TLS listener: it waits for a ClientHello, which the upgrade
  // sends over the already-open plaintext connection.
  const server = tls.createServer(TLS_OPTS, (socket) => {
    socket.on("data", (buf) => socket.write(Buffer.concat([buf, Buffer.from("!")])));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { events, sink } = collector();
  const netPort = new NetPorts(sink, { allowSelfSigned: true });
  t.after(() => netPort.closeAll());

  netPort.open("t1", "127.0.0.1", server.address().port, false);
  await waitFor(events, "net.opened");

  netPort.upgrade("t1");
  const upgraded = await waitFor(events, "net.upgraded");
  assert.equal(upgraded.transport, "t1");

  // subsequent writes/reads use the upgraded socket (decrypted both ways)
  netPort.write("t1", Buffer.from("ping"));
  const data = await waitFor(events, "net.data");
  assert.equal(Buffer.from(data.b64, "base64").toString(), "ping!");
});

test("net.upgrade on a non-TLS peer feeds net.error and forgets the transport", async (t) => {
  // A plain TCP server that never speaks TLS: the handshake stalls.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { events, sink } = collector();
  const netPort = new NetPorts(sink, { connectTimeoutMs: 400 });
  t.after(() => netPort.closeAll());
  netPort.open("t1", "127.0.0.1", server.address().port, false);
  await waitFor(events, "net.opened");

  netPort.upgrade("t1");
  const err = await waitFor(events, "net.error", 3000);
  assert.equal(err.transport, "t1");
  assert.match(String(err.error), /timeout/i);

  // the transport is forgotten: writes now report unknown transport
  events.length = 0;
  netPort.write("t1", Buffer.from("x"));
  const gone = await waitFor(events, "net.error", 2000);
  assert.match(String(gone.error), /unknown transport/);
});

test("net.upgrade of an unknown transport feeds net.error", async () => {
  const { events, sink } = collector();
  const netPort = new NetPorts(sink);
  netPort.upgrade("nope");
  const err = await waitFor(events, "net.error");
  assert.match(String(err.error), /unknown transport/);
  netPort.closeAll();
});
