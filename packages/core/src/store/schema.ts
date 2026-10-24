// Schema v4, owned by the core (D2): versioned SQL emitted as store.exec
// effects. One identical schema is applied to the account-registry store
// and to every per-account mailbox file. fts5 (external content) indexes
// subject/from/body_text for local search, maintained by triggers on
// messages (messages_fts_ai / _ad / _au) rather than by hand.
//
import { FTS_SCHEMA_SQL } from "./fts.generated";

// v2 adds accounts.setup_source (M2: which autodiscover strategy chose
// the profile). v3 (M3) adds the SMTP endpoint columns on accounts
// (smtp_host/smtp_port — the registry used to keep only the IMAP
// endpoint) plus the drafts and sent_messages tables. v4 (D13) adds the
// per-endpoint transport columns (socket_type, smtp_socket_type) so an
// account can record STARTTLS (the legacy tls boolean only expressed
// implicit TLS vs plaintext). The v1 -> v4 migrations are orchestrated by
// store/handler.ts (SchemaHandler): the DDL below is idempotent
// (IF NOT EXISTS), missing columns are added, then user_version is
// stamped.

export const SCHEMA_VERSION: i32 = 4;

export const SCHEMA_V4: string = `PRAGMA user_version = 4;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  tls INTEGER NOT NULL DEFAULT 1,
  "user" TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT 'plain',
  password TEXT,
  setup_source TEXT,
  smtp_host TEXT,
  smtp_port INTEGER,
  socket_type TEXT,
  smtp_socket_type TEXT
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

-- The search index is rendered from the sure-store contract, not written here.
-- sqlite declares fts.sync = "triggers": the virtual table plus an
-- insert/delete/update trigger trio, because removing an external-content entry
-- needs the documented 'delete' command carrying the OLD column values — which
-- only a trigger has. A hand-rolled DELETE is invalid; it raises "database disk
-- image is malformed" for a rowid that is not yet indexed.
${FTS_SCHEMA_SQL}

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

CREATE INDEX IF NOT EXISTS idx_drafts_account ON drafts (account, status);

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

CREATE INDEX IF NOT EXISTS idx_sent_account ON sent_messages (account, sent_at);
`;

/** v1->v2 migration step 1: does accounts already have the v2 column? */
export const HAS_SETUP_SOURCE: string =
  "SELECT name FROM pragma_table_info('accounts') WHERE name = 'setup_source'";

/** v1->v2 migration step 2: add the column to a v1-era accounts table. */
export const MIGRATE_ADD_SETUP_SOURCE: string = "ALTER TABLE accounts ADD COLUMN setup_source TEXT";

/** v2->v3 migration step 1: does accounts already have the SMTP columns? */
export const HAS_SMTP_HOST: string =
  "SELECT name FROM pragma_table_info('accounts') WHERE name = 'smtp_host'";

/** v2->v3 migration step 2: add SMTP endpoint columns to a v2-era table. */
export const MIGRATE_ADD_SMTP: string =
  "ALTER TABLE accounts ADD COLUMN smtp_host TEXT; ALTER TABLE accounts ADD COLUMN smtp_port INTEGER";

/** v3->v4 migration step 1: does accounts already have the transport columns? */
export const HAS_SOCKET_TYPE: string =
  "SELECT name FROM pragma_table_info('accounts') WHERE name = 'socket_type'";

/** v3->v4 migration step 2: add the per-endpoint transport columns. */
export const MIGRATE_ADD_SOCKET_TYPE: string =
  "ALTER TABLE accounts ADD COLUMN socket_type TEXT; ALTER TABLE accounts ADD COLUMN smtp_socket_type TEXT";

/** The schema stamp applied after DDL and migration. */
export const STAMP_USER_VERSION: string = `PRAGMA user_version = ${SCHEMA_VERSION}`;
