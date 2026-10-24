// store port (node:sqlite) against temp files: DDL via multi-statement
// exec, parameterized writes, row mapping, per-store file resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorePorts, storePath, dataPaths } from "../src/index.ts";

function tempStores(t) {
  const root = mkdtempSync(join(tmpdir(), "sure-mail-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = dataPaths(root);
  const stores = new StorePorts((name) => storePath(paths, name));
  t.after(() => stores.closeAll());
  return { stores, paths };
}

test("storePath maps store names to per-account files", (t) => {
  const { paths } = tempStores(t);
  assert.equal(storePath(paths, "registry"), join(paths.root, "registry.sqlite"));
  assert.equal(storePath(paths, "account:3"), join(paths.accountsDir, "3", "mail.sqlite"));
  assert.throws(() => storePath(paths, "bogus"), /unknown store/);
  assert.throws(() => storePath(paths, "account:x"), /bad store name/);
});

test("exec runs multi-statement DDL then parameterized statements", (t) => {
  const { stores, paths } = tempStores(t);
  const ddl = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
  `;
  const result = stores.exec("registry", ddl, []);
  assert.deepEqual(result, { rows: [], changes: 0, insertId: 0 });

  const ins = stores.exec("registry", "INSERT INTO notes (body) VALUES (?)", ["hello"]);
  assert.equal(ins.changes, 1);
  assert.equal(ins.insertId, 1);

  const sel = stores.exec("registry", "SELECT id, body FROM notes WHERE id = ?", [1]);
  assert.deepEqual(sel.rows, [{ id: 1, body: "hello" }]);
  assert.ok(existsSync(paths.registryDb), "registry file created on demand");
});

test("account stores are separate files", (t) => {
  const { stores, paths } = tempStores(t);
  stores.exec("registry", "CREATE TABLE t (v TEXT)", []);
  stores.exec("account:1", "CREATE TABLE t (v TEXT)", []);
  stores.exec("registry", "INSERT INTO t VALUES ('reg')", []);
  stores.exec("account:1", "INSERT INTO t VALUES ('acct')", []);
  assert.deepEqual(stores.exec("registry", "SELECT v FROM t", []).rows, [{ v: "reg" }]);
  assert.deepEqual(stores.exec("account:1", "SELECT v FROM t", []).rows, [{ v: "acct" }]);
  assert.ok(existsSync(join(paths.accountsDir, "1", "mail.sqlite")));
});

test("exec surfaces SQL errors to the caller", (t) => {
  const { stores } = tempStores(t);
  assert.throws(() => stores.exec("registry", "INSERT INTO missing VALUES (1)", []));
});

test("json coercion: bigint and blob values stay JSON-safe", (t) => {
  const { stores } = tempStores(t);
  stores.exec("registry", "CREATE TABLE t (n INTEGER, b BLOB)", []);
  stores.exec("registry", "INSERT INTO t VALUES (?, ?)", [42, Buffer.from([1, 2, 3])]);
  const row = stores.exec("registry", "SELECT n, b FROM t", []).rows[0];
  assert.equal(row.n, 42);
  assert.equal(row.b, Buffer.from([1, 2, 3]).toString("base64"), "blobs cross as base64");
});
