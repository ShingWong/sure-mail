// Schema v4 + v1->v4 / v2->v4 / v3->v4 migrations through the REAL reactor
// and REAL sqlite files: fresh stores get the v4 schema (drafts,
// sent_messages, accounts SMTP + transport columns); v1/v2/v3-era files are
// migrated in place (data preserved, user_version stamped) and stay
// idempotent on re-run. The core owns every statement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MailCore, dataPaths } from "../src/index.ts";

// The v1 DDL, exactly as schema.ts shipped it before M2 (this is the
// historical artifact a real user file contains).
const SCHEMA_V1 = `PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  tls INTEGER NOT NULL DEFAULT 1,
  "user" TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'plain',
  password TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  account INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  uidvalidity INTEGER,
  last_seen_uid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, path)
);

CREATE TABLE IF NOT EXISTS messages (
  account INTEGER NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  internaldate INTEGER,
  size INTEGER,
  headers TEXT,
  subject TEXT,
  fromaddr TEXT,
  toaddr TEXT,
  thread_key TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments TEXT,
  raw TEXT,
  PRIMARY KEY (account, folder, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_key);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages (account, folder, uid);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  fromaddr,
  body_text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61'
);
`;

// The v2 DDL (M2-era artifact): accounts gained setup_source.
const SCHEMA_V2 = SCHEMA_V1.replace("PRAGMA user_version = 1;", "PRAGMA user_version = 2;").replace(
  "  password TEXT\n);",
  "  password TEXT,\n  setup_source TEXT\n);",
);

// The v3 DDL (M3-era artifact): accounts gained the SMTP endpoint columns
// and the drafts/sent_messages tables.
const SCHEMA_V3 =
  SCHEMA_V2.replace("PRAGMA user_version = 2;", "PRAGMA user_version = 3;").replace(
    "  setup_source TEXT\n);",
    "  setup_source TEXT,\n  smtp_host TEXT,\n  smtp_port INTEGER\n);",
  ) +
  `
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  account INTEGER NOT NULL,
  subject TEXT,
  fromaddr TEXT NOT NULL,
  toaddrs TEXT NOT NULL DEFAULT '[]',
  ccaddrs TEXT NOT NULL DEFAULT '[]',
  bccaddrs TEXT NOT NULL DEFAULT '[]',
  body_text TEXT,
  body_html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  in_reply_to TEXT,
  references_hdr TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  message_id TEXT,
  sent_at INTEGER,
  sent_folder TEXT,
  sent_uid INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_messages (
  id INTEGER PRIMARY KEY,
  account INTEGER NOT NULL,
  message_id TEXT,
  envelope TEXT NOT NULL,
  subject TEXT,
  size INTEGER,
  queue_id TEXT,
  appended INTEGER NOT NULL DEFAULT 0,
  sent_folder TEXT,
  sent_uid INTEGER,
  sent_at INTEGER NOT NULL
);
`;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-schema-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function columns(db, table) {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
}

function userVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

test("ensureSchema applies schema v4 to a fresh registry", async (t) => {
  const home = tempHome(t);
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");

  const db = new DatabaseSync(dataPaths(home).registryDb);
  assert.ok(columns(db, "accounts").includes("setup_source"), "v2 column present");
  assert.ok(columns(db, "accounts").includes("smtp_host"), "v3 smtp_host column present");
  assert.ok(columns(db, "accounts").includes("smtp_port"), "v3 smtp_port column present");
  assert.ok(columns(db, "accounts").includes("socket_type"), "v4 socket_type column present");
  assert.ok(columns(db, "accounts").includes("smtp_socket_type"), "v4 smtp_socket_type column present");
  assert.ok(columns(db, "drafts").length > 0, "drafts table present");
  assert.ok(columns(db, "sent_messages").length > 0, "sent_messages table present");
  assert.equal(userVersion(db), 4);
  db.close();
});

test("ensureSchema migrates a v1 registry file in place, idempotently", async (t) => {
  const home = tempHome(t);
  const registry = dataPaths(home).registryDb;
  const seed = new DatabaseSync(registry);
  seed.exec(SCHEMA_V1);
  seed
    .prepare(
      'INSERT INTO accounts (id, address, host, port, tls, "user", auth, password) VALUES (1,?,?,?,?,?,?,?)',
    )
    .run("me@example.com", "imap.example.com", 993, 1, "me@example.com", "plain", "secret");
  seed.close();

  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");

  let db = new DatabaseSync(registry);
  const row = db.prepare("SELECT * FROM accounts WHERE id = 1").get();
  assert.equal(row.address, "me@example.com", "existing row preserved");
  assert.equal(row.password, "secret");
  assert.equal(row.setup_source, null, "migrated rows get a NULL source");
  assert.equal(row.smtp_host, null, "migrated rows get a NULL smtp_host");
  assert.equal(row.socket_type, null, "migrated rows get a NULL socket_type");
  assert.ok(columns(db, "accounts").includes("smtp_host"));
  assert.ok(columns(db, "accounts").includes("socket_type"));
  assert.ok(columns(db, "drafts").length > 0, "drafts table added by migration");
  assert.equal(userVersion(db), 4, "user_version stamped after migration");
  db.close();

  // idempotent: a second run finds the columns and skips the ALTERs
  await core.ensureSchema("registry");
  db = new DatabaseSync(registry);
  assert.equal(userVersion(db), 4);
  db.close();

  // and the migrated row flows back through the accounts named query
  const opId = core.startOp("store.query", { store: "registry", query: "accounts" });
  const status = await core.drive(opId, { timeoutMs: 5000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.rows.length, 1);
  assert.equal(status.result.rows[0].setup_source, null);
  assert.equal(status.result.rows[0].smtp_host, null);
  assert.equal(status.result.rows[0].socket_type, null);
});

test("ensureSchema migrates a v2 registry file in place, preserving rows", async (t) => {
  const home = tempHome(t);
  const registry = dataPaths(home).registryDb;
  const seed = new DatabaseSync(registry);
  seed.exec(SCHEMA_V2);
  seed
    .prepare(
      'INSERT INTO accounts (id, address, host, port, tls, "user", auth, password, setup_source) VALUES (1,?,?,?,?,?,?,?,?)',
    )
    .run("me@example.com", "imap.example.com", 993, 1, "me@example.com", "plain", "secret", "provider");
  seed.close();

  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");

  const db = new DatabaseSync(registry);
  const row = db.prepare("SELECT * FROM accounts WHERE id = 1").get();
  assert.equal(row.address, "me@example.com", "row preserved");
  assert.equal(row.setup_source, "provider", "v2 data preserved");
  assert.equal(row.smtp_host, null, "v3 column added");
  assert.equal(row.socket_type, null, "v4 column added");
  assert.equal(userVersion(db), 4);
  db.close();
});

test("ensureSchema migrates a v3 registry file in place, preserving rows", async (t) => {
  const home = tempHome(t);
  const registry = dataPaths(home).registryDb;
  const seed = new DatabaseSync(registry);
  seed.exec(SCHEMA_V3);
  seed
    .prepare(
      'INSERT INTO accounts (id, address, host, port, tls, "user", auth, password, setup_source, smtp_host, smtp_port) VALUES (1,?,?,?,?,?,?,?,?,?,?)',
    )
    .run("me@example.com", "imap.example.com", 993, 1, "me@example.com", "plain", "secret", "provider", "smtp.example.com", 465);
  seed.close();

  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");

  const db = new DatabaseSync(registry);
  const row = db.prepare("SELECT * FROM accounts WHERE id = 1").get();
  assert.equal(row.address, "me@example.com", "row preserved");
  assert.equal(row.smtp_host, "smtp.example.com", "v3 data preserved");
  assert.equal(row.smtp_port, 465);
  assert.equal(row.socket_type, null, "v4 transport column added, NULL for legacy rows");
  assert.equal(row.smtp_socket_type, null);
  assert.equal(userVersion(db), 4);
  db.close();

  // idempotent re-run
  await core.ensureSchema("registry");
  const again = new DatabaseSync(registry);
  assert.equal(userVersion(again), 4);
  again.close();
});

test("account rows persist smtp endpoints + transport end to end", async (t) => {
  const home = tempHome(t);
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  const id = core.accountAdd({
    address: "a@example.com",
    host: "imap.example.com",
    port: 993,
    tls: true,
    user: "a@example.com",
    auth: "plain",
    password: "pw",
    setup_source: "provider",
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    socket_type: "tls",
    smtp_socket_type: "starttls",
  });
  assert.ok(id > 0);
  await core.flush();

  const db = new DatabaseSync(dataPaths(home).registryDb);
  const row = db.prepare("SELECT smtp_host, smtp_port, socket_type, smtp_socket_type FROM accounts WHERE id = 1").get();
  assert.equal(row.smtp_host, "smtp.example.com");
  assert.equal(row.smtp_port, 587);
  assert.equal(row.socket_type, "tls");
  assert.equal(row.smtp_socket_type, "starttls");
  db.close();
  const listed = core.accountList()[0];
  assert.equal(listed.smtp_host, "smtp.example.com", "account_list carries the endpoint");
  assert.equal(listed.smtp_socket_type, "starttls", "account_list carries the transport");

  // D13 keeps plaintext out: an explicit plaintext transport is invalid.
  assert.equal(core.accountAdd({ address: "b@example.com", host: "imap.example.com", port: 143, tls: false, socket_type: "plain", user: "b@example.com" }), -1);
});

test("schema op surfaces store failures (bogus store name)", async (t) => {
  const home = tempHome(t);
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});
  const opId = core.startOp("store.query", { store: "bogus", query: "schema" });
  const status = await core.drive(opId, { timeoutMs: 5000 });
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -5);
  assert.match(status.error.detail, /unknown store/);
});
