// The browser host in Node: REAL core.wasm + REAL relay + MockIMAP +
// the store worker (in-process endpoint, Node's in-memory sqlite-wasm).
// This is the M4 integration proof — the same driver loop, ports, and
// wire protocol the browser runs, with only the Worker and WS
// constructors swapped for Node equivalents. Zero external network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startRelay } from "../../host-node/src/index.ts";
import { MockIMAP, loginScripts, envelopeLine } from "../../host-node/test/mock-imap.mjs";
import { createMailHost } from "../src/index.ts";
import { runStoreWorker } from "../src/store/worker-main.ts";

const coreWasm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "dist", "core.wasm"));
const wsFactory = (url) => new WebSocket(url);

/** In-process store client↔worker pair (Node's sqlite-wasm is in-memory). */
function bootStore() {
  let toClient = null;
  let toWorker = null;
  const workerSide = {
    post: (msg) => queueMicrotask(() => toClient && toClient(msg)),
    onRequest: (cb) => {
      toWorker = cb;
    },
  };
  runStoreWorker(workerSide);
  return {
    post: (msg) => queueMicrotask(() => toWorker && toWorker(msg)),
    onReply: (cb) => {
      toClient = cb;
    },
  };
}

async function boot(t, options = {}) {
  const relay = await startRelay({ port: 0, ...options.relay });
  t.after(() => relay.close());
  const host = await createMailHost({
    wasm: coreWasm,
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    storeEndpoint: bootStore(),
    webSocket: wsFactory,
    log: () => {},
  });
  t.after(() => host.close());
  host.init({});
  return { host, relay };
}

const RAW_MSG = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: First message",
  "Date: Thu, 16 Oct 2026 12:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Hello from the browser host",
  "",
].join("\r\n");

test("browser host: version, init, echo op through the reactor", async (t) => {
  const { host } = await boot(t);
  assert.match(host.version(), /^\d+\.\d+\.\d+$/);
  const opId = host.startOp("echo", { msg: "browser" });
  setTimeout(() => host.feedExternal("echo.data", { id: opId, echo: "done" }), 5);
  const status = await host.drive(opId, { timeoutMs: 2000 });
  assert.equal(status.state, "done");
  assert.deepEqual(status.result, { echo: "done", msg: "browser" });
});

test("browser host: schema bootstrap + account registry persist through the store worker", async (t) => {
  const { host } = await boot(t);
  await host.ensureSchema("registry");
  const id = host.accountAdd({
    address: "me@example.com",
    host: "127.0.0.1",
    port: 14143,
    tls: false,
    user: "me@example.com",
    password: "hunter2",
  });
  assert.ok(id > 0);
  await host.flush();
  const accounts = host.accountList();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].address, "me@example.com");
});

test("browser host: imap.connect + folders + sync end-to-end vs MockIMAP", async (t) => {
  const mock = new MockIMAP();
  loginScripts(mock);
  mock.script(/LIST/, [
    `* LIST (\\HasNoChildren) "/" "INBOX"`,
    `{tag} OK LIST done`,
  ].join("\r\n") + "\r\n");
  mock.script(/SELECT "INBOX"/, [
    `* 1 EXISTS`,
    `* 0 RECENT`,
    `* OK [UIDVALIDITY 100] UIDs valid`,
    `{tag} OK [READ-WRITE] SELECT done`,
  ].join("\r\n") + "\r\n");
  mock.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE\)/, (line) => {
    const tag = line.split(" ")[0];
    return (
      envelopeLine(1, 1, "First message", "alice", "me@example.com", "16-Oct-2026 12:00:00 +0000") + "\r\n" +
      `${tag} OK UID FETCH done\r\n`
    );
  });
  mock.script(/UID FETCH 1 \(UID FLAGS INTERNALDATE BODY.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    const bytes = Buffer.byteLength(RAW_MSG, "latin1");
    return (
      `* 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE "16-Oct-2026 12:00:00 +0000" BODY[] {${bytes}}\r\n` +
      `${RAW_MSG}\r\n` +
      `${tag} OK bodies done\r\n`
    );
  });
  const port = await mock.listen();
  t.after(() => mock.close());

  const { host } = await boot(t);
  await host.ensureSchema("registry");
  const accountId = host.accountAdd({
    address: "me@example.com",
    host: "127.0.0.1",
    port,
    tls: false,
    user: "me@example.com",
    password: "hunter2",
  });
  await host.flush();
  await host.ensureSchema(`account:${accountId}`);

  // Each op opens a fresh connection; re-arm the login handshake each time.
  loginScripts(mock);
  const connectId = host.startOp("imap.connect", { account: accountId });
  const connected = await host.drive(connectId, { timeoutMs: 10000 });
  assert.equal(connected.state, "done", `connect failed: ${JSON.stringify(connected.error)}`);
  assert.ok(connected.result.capabilities.includes("IMAP4rev1"));

  loginScripts(mock);
  const foldersId = host.startOp("imap.folders", { account: accountId });
  const folders = await host.drive(foldersId, { timeoutMs: 10000 });
  assert.equal(folders.state, "done", `folders failed: ${JSON.stringify(folders.error)}`);
  const paths = folders.result.folders.map((f) => f.path);
  assert.deepEqual(paths, ["INBOX"]);

  loginScripts(mock);
  const syncId = host.startOp("imap.sync", { account: accountId, folder: "INBOX" });
  const sync = await host.drive(syncId, { timeoutMs: 10000 });
  assert.equal(sync.state, "done", `sync failed: ${JSON.stringify(sync.error)}`);
  assert.equal(sync.result.folders.length, 1);
  assert.deepEqual(sync.result.folders[0].newUids, [1]);

  // The synced message landed in the store worker — read it back via a
  // store.query op (the same path the CLI list verb uses).
  const q = host.startOp("store.query", {
    store: `account:${accountId}`,
    query: "messages",
    args: { account: accountId, folder: "INBOX", limit: 10 },
  });
  const rows = await host.drive(q, { timeoutMs: 5000 });
  assert.equal(rows.state, "done", `store.query failed: ${JSON.stringify(rows.error)}`);
  const subjects = rows.result.rows.map((r) => r.subject);
  assert.ok(subjects.includes("First message"), `expected synced subject in ${JSON.stringify(subjects)}`);
});

test("browser host: drive cancels a stalled op at the deadline", async (t) => {
  const { host } = await boot(t);
  const opId = host.startOp("echo", {});
  const status = await host.drive(opId, { timeoutMs: 50 });
  assert.equal(status.state, "cancelled");
  assert.equal(status.error?.code, -7);
});

/** Reserve a loopback port, then free it — a relay definitely not running. */
async function deadPort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

test("browser host: boots read-only when the relay is down; net ops fail, store still works", async (t) => {
  const port = await deadPort();
  const host = await createMailHost({
    wasm: coreWasm,
    relayUrl: `ws://127.0.0.1:${port}`,
    storeEndpoint: bootStore(),
    webSocket: wsFactory,
    log: () => {},
  });
  t.after(() => host.close());
  host.init({});
  assert.equal(host.net.connected, false, "no relay is connected");

  // Local store is fully usable (it is the source of truth; read-only means
  // "no IMAP/SMTP", not "no data").
  await host.ensureSchema("registry");
  const id = host.accountAdd({ address: "readonly@example.com", host: "h", port: 993, tls: true });
  assert.ok(id > 0);
  await host.flush();
  assert.ok(host.accountList().some((a) => a.address === "readonly@example.com"));

  // A net-backed op must fail cleanly rather than hang or throw out of drive.
  await host.ensureSchema(`account:${id}`);
  const opId = host.startOp("imap.connect", { account: id });
  const status = await host.drive(opId, { timeoutMs: 5000 });
  assert.notEqual(status.state, "pending", `op hung: ${JSON.stringify(status)}`);
  assert.equal(status.state, "error", `expected net failure, got ${JSON.stringify(status)}`);
});

test("browser host: lazy reconnect picks up a relay started after boot", async (t) => {
  const port = await deadPort();
  const host = await createMailHost({
    wasm: coreWasm,
    relayUrl: `ws://127.0.0.1:${port}`,
    storeEndpoint: bootStore(),
    webSocket: wsFactory,
    log: () => {},
  });
  t.after(() => host.close());
  assert.equal(host.net.connected, false);

  const relay = await startRelay({ port });
  t.after(() => relay.close());

  // The next net op retries the connection; no reload needed.
  host.net.open("lazy-probe", "127.0.0.1", 1, false);
  assert.equal(await waitFor(() => host.net.connected, 3000), true, "relay should be picked up by the next op");
});
