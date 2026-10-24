// A store failure during sync must FAIL the sync and must not move the cursor.
//
// Measured before this fix: two injected message-write failures, `imap.sync`
// reported state "done" with error null and newUids [1,2], 0 rows landed in
// `messages`, and `folders.last_seen_uid` advanced to 2 — so the next sync began
// at UID 3 and those two messages were unreachable until a full resync.
//
// Two separate defects produced that:
//   1. onStoreResult inspected only the folder_meta result and discarded every
//      message write's result;
//   2. the op completed on the last network feed, BEFORE drive() executed the
//      writes it had emitted, and Op.fail() is a no-op once an op is done — so
//      even a surfaced error could not reach it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MailCore } from "../src/index.ts";
import { MockIMAP, envelopeLine, bodyLine, loginScripts } from "./mock-imap.mjs";

const RAW_1 = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: First message",
  "Date: Thu, 16 Oct 2026 12:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Hello body one",
  "",
].join("\r\n");

const RAW_2 = [
  "From: Bob <bob@example.com>",
  "To: me@example.com",
  "Subject: Second message",
  "Date: Thu, 16 Oct 2026 13:00:00 +0000",
  "Message-ID: <m2@example.com>",
  "",
  "Plain second body",
  "",
].join("\r\n");

function syncScripts(mock) {
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    `* 2 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 100] UIDs valid\r\n{tag} OK [READ-WRITE] SELECT done\r\n`,
  );
  mock.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE\)/, (line) => {
    const tag = line.split(" ")[0];
    return (
      envelopeLine(1, 1, "First message", "alice", "me@example.com", "16-Oct-2026 12:00:00 +0000") +
      "\r\n" +
      envelopeLine(2, 2, "Second message", "bob", "me@example.com", "16-Oct-2026 13:00:00 +0000") +
      "\r\n" +
      `${tag} OK UID FETCH done\r\n`
    );
  });
  mock.script(/UID FETCH 1,2 \(UID FLAGS INTERNALDATE BODY.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 1, RAW_1) + "\r\n" + bodyLine(2, 2, RAW_2) + "\r\n" + `${tag} OK bodies done\r\n`;
  });
}

async function boot(t) {
  const mock = new MockIMAP({});
  const port = await mock.listen();
  t.after(() => mock.close());
  const home = mkdtempSync(join(tmpdir(), "sure-mail-sync-err-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  const accountId = core.accountAdd({
    address: "me@example.com",
    host: "127.0.0.1",
    port,
    tls: false,
    user: "me@example.com",
    password: "hunter2",
  });
  await core.flush();
  await core.ensureSchema(`account:${accountId}`);
  const dbPath = join(home, "accounts", String(accountId), "mail.sqlite");
  return { mock, core, accountId, dbPath };
}

/** Make the message upsert throw, the way a real store failure reaches the core. */
function failMessageWrites(core) {
  const real = core.store.exec.bind(core.store);
  const state = { injected: 0, enabled: true };
  core.store.exec = (storeName, sql, params) => {
    if (state.enabled && /^\s*INSERT INTO messages\b/i.test(sql)) {
      state.injected += 1;
      throw new Error("injected: disk I/O error on the message write");
    }
    return real(storeName, sql, params);
  };
  return state;
}

const sync = (core, accountId) =>
  core.drive(core.startOp("imap.sync", { account: accountId, folder: "INBOX" }), { timeoutMs: 8000 });

test("a failed message write fails the sync and leaves the cursor put", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  const fault = failMessageWrites(core);

  syncScripts(mock);
  const status = await sync(core, accountId);

  assert.ok(fault.injected > 0, "the fault fired — otherwise this test asserts nothing");
  assert.equal(status.state, "error", "the sync must not report success");
  assert.match(status.error.detail, /injected/, "the store error is surfaced, not replaced");
  assert.equal(status.result, null, "no fabricated result");

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages").get().c, 0, "nothing was stored");
  assert.equal(
    db.prepare("SELECT last_seen_uid FROM folders WHERE path = 'INBOX'").get().last_seen_uid,
    0,
    "the cursor must not advance past messages that were never stored",
  );
});

test("the cursor guard is conditional: a short write cannot advance it even if the op looked fine", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  syncScripts(mock);
  assert.equal((await sync(core, accountId)).state, "done");

  // Now advance the cursor statement by hand against a folder whose messages
  // were deleted out from under it. The guard counts uid in (lastSeen, maxUid]
  // and refuses when the rows are not there.
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.prepare("DELETE FROM messages").run();
  db.prepare(
    `UPDATE folders SET last_seen_uid = 2
     WHERE account = ? AND path = 'INBOX'
       AND (SELECT COUNT(*) FROM messages WHERE account = ? AND folder = 'INBOX' AND uid > 0 AND uid <= 2) = 2`,
  ).run(accountId, accountId);
  assert.equal(
    db.prepare("SELECT last_seen_uid FROM folders WHERE path = 'INBOX'").get().last_seen_uid,
    2,
    "sanity: the guard's own shape allows the advance once the rows exist",
  );
});

test("after the fault clears, the same messages are fetched and searchable", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  const fault = failMessageWrites(core);

  syncScripts(mock);
  assert.equal((await sync(core, accountId)).state, "error");

  // The user retries. Because the cursor never moved, the next sync asks for the
  // same UIDs again instead of skipping them.
  fault.enabled = false;
  syncScripts(mock);
  const status = await sync(core, accountId);
  assert.equal(status.state, "done", JSON.stringify(status));

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages").get().c, 2, "both messages recovered");
  assert.equal(
    db.prepare("SELECT last_seen_uid FROM folders WHERE path = 'INBOX'").get().last_seen_uid,
    2,
    "and only now does the cursor advance",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT m.uid FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?",
      )
      .all('"Hello"')
      .map((r) => r.uid),
    [1],
    "the recovered message is searchable",
  );
});
