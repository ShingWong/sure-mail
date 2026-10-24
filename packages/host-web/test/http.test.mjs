// http port: direct fetch first, relay fallback on failure. Runs against a
// loopback HTTP server and a stubbed fetch — no external network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchText } from "../src/ports/http.ts";

function loopbackServer(t, handler) {
  const server = createServer(handler);
  const port = new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

test("direct fetch returns status and body", async (t) => {
  const port = await loopbackServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("direct hit");
  });
  const result = await fetchText(`http://127.0.0.1:${port}/x`, 1);
  assert.equal(result.status, 200);
  assert.equal(result.body, "direct hit");
  assert.equal(result.error, undefined);
});

test("oversized responses are rejected with the size cap", async (t) => {
  const port = await loopbackServer(t, (req, res) => {
    res.writeHead(200);
    res.end("x".repeat(2048));
  });
  const result = await fetchText(`http://127.0.0.1:${port}/big`, 2, { maxBytes: 1024 });
  assert.equal(result.error, "response exceeded 1024 bytes");
});

test("CORS-blocked fetch falls back to the relay proxy", async (t) => {
  const relayCalls = [];
  const net = {
    proxyHttp: true,
    fetchViaRelay: async (id, url) => {
      relayCalls.push({ id, url });
      return { id, status: 200, body: "via relay" };
    },
  };
  const result = await fetchText("http://mail.example.com/autoconfig.xml", 9, {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch"); // what a CORS failure looks like
    },
    net,
  });
  assert.equal(result.body, "via relay");
  assert.deepEqual(relayCalls, [{ id: 9, url: "http://mail.example.com/autoconfig.xml" }]);
});

test("no relay and a failed fetch surfaces the direct error", async () => {
  const result = await fetchText("http://127.0.0.1:1/x", 3, {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(result.error, "Failed to fetch");
  assert.equal(result.status, undefined);
});
