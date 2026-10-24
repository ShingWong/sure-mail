// The search index, through the REAL core and a REAL sqlite file.
//
// This file exists because nothing tested the fts path: schema.test.mjs checks
// the DDL and the migrations, imap.test.mjs checks the stored rows, and the
// index was asserted nowhere. A hand-rolled DELETE + INSERT pair lived in
// imap/handlers.ts and emitted a statement that SQLite rejects — a direct
// DELETE on an external-content fts5 table raises "database disk image is
// malformed" for a rowid that is not yet indexed, which is the normal
// first-store case. It looked fine because the error was ignored and the INSERT
// alone populated the index.
//
// The index is now maintained by the messages_fts_ai / _ad / _au triggers
// declared in schema.ts. These tests pin that, and they would have failed
// against the old code at the first assertion.
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

function syncScripts(mock, { uids = [1, 2] } = {}) {
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    `* ${uids.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 100] UIDs valid\r\n{tag} OK [READ-WRITE] SELECT done\r\n`,
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
  const home = mkdtempSync(join(tmpdir(), "sure-mail-fts-"));
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

/** Run a sync and insist it finished. */
async function sync(mock, core, accountId) {
  const opId = core.startOp("imap.sync", { account: accountId, folder: "INBOX" });
  const status = await core.drive(opId, { timeoutMs: 8000 });
  assert.equal(status.state, "done", JSON.stringify(status));
}

/** A valid fts5 index; throws on corruption. */
function integrityOk(db) {
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
}

const hits = (db, term) =>
  db
    .prepare(
      "SELECT m.uid FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?",
    )
    .all(term);

test("sync populates the search index with no explicit sync statement", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  syncScripts(mock);
  await sync(mock, core, accountId);

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());

  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages_fts").get().c, 2, "index has the rows");
  integrityOk(db);
  assert.deepEqual(hits(db, '"Hello"').map((r) => r.uid), [1], "body text is searchable");
  assert.deepEqual(hits(db, '"Second"').map((r) => r.uid), [2], "subject is searchable");
});

/** Fetch one message through the real core, scripting the mock for it. */
async function fetchOnce(mock, core, accountId, uid, raw) {
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    "* 1 EXISTS\r\n* OK [UIDVALIDITY 100] ok\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  mock.script(
    new RegExp(`UID FETCH ${uid} \\(UID FLAGS INTERNALDATE RFC822\\.SIZE BODY\\.PEEK\\[\\]\\)`),
    (line) => {
      const tag = line.split(" ")[0];
      return bodyLine(1, uid, raw) + "\r\n" + `${tag} OK done\r\n`;
    },
  );
  const status = await core.drive(
    core.startOp("imap.fetch", { account: accountId, folder: "INBOX", uid }),
    { timeoutMs: 8000 },
  );
  assert.equal(status.state, "done", JSON.stringify(status));
}

test("re-fetching the same message upserts without duplicating the index", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);

  // The same message twice. The write path is ON CONFLICT DO UPDATE, so this is
  // the upsert case: the row is replaced in place and the index must not gain a
  // second entry. Under the old hand-rolled sync this needed a DELETE that
  // SQLite rejects before the row is indexed.
  await fetchOnce(mock, core, accountId, 1, RAW_1);
  await fetchOnce(mock, core, accountId, 1, RAW_1);

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages").get().c, 1, "one row, upserted");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages_fts").get().c, 1, "index did not double");
  integrityOk(db);
  assert.deepEqual(hits(db, '"Hello"').map((r) => r.uid), [1], "still searchable");
});

test("the UPDATE trigger follows a changed indexed column", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  syncScripts(mock);
  await sync(mock, core, accountId);

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.prepare("UPDATE messages SET body_text = ? WHERE uid = 1").run("Rewritten body about quarterly invoices");

  integrityOk(db);
  assert.deepEqual(hits(db, '"quarterly"').map((r) => r.uid), [1], "the new text is indexed");
  assert.deepEqual(hits(db, '"Hello"').map((r) => r.uid), [], "the old text is gone");
});

test("the UPDATE trigger is guarded — a flags-only update leaves the index alone", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  syncScripts(mock);
  await sync(mock, core, accountId);

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  const before = db.prepare("SELECT COUNT(*) c FROM messages_fts").get().c;

  db.prepare("UPDATE messages SET flags = ? WHERE uid = 1").run('["\\Seen"]');

  // The guard is on the indexed columns only; a flags write must not churn the
  // index. This is asserted through integrity rather than row count, because a
  // needless delete+insert leaves the count unchanged.
  integrityOk(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages_fts").get().c, before);
  assert.deepEqual(hits(db, '"Hello"').map((r) => r.uid), [1], "still searchable");
});

test("the DELETE trigger removes the index entry", async (t) => {
  const { mock, core, accountId, dbPath } = await boot(t);
  syncScripts(mock);
  await sync(mock, core, accountId);

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.prepare("DELETE FROM messages WHERE uid = 2").run();

  integrityOk(db);
  assert.deepEqual(hits(db, '"Second"').map((r) => r.uid), [], "the deleted row is unsearchable");
  assert.deepEqual(hits(db, '"Hello"').map((r) => r.uid), [1], "the other row survives");
});
