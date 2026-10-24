// net port vs the real relay: the browser port speaks relay frames; the
// relay owns TCP/TLS; MockIMAP is the far end. Covers open/write/data/
// eof/error, multiple transports per WebSocket, TLS through the relay
// (self-signed fixture), the dns/http proxies, and WS-close teardown.
// Zero external network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startRelay } from "../../host-node/src/index.ts";
import { MockIMAP, loginScripts } from "../../host-node/test/mock-imap.mjs";
import { RelayNetPorts } from "../src/ports/net.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "host-node", "test", "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};
const wsFactory = (url) => new WebSocket(url);

async function boot(t, options = {}) {
  const relay = await startRelay({ port: 0, ...options });
  t.after(() => relay.close());
  const events = [];
  const feeds = [];
  const net = new RelayNetPorts(
    (kind, data) => {
      events.push({ kind, ...data });
      feeds.push({ kind, data });
    },
    { url: `ws://127.0.0.1:${relay.port}`, webSocket: wsFactory },
  );
  await net.connect();
  t.after(() => net.closeAll());
  return { relay, net, events };
}

function waitFor(events, kind, transport, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const poll = setInterval(() => {
      const idx = events.findIndex((e) => e.kind === kind && (transport === undefined || e.transport === transport));
      if (idx < 0) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(events[idx]);
    }, 5);
    timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timed out waiting for ${kind}/${transport}; got ${JSON.stringify(events)}`));
    }, timeoutMs);
  });
}

test("open/write/data/eof through the relay to MockIMAP", async (t) => {
  const mock = new MockIMAP();
  loginScripts(mock);
  const port = await mock.listen();
  t.after(() => mock.close());
  const { net, events } = await boot(t);
  net.open("imap-1", "127.0.0.1", port, false);
  await waitFor(events, "net.opened", "imap-1");
  net.write("imap-1", new TextEncoder().encode("a1 LOGIN me@example.com hunter2\r\n"));
  await waitFor(events, "net.data", "imap-1");
  net.close("imap-1");
  await waitFor(events, "net.eof", "imap-1");
});

test("TLS transport through the relay (self-signed upstream)", async (t) => {
  const mock = new MockIMAP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  const { net, events } = await boot(t, { allowSelfSigned: true });
  net.open("imaps-1", "127.0.0.1", port, true);
  const opened = await waitFor(events, "net.opened", "imaps-1");
  assert.equal(opened.transport, "imaps-1");
  const data = await waitFor(events, "net.data", "imaps-1");
  assert.ok(data.b64.length > 0, "greeting bytes arrive as base64");
  net.close("imaps-1");
});

test("net.upgrade STARTTLSes through the relay to a TLS listener", async (t) => {
  const server = tls.createServer(TLS_OPTS, (socket) => {
    socket.on("data", (buf) => socket.write(Buffer.concat([buf, Buffer.from("!")])));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { net, events } = await boot(t, { allowSelfSigned: true });

  net.open("st", "127.0.0.1", server.address().port, false);
  await waitFor(events, "net.opened", "st");
  net.upgrade("st");
  const upgraded = await waitFor(events, "net.upgraded", "st");
  assert.equal(upgraded.transport, "st");

  net.write("st", new TextEncoder().encode("ping"));
  const data = await waitFor(events, "net.data", "st");
  assert.equal(Buffer.from(data.b64, "base64").toString(), "ping!");
});

test("one WebSocket multiplexes many transports", async (t) => {
  const mock = new MockIMAP({});
  const port = await mock.listen();
  t.after(() => mock.close());
  const { net, events } = await boot(t);
  net.open("a", "127.0.0.1", port, false);
  net.open("b", "127.0.0.1", port, false);
  await waitFor(events, "net.opened", "a");
  await waitFor(events, "net.opened", "b");
  net.write("b", new TextEncoder().encode("X1 NOOP\r\n"));
  const data = await waitFor(events, "net.data", "b");
  assert.equal(data.transport, "b", "frames stay correlated per transport");
});

test("connect failure surfaces as net.error; unknown transport writes are rejected", async (t) => {
  const { net: ports, events } = await boot(t);
  // A port nothing listens on: bind then close to get a dead loopback port.
  const probe = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  ports.open("dead", "127.0.0.1", probe, false);
  const err = await waitFor(events, "net.error", "dead");
  assert.match(err.error, /ECONNREFUSED|connect|refused/i);
  ports.write("never-opened", new Uint8Array([1]));
  const writeErr = await waitFor(events, "net.error", "never-opened");
  assert.match(writeErr.error, /unknown transport/);
});

test("relay connection drop errors every open transport (core retries per spec)", async (t) => {
  const mock = new MockIMAP({});
  const port = await mock.listen();
  t.after(() => mock.close());
  const { net: ports, events, relay } = await boot(t);
  ports.open("x", "127.0.0.1", port, false);
  await waitFor(events, "net.opened", "x");
  // The relay dies underneath us — every transport must surface an error.
  await relay.close();
  const err = await waitFor(events, "net.error", "x");
  assert.match(err.error, /relay/);
});

test("dns.lookup is proxied through the relay", async (t) => {
  const { net } = await boot(t);
  const result = await net.lookup(1, "nonexistent.invalid", "mx");
  assert.equal(result.id, 1);
  assert.ok("error" in result || "unsupported" in result, `dns failure degrades, got ${JSON.stringify(result)}`);
});

test("dns.lookup with no relay answers {unsupported:true} (ABI degradation)", async () => {
  const net = new RelayNetPorts(() => {}, { url: "ws://127.0.0.1:1", webSocket: wsFactory });
  assert.deepEqual(await net.lookup(7, "example.com", "a"), { unsupported: true });
});

test("http.fetch is proxied through the relay to a loopback server", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("autoconfig payload");
  });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { net } = await boot(t);
  const result = await net.fetchViaRelay(3, `http://127.0.0.1:${port}/mail/config-v1.1.xml`);
  assert.equal(result.id, 3);
  assert.equal(result.status, 200);
  assert.equal(result.body, "autoconfig payload");
});
