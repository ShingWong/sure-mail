// GENERATED FILE — do not edit by hand.
//
// Source:  @shing.wong/sure-store contracts/engines.json (spec 0.2.0)
// Engine:  sqlite
// Contract revision: 9008d87
//
// Regenerate:
//   SURE_STORE_DIR=<path> node --experimental-strip-types scripts/render-fts.mjs
//
// This is the bridge between the contract and the AssemblyScript core: the core
// cannot import the TypeScript renderer, so the SQL it emits is rendered here and
// checked in. `scripts/render-fts.mjs --check` fails when this file drifts.

/** The engine these statements were rendered for. */
export const FTS_ENGINE: string = "sqlite";

/**
 * The search index schema: the virtual table plus whatever upkeep the engine
 * declares. sqlite declares trigger-owned upkeep, so this is the table followed
 * by the insert/delete/update trigger trio; an engine that maintains its own
 * index would render only the table.
 */
export const FTS_SCHEMA_SQL: string = "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, fromaddr, body_text, content='messages', content_rowid='rowid', tokenize='unicode61');\nCREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, subject, fromaddr, body_text) VALUES (new.rowid, new.subject, new.fromaddr, new.body_text); END;\nCREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, subject, fromaddr, body_text) VALUES ('delete', old.rowid, old.subject, old.fromaddr, old.body_text); END;\nCREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages WHEN old.subject IS NOT new.subject OR old.fromaddr IS NOT new.fromaddr OR old.body_text IS NOT new.body_text BEGIN INSERT INTO messages_fts(messages_fts, rowid, subject, fromaddr, body_text) VALUES ('delete', old.rowid, old.subject, old.fromaddr, old.body_text); INSERT INTO messages_fts(rowid, subject, fromaddr, body_text) VALUES (new.rowid, new.subject, new.fromaddr, new.body_text); END;";

/**
 * Search template. The first placeholder is the MATCH expression (built by the
 * core from user input), the second is the limit.
 */
export const FTS_SEARCH_SQL: string = "SELECT m.uid, m.folder, m.subject, m.fromaddr, m.internaldate FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY m.internaldate DESC LIMIT ?";
