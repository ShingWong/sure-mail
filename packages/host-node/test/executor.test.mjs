// Effect executor: dispatch, correlation ids, error feeds, unknown kinds.
// Store/dns/http run against real temp files / loopback — no external net.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeEffect, StorePorts, storePath, dataPaths } from "../src/index.ts";

function fakeCtx(t) {
  const feeds = [];
  const logs = [];
  const ctx = {
    feeds,
    logs,
    feed: (kind, data) => feeds.push({ kind, ...data }),
    log: (level, msg) => logs.push({ level, msg }),
    net: {
      opened: [],
      upgraded: [],
      open(transport, host, port, tls) {
        this.opened.push({ transport, host, port, tls });
      },
      upgrade(transport) {
        this.upgraded.push({ transport });
      },
      write() {},
      close() {},
    },
    store: null,
  };
  const root = mkdtempSync(join(tmpdir(), "sure-mail-exec-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  ctx.store = new StorePorts((name) => storePath(paths, name));
  t.after(() => ctx.store.closeAll());
  return ctx;
}

test("log effect reaches the log sink", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "log", level: "warn", msg: "careful" }, ctx);
  assert.deepEqual(ctx.logs, [{ level: "warn", msg: "careful" }]);
});

test("net.open/net.write dispatch to the net port", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "net.open", transport: "t9", host: "h", port: 143, tls: false }, ctx);
  assert.deepEqual(ctx.net.opened, [{ transport: "t9", host: "h", port: 143, tls: false }]);
  await executeEffect({ kind: "net.open", transport: "bad" }, ctx);
  assert.equal(ctx.feeds[0].kind, "net.error", "malformed net.open feeds an error");
});

test("net.upgrade dispatches to the net port", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "net.upgrade", transport: "t9" }, ctx);
  assert.deepEqual(ctx.net.upgraded, [{ transport: "t9" }]);
});

test("store.exec feeds rows with correlation id", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "store.exec", id: 11, store: "registry", sql: "CREATE TABLE t (a, b)", params: [] }, ctx);
  await executeEffect({ kind: "store.exec", id: 12, store: "registry", sql: "INSERT INTO t VALUES (?, ?)", params: ["x", 7] }, ctx);
  await executeEffect({ kind: "store.exec", id: 13, store: "registry", sql: "SELECT a, b FROM t", params: [] }, ctx);
  assert.equal(ctx.feeds[0].id, 11);
  assert.equal(ctx.feeds[1].id, 12);
  assert.equal(ctx.feeds[1].insertId, 1);
  assert.deepEqual(ctx.feeds[2].rows, [{ a: "x", b: 7 }]);
});

test("store.exec failures feed {id, error}", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "store.exec", id: 5, store: "registry", sql: "SELECT * FROM nope", params: [] }, ctx);
  assert.equal(ctx.feeds.length, 1);
  assert.equal(ctx.feeds[0].id, 5);
  assert.equal(ctx.feeds[0].error.code, -5);
  assert.equal(ctx.feeds[0].error.where, "store.exec");
});

test("dns.lookup unsupported type feeds {unsupported:true}", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "dns.lookup", id: 3, lookup: "srv", name: "example.com" }, ctx);
  assert.deepEqual(ctx.feeds, [{ kind: "dns.result", id: 3, unsupported: true }]);
});

test("dns.lookup with a disabled DNS port degrades to {unsupported:true}", async (t) => {
  const ctx = fakeCtx(t);
  ctx.dnsDisabled = true;
  await executeEffect({ kind: "dns.lookup", id: 5, lookup: "mx", name: "example.com" }, ctx);
  assert.deepEqual(ctx.feeds, [{ kind: "dns.result", id: 5, unsupported: true }], "no resolver contact");
});

test("http.fetch gets a bounded response from a loopback server", async (t) => {
  const ctx = fakeCtx(t);
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from http");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await executeEffect({ kind: "http.fetch", id: 7, url: `http://127.0.0.1:${port}/x` }, ctx);
  const feed = ctx.feeds[0];
  assert.equal(feed.kind, "http.result");
  assert.equal(feed.id, 7);
  assert.equal(feed.status, 200);
  assert.equal(feed.body, "hello from http");
});

test("http.fetch connection failures feed an error", async (t) => {
  const ctx = fakeCtx(t);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await executeEffect({ kind: "http.fetch", id: 8, url: `http://127.0.0.1:${port}/x` }, ctx);
  assert.equal(ctx.feeds[0].id, 8);
  assert.match(String(ctx.feeds[0].error), /ECONNREFUSED|refused/);
});

test("unknown effect kinds are rejected with <kind>.result", async (t) => {
  const ctx = fakeCtx(t);
  await executeEffect({ kind: "quantum.flip", id: 21 }, ctx);
  assert.equal(ctx.logs[0].level, "warn");
  assert.deepEqual(ctx.feeds, [
    { kind: "quantum.flip.result", id: 21, error: { code: -6, where: "effect", detail: "unsupported effect kind: quantum.flip" } },
  ]);
});
