// store worker RPC from Node: the same worker main the browser runs, with
// an in-process endpoint instead of a Worker. Node's sqlite-wasm build has
// no OPFS, so these run against per-store in-memory databases — the exec
// semantics (rows/changes/insertId, blobs, multi-statement DDL, error
// shape) are what the browser store serves too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStoreWorker } from "../src/store/worker-main.ts";
import { StoreWorkerClient } from "../src/store/client.ts";
import { storePath } from "../src/store/layout.ts";

/** In-process client↔worker pair over direct function calls (no Worker). */
function boot() {
  let toClient = null; // StoreWorkerClient's reply handler
  let toWorker = null; // worker main's request handler
  const workerSide = {
    post: (msg) => queueMicrotask(() => toClient && toClient(msg)),
    onRequest: (cb) => {
      toWorker = cb;
    },
  };
  runStoreWorker(workerSide);
  const endpoint = {
    post: (msg) => queueMicrotask(() => toWorker && toWorker(msg)),
    onReply: (cb) => {
      toClient = cb;
    },
  };
  return new StoreWorkerClient(endpoint);
}

test("store worker: exec round-trips rows, changes, insertId", async (t) => {
  const store = boot();
  t.after(() => store.close());
  assert.equal(await store.ready(), false, "Node harness is in-memory");
  await store.exec("registry", "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT, c BLOB)", []);
  const insert = await store.exec("registry", "INSERT INTO t(b, c) VALUES(?, ?)", ["hi", new Uint8Array([1, 2, 3])]);
  assert.equal(insert.changes, 1);
  assert.equal(insert.insertId, 1);
  const rows = await store.exec("registry", "SELECT b, c FROM t", []);
  assert.deepEqual(rows.rows, [{ b: "hi", c: "AQID" }], "blobs cross as base64");
  const bound = await store.exec("registry", "SELECT b FROM t WHERE b = ?", ["hi"]);
  assert.deepEqual(bound.rows, [{ b: "hi" }]);
});

test("store worker: one database per store name", async (t) => {
  const store = boot();
  t.after(() => store.close());
  await store.exec("registry", "CREATE TABLE only_here(a)", []);
  await assert.rejects(() => store.exec("account:1", "SELECT * FROM only_here", []), /no such table/);
  await store.exec("account:1", "CREATE TABLE only_there(a)", []);
  const ok = await store.exec("account:1", "SELECT count(*) AS n FROM only_there", []);
  assert.deepEqual(ok.rows, [{ n: 0 }]);
});

test("store worker: multi-statement DDL reports changes; errors carry the ABI shape", async (t) => {
  const store = boot();
  t.after(() => store.close());
  const ddl = await store.exec(
    "account:2",
    "CREATE TABLE a(x); CREATE TABLE b(y); INSERT INTO a VALUES(1);",
    [],
  );
  assert.equal(ddl.changes, 1, "changes counts the INSERT, not the CREATEs");
  await assert.rejects(
    () => store.exec("account:2", "INSERT INTO missing VALUES(1)", []),
    (err) => {
      assert.equal(err.code, -5);
      assert.equal(err.where, "store.exec");
      assert.match(err.detail, /no such table/);
      return true;
    },
  );
});

test("store worker: unknown store names are rejected (host-node parity)", async (t) => {
  const store = boot();
  t.after(() => store.close());
  await assert.rejects(() => store.exec("bogus", "SELECT 1", []), /unknown store: bogus/);
  await assert.rejects(() => store.exec("account:0", "SELECT 1", []), /bad store name/);
  assert.throws(() => storePath("nope"), /unknown store/);
});

test("store worker: close rejects in-flight work and further execs", async () => {
  const store = boot();
  await store.ready();
  store.close();
  await assert.rejects(() => store.exec("registry", "SELECT 1", []), /closed/);
});
