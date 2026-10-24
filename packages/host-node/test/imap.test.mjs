// IMAP ops through the REAL reactor + REAL core.wasm against the scripted
// MockIMAP on loopback: login, folders, sync (incl. UIDVALIDITY resync and
// incremental fetch), fetch, byte-dribbled feeds, disconnects. Zero
// external network; store results asserted through store.query ops and
// direct node:sqlite reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MailCore } from "../src/index.ts";
import { MockIMAP, envelopeLine, bodyLine, loginScripts, starttlsLoginScripts } from "./mock-imap.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};

async function bootMock(t, options = {}) {
  const mock = new MockIMAP(options);
  const port = await mock.listen();
  t.after(() => mock.close());
  const home = mkdtempSync(join(tmpdir(), "sure-mail-imap-"));
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
  assert.ok(accountId > 0);
  await core.flush();
  await core.ensureSchema(`account:${accountId}`);
  return { mock, core, home, accountId };
}

function accountDb(home, accountId) {
  const db = new DatabaseSync(join(home, "accounts", String(accountId), "mail.sqlite"));
  return db;
}

const RAW_MSG_1 = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: First message",
  "Date: Thu, 16 Oct 2026 12:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "",
  "Hello body one",
  "",
].join("\r\n");

const RAW_MSG_2 = [
  'From: Bob <bob@example.com>',
  'To: me@example.com',
  'Subject: =?UTF-8?Q?S=C3=A9cond?= message',
  'Date: Thu, 16 Oct 2026 13:00:00 +0000',
  'Message-ID: <m2@example.com>',
  'In-Reply-To: <m1@example.com>',
  'References: <m1@example.com>',
  'Content-Type: multipart/alternative; boundary="B"',
  '',
  '--B',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Plain second body',
  '--B',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<p>HTML <b>second</b></p>', 'utf8').toString('base64'),
  '--B--',
  '',
].join("\r\n");

/** Poll an op's status until the predicate holds (or fail with the last state). */
async function waitForStatus(core, opId, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = core.status(opId);
  while (Date.now() < deadline) {
    last = core.status(opId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`status never matched; last = ${JSON.stringify(last)}`);
}

test("imap.sync reports what it is doing, and cancelling ends it cleanly", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  // Two folders; the SELECT for the first is deliberately unscripted, so the op
  // sits in the folder phase where progress is observable and cancellation is
  // meaningful.
  mock.script(
    /LIST "" "\*"/,
    [
      '* LIST (\\HasNoChildren) "/" "INBOX"',
      '* LIST (\\HasNoChildren \\Sent) "/" "Sent"',
      "{tag} OK LIST done",
    ].join("\r\n") + "\r\n",
  );
  // Answer SELECT with nothing at all: the op waits in the folder phase, which
  // is where a real long sync sits and where a user wants a Cancel button.
  mock.script(/SELECT "INBOX"/, () => "");

  const opId = core.startOp("imap.sync", { account: 1 });
  assert.ok(opId > 0, "sync accepted");
  // The reactor only advances an op while the host drives it — start the drive
  // and poll its status concurrently, exactly as the browser app does.
  const driving = core.drive(opId, { timeoutMs: 10000 });

  // The op says what it is doing, so a UI does not have to guess "hung".
  const folderPhase = await waitForStatus(core, opId, (s) => s.progress?.phase === "folder");
  assert.equal(folderPhase.state, "pending");
  assert.equal(folderPhase.progress.folder, "INBOX");
  assert.equal(folderPhase.progress.total, 2, "two folders were listed");
  assert.equal(folderPhase.progress.done, 0);

  // Cancel: the connection is closed and the op ends cancelled — not pending,
  // not an error the user cannot act on.
  assert.equal(core.cancel(opId), 0);
  const after = await driving;
  assert.equal(after.state, "cancelled");
  assert.equal(after.error?.name, "cancelled");
});

test("imap.connect: capabilities after login", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  const opId = core.startOp("imap.connect", { account: 1 });
  const status = await core.drive(opId, { timeoutMs: 5000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.ok(status.result.capabilities.includes("IMAP4rev1"));
  assert.ok(mock.received.some((l) => /^a\d+ LOGIN /.test(l)), "login was sent");
  assert.ok(mock.unmatched.length === 0, `unmatched: ${mock.unmatched}`);
});

test("imap.connect: wrong password fails with a host error", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock, { loginStatus: "NO [AUTHENTICATIONFAILED] bad credentials" });
  const opId = core.startOp("imap.connect", { account: 1 });
  const status = await core.drive(opId, { timeoutMs: 5000 });
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -5);
  assert.equal(status.error.where, "login");
  assert.match(status.error.detail, /bad credentials/);
});

test("byte dribble: connect works with 1-byte writes", async (t) => {
  const { mock, core } = await bootMock(t, { chunkSize: 1 });
  loginScripts(mock);
  const opId = core.startOp("imap.connect", { account: 1 });
  const status = await core.drive(opId, { timeoutMs: 8000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.ok(status.result.capabilities.includes("IMAP4rev1"));
});

// -- STARTTLS (D13) -----------------------------------------------------------

/** A STARTTLS-capable mock + an account whose socket_type is starttls. */
async function bootStartTls(t, { connectTimeoutMs = 3000 } = {}) {
  const mock = new MockIMAP({ starttls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  const home = mkdtempSync(join(tmpdir(), "sure-mail-imap-st-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {}, net: { allowSelfSigned: true, connectTimeoutMs } });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  const accountId = core.accountAdd({
    address: "me@example.com",
    host: "127.0.0.1",
    port,
    tls: true,
    socket_type: "starttls",
    user: "me@example.com",
    password: "hunter2",
  });
  assert.ok(accountId > 0);
  await core.flush();
  await core.ensureSchema(`account:${accountId}`);
  return { mock, core, home, accountId };
}

test("imap.connect over STARTTLS: upgrade, re-CAPABILITY, LOGIN", async (t) => {
  const { mock, core } = await bootStartTls(t);
  // The first CAPABILITY advertises a marker that is absent from the
  // post-handshake CAPABILITY, proving capabilities are re-read.
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 STARTTLS UNSELECT\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/STARTTLS/, "{tag} OK Begin TLS negotiation now\r\n");
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/LOGIN/, "{tag} OK LOGIN done\r\n");

  const status = await core.drive(core.startOp("imap.connect", { account: 1 }), { timeoutMs: 8000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.ok(status.result.capabilities.includes("IDLE"), "post-handshake capabilities");
  assert.ok(!status.result.capabilities.includes("UNSELECT"), "pre-handshake capabilities replaced");
  assert.deepEqual(
    mock.received.map((l) => l.split(" ").slice(1).join(" ")),
    ["CAPABILITY", "STARTTLS", "CAPABILITY", "LOGIN \"me@example.com\" \"hunter2\""],
    "clear CAPABILITY -> STARTTLS -> re-CAPABILITY -> LOGIN",
  );
  assert.equal(mock.unmatched.length, 0, `unmatched: ${mock.unmatched}`);
});

test("imap.connect STARTTLS: server not advertising STARTTLS is a clear error", async (t) => {
  const { mock, core } = await bootStartTls(t);
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n{tag} OK CAPABILITY done\r\n");

  const status = await core.drive(core.startOp("imap.connect", { account: 1 }), { timeoutMs: 5000 });
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.code, -6, "unsupported");
  assert.equal(status.error.where, "starttls");
  assert.match(status.error.detail, /does not advertise STARTTLS/);
  assert.ok(!mock.received.some((l) => /LOGIN/.test(l)), "no plaintext login attempted");
});

test("imap.connect STARTTLS: upgrade failure fails at starttls", async (t) => {
  // A plaintext mock (no starttls option): it advertises STARTTLS and OKs
  // the command but never performs the TLS handshake.
  const mock = new MockIMAP();
  const port = await mock.listen();
  t.after(() => mock.close());
  const home = mkdtempSync(join(tmpdir(), "sure-mail-imap-stf-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {}, net: { connectTimeoutMs: 400 } });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  core.accountAdd({
    address: "me@example.com", host: "127.0.0.1", port, tls: true,
    socket_type: "starttls", user: "me@example.com", password: "hunter2",
  });
  await core.flush();
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 STARTTLS\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/STARTTLS/, "{tag} OK go ahead\r\n");

  const status = await core.drive(core.startOp("imap.connect", { account: 1 }), { timeoutMs: 8000 });
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "starttls");
  assert.match(status.error.detail, /timeout/i);
});

test("imap.connect implicit TLS is unchanged (handshake on connect, no STARTTLS)", async (t) => {
  const mock = new MockIMAP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  const home = mkdtempSync(join(tmpdir(), "sure-mail-imap-tls-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {}, net: { allowSelfSigned: true } });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  core.accountAdd({
    address: "me@example.com", host: "127.0.0.1", port, tls: true,
    user: "me@example.com", password: "hunter2",
  });
  await core.flush();
  loginScripts(mock);

  const status = await core.drive(core.startOp("imap.connect", { account: 1 }), { timeoutMs: 8000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.ok(!mock.received.some((l) => /STARTTLS/.test(l)), "no STARTTLS on the implicit path");
  assert.deepEqual(
    mock.received.map((l) => l.split(" ")[1]),
    ["CAPABILITY", "LOGIN"],
  );
});

test("imap.folders: LIST rows land in the account store", async (t) => {
  const { mock, core, home, accountId } = await bootMock(t);
  loginScripts(mock);
  mock.script(/LIST/, [
    '* LIST (\\HasNoChildren) "/" "INBOX"',
    '* LIST (\\HasChildren) "/" "Sent"',
    '{tag} OK LIST done',
  ].join("\r\n") + "\r\n");
  const opId = core.startOp("imap.folders", { account: 1 });
  const status = await core.drive(opId, { timeoutMs: 5000 });
  assert.equal(status.state, "done", JSON.stringify(status));  assert.deepEqual(
    status.result.folders.map((f) => f.path),
    ["INBOX", "Sent"],
  );
  assert.equal(status.result.folders[0].delimiter, "/");
  // persisted via store.exec effects — read it back through the ABI
  const q = core.startOp("store.query", {
    store: `account:${accountId}`,
    query: "folders",
    args: { account: accountId },
  });
  const rows = await core.drive(q, { timeoutMs: 5000 });
  assert.equal(rows.state, "done");
  assert.deepEqual(rows.result.rows.map((r) => r.path), ["INBOX", "Sent"]);
  const db = accountDb(home, accountId);
  assert.equal(db.prepare("SELECT name FROM folders WHERE path = 'Sent'").get().name, "Sent");
  db.close();
});

function syncScripts(mock, { uidValidity = 100, uids = [1, 2] } = {}) {
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    `* ${uids.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n{tag} OK [READ-WRITE] SELECT done\r\n`,
  );
  mock.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE\)/, (line) => {
    if (uids.length === 0) return "{tag} OK empty\r\n";
    const tag = line.split(" ")[0];
    return (
      envelopeLine(1, 1, "First message", "alice", "me@example.com", "16-Oct-2026 12:00:00 +0000") + "\r\n" +
      envelopeLine(2, 2, "Second message", "bob", "me@example.com", "16-Oct-2026 13:00:00 +0000") + "\r\n" +
      `${tag} OK UID FETCH done\r\n`
    );
  });
  mock.script(/UID FETCH 1,2 \(UID FLAGS INTERNALDATE BODY.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return (
      bodyLine(1, 1, RAW_MSG_1) + "\r\n" +
      bodyLine(2, 2, RAW_MSG_2) + "\r\n" +
      `${tag} OK bodies done\r\n`
    );
  });
}

test("imap.sync: first sync fetches and stores messages", async (t) => {
  const { mock, core, home, accountId } = await bootMock(t);
  syncScripts(mock);
  const opId = core.startOp("imap.sync", { account: 1, folder: "INBOX" });
  const status = await core.drive(opId, { timeoutMs: 8000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.folders.length, 1);
  assert.equal(status.result.folders[0].folder, "INBOX");
  assert.deepEqual(status.result.folders[0].newUids, [1, 2]);

  const q = core.startOp("store.query", {
    store: `account:${accountId}`,
    query: "messages",
    args: { account: accountId, folder: "INBOX", limit: 10 },
  });
  const rows = await core.drive(q, { timeoutMs: 5000 });
  assert.equal(rows.state, "done");
  const messages = rows.result.rows.sort((a, b) => a.uid - b.uid);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].subject, "First message");
  assert.equal(messages[1].subject, "Sécond message", "encoded-word subject decoded");

  const db = accountDb(home, accountId);
  const raw1 = db.prepare("SELECT raw FROM messages WHERE uid = 1").get().raw;
  assert.equal(Buffer.from(raw1, "base64").toString("latin1"), RAW_MSG_1);
  const meta = db.prepare("SELECT uidvalidity, last_seen_uid FROM folders WHERE path = 'INBOX'").get();
  assert.equal(meta.uidvalidity, 100);
  assert.equal(meta.last_seen_uid, 2);
  db.close();
});

function secondSyncScripts(mock, { uidValidity = 100, start = 3, serverUids = [] } = {}) {
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    `* ${serverUids.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n{tag} OK [READ-WRITE] SELECT done\r\n`,
  );
  const range = `${start}:\\*`;
  mock.script(new RegExp(`UID FETCH ${range} \\(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE\\)`), (line) => {
    const tag = line.split(" ")[0];
    const lines = serverUids.map((uid, i) =>
      envelopeLine(i + 1, uid, `Message ${uid}`, "alice", "me", "16-Oct-2026 12:00:00 +0000"),
    );
    return (lines.length ? lines.join("\r\n") + "\r\n" : "") + `${tag} OK done\r\n`;
  });
}

test("imap.sync: second sync is incremental and survives reconnect", async (t) => {
  const { mock, core } = await bootMock(t);
  syncScripts(mock);
  const first = await core.drive(core.startOp("imap.sync", { account: 1, folder: "INBOX" }), {
    timeoutMs: 8000,
  });
  assert.equal(first.state, "done", JSON.stringify(first));
  assert.deepEqual(first.result.folders[0].newUids, [1, 2]);

  // second sync: same UIDVALIDITY -> start at 3; server has nothing new
  secondSyncScripts(mock, { uidValidity: 100, start: 3, serverUids: [] });
  const second = await core.drive(core.startOp("imap.sync", { account: 1, folder: "INBOX" }), {
    timeoutMs: 8000,
  });
  assert.equal(second.state, "done", JSON.stringify(second));
  assert.deepEqual(second.result.folders[0].newUids, []);
  assert.ok(
    mock.received.some((l) => l.includes("UID FETCH 3:*")),
    `expected incremental fetch, got: ${mock.received.join(" | ")}`,
  );
});

test("imap.sync: UIDVALIDITY change forces a full resync", async (t) => {
  const { mock, core, home, accountId } = await bootMock(t);
  syncScripts(mock);
  const first = await core.drive(core.startOp("imap.sync", { account: 1, folder: "INBOX" }), {
    timeoutMs: 8000,
  });
  assert.deepEqual(first.result.folders[0].newUids, [1, 2]);

  secondSyncScripts(mock, { uidValidity: 101, start: 1, serverUids: [1, 2] });
  mock.script(/UID FETCH 1,2 \(UID FLAGS INTERNALDATE BODY.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 1, RAW_MSG_1) + "\r\n" + bodyLine(2, 2, RAW_MSG_2) + "\r\n" + `${tag} OK bodies done\r\n`;
  });
  const second = await core.drive(core.startOp("imap.sync", { account: 1, folder: "INBOX" }), {
    timeoutMs: 8000,
  });
  assert.equal(second.state, "done", JSON.stringify(second));
  assert.deepEqual(second.result.folders[0].newUids, [1, 2], "resynced from uid 1");
  assert.ok(mock.received.some((l) => l.includes("UID FETCH 1:*")));
  const db = accountDb(home, accountId);
  assert.equal(db.prepare("SELECT uidvalidity FROM folders WHERE path = 'INBOX'").get().uidvalidity, 101);
  db.close();
});

test("imap.fetch: full source parsed into text/html + store row", async (t) => {
  const { mock, core, home, accountId } = await bootMock(t);
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    "* 1 EXISTS\r\n* OK [UIDVALIDITY 100] ok\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  mock.script(/UID FETCH 2 \(UID FLAGS INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 2, RAW_MSG_2) + "\r\n" + `${tag} OK done\r\n`;
  });
  const status = await core.drive(
    core.startOp("imap.fetch", { account: 1, folder: "INBOX", uid: 2 }),
    { timeoutMs: 8000 },
  );
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.uid, 2);
  assert.equal(status.result.bodyText, "Plain second body");
  assert.equal(status.result.bodyHtml, "<p>HTML <b>second</b></p>");
  assert.equal(status.result.threadKey, "m1@example.com");
  assert.ok(status.result.rawB64.length > 0);
  assert.ok(status.result.flags.includes("\\Seen"), "read marks seen in the result");
  const db = accountDb(home, accountId);
  const row = db.prepare("SELECT body_text, flags FROM messages WHERE uid = 2").get();
  assert.equal(row.body_text, "Plain second body");
  assert.match(row.flags, /\\Seen/, "read marks seen in the local store");
  db.close();
});

test("imap.fetch: unknown uid reports not-found", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    "* 0 EXISTS\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  mock.script(/UID FETCH 99 \(UID FLAGS INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]\)/, "{tag} OK empty\r\n");
  const status = await core.drive(
    core.startOp("imap.fetch", { account: 1, folder: "INBOX", uid: 99 }),
    { timeoutMs: 8000 },
  );
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -2);
});

test("disconnect mid-login fails the op with a protocol error", async (t) => {
  const { mock, core } = await bootMock(t);
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1\r\n{tag} OK done\r\n");
  mock.script(/LOGIN/, (line) => {
    const tag = line.split(" ")[0];
    setTimeout(() => {
      for (const socket of mock.connections) socket.destroy();
    }, 5);
    return `${tag} NO never mind\r\n`;
  });
  const status = await core.drive(core.startOp("imap.connect", { account: 1 }), { timeoutMs: 5000 });
  assert.ok(status.state === "error", JSON.stringify(status));
  assert.ok(status.error.code === -5 || status.error.code === -4, `code ${status.error.code}`);
});

test("store.query rejects unknown named queries", async (t) => {
  const { core } = await bootMock(t);
  const status = await core.drive(
    core.startOp("store.query", { store: "registry", query: "nope" }),
    { timeoutMs: 3000 },
  );
  assert.equal(status.state, "error");
});

test("store.query errors surface as host failures", async (t) => {
  const { core } = await bootMock(t);
  // folders on a schema'd store but bogus account -> empty; force an SQL
  // error by querying a missing table through a named query mismatch is
  // not possible, so drop the table first via a direct write
  const status = await core.drive(
    core.startOp("store.query", { store: "account:999", query: "folders", args: { account: 1 } }),
    { timeoutMs: 5000 },
  );
  // account:999 store has no schema -> SQL error feed -> op error
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -5);
});

// -- imap.append (M3) ---------------------------------------------------------

const SENT_RAW = [
  "From: me@example.com",
  "To: you@example.com",
  "Subject: sent copy",
  "Message-ID: <sent-1@example.com>",
  "",
  "archived copy",
  "",
].join("\r\n");

test("imap.append: synchronizing literal + APPENDUID uid", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  mock.script(/APPEND "Sent"/, "{tag} OK [APPENDUID 777 42] APPEND done\r\n");

  const status = await core.drive(
    core.startOp("imap.append", {
      account: 1,
      folder: "Sent",
      rawB64: Buffer.from(SENT_RAW, "latin1").toString("base64"),
      flags: ["\\Seen"],
    }),
    { timeoutMs: 5000 },
  );
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.uid, 42, "uid from APPENDUID");
  assert.equal(status.result.uidValidity, 777);
  assert.equal(status.result.literalAccepted, true, "server sent + continuation");

  // the literal payload carried the exact message bytes + CRLF
  const appendCmd = mock.received.find((l) => l.startsWith("a") && l.includes("APPEND"));
  assert.match(appendCmd, /APPEND "Sent" \(\\Seen\) \{\d+\}$/);
  assert.equal(mock.literals.length, 1, "one literal received");
  assert.equal(mock.literals[0], SENT_RAW);
});

test("imap.append: server NO -> protocol error", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  mock.script(/APPEND/, "{tag} NO try later\r\n");
  const status = await core.drive(
    core.startOp("imap.append", {
      account: 1,
      folder: "Sent",
      rawB64: Buffer.from(SENT_RAW, "latin1").toString("base64"),
    }),
    { timeoutMs: 5000 },
  );
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "append");
  assert.match(status.error.detail, /try later/);
});

test("imap.append: no APPENDUID -> uid -1, still done", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  mock.script(/APPEND/, "{tag} OK APPEND done\r\n");
  const status = await core.drive(
    core.startOp("imap.append", {
      account: 1,
      folder: "Sent",
      rawB64: Buffer.from(SENT_RAW, "latin1").toString("base64"),
    }),
    { timeoutMs: 5000 },
  );
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.uid, -1, "caller can resync");
});

test("imap.append: invalid flags are dropped, unknown folder rejected", async (t) => {
  const { mock, core } = await bootMock(t);
  loginScripts(mock);
  mock.script(/APPEND "Sent"/, "{tag} OK [APPENDUID 1 5] done\r\n");
  const status = await core.drive(
    core.startOp("imap.append", {
      account: 1,
      folder: "Sent",
      rawB64: Buffer.from(SENT_RAW, "latin1").toString("base64"),
      flags: ["\\Bogus", "\\Flagged", "DROP TABLE x"],
    }),
    { timeoutMs: 5000 },
  );
  assert.equal(status.state, "done", JSON.stringify(status));
  const cmd = mock.received.find((l) => l.includes("APPEND"));
  assert.match(cmd, /\(\\Flagged\)/, "only the system flag survived");
  assert.ok(!cmd.includes("DROP"), "free-form flag dropped");

  const badRc = core.startOp("imap.append", { account: 1, folder: "", rawB64: "" });
  assert.equal(badRc, -1, "empty folder rejected before any effect");
});
