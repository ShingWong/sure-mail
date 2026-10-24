// Account registry (src/runtime/accounts) through the real core.wasm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCore } from "./helpers/load.mjs";

const ACCOUNT = '{"address":"a@example.com","host":"imap.example.com","port":993,"tls":true,"user":"a@example.com"}';

async function readyCore(config = "{}") {
  const core = await loadCore();
  assert.equal(core.sm_init(config), 0);
  return core;
}

test("account_add assigns sequential ids and validates input", async () => {
  const core = await readyCore();
  assert.equal(core.account_add(ACCOUNT), 1);
  assert.equal(core.account_add(ACCOUNT), 2);
  assert.equal(core.account_add("not json"), -1);
  assert.equal(core.account_add('{"address":"x@y.z"}'), -1, "host required");
  assert.equal(core.account_add('{"host":"imap.example.com"}'), -1, "address required");
});

test("account_list returns the registry as JSON", async () => {
  const core = await readyCore();
  core.account_add(ACCOUNT);
  const list = JSON.parse(core.account_list());
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: 1,
    address: "a@example.com",
    host: "imap.example.com",
    port: 993,
    tls: true,
    user: "a@example.com",
  });
});

test("account_update replaces fields, keeps id, reports not-found", async () => {
  const core = await readyCore();
  core.account_add(ACCOUNT);
  assert.equal(
    core.account_update(1, '{"address":"a@example.com","host":"imap2.example.com","port":143,"tls":false,"user":"a@example.com"}'),
    0,
  );
  const list = JSON.parse(core.account_list());
  assert.equal(list[0].host, "imap2.example.com");
  assert.equal(list[0].port, 143);
  assert.equal(list[0].tls, false);
  assert.equal(list[0].id, 1);
  assert.equal(core.account_update(99, ACCOUNT), -2);
  assert.equal(core.account_update(1, '{"host":"missing-address.example.com"}'), -1);
});

test("account_remove deletes or reports not-found", async () => {
  const core = await readyCore();
  core.account_add(ACCOUNT);
  assert.equal(core.account_remove(1), 0);
  assert.equal(JSON.parse(core.account_list()).length, 0);
  assert.equal(core.account_remove(1), -2);
});

test("sm_init seeds the registry from persisted rows and ids stay monotonic", async () => {
  const core = await readyCore(
    JSON.stringify({ accounts: [{ id: 5, address: "old@example.com", host: "imap.example.com" }] }),
  );
  const list = JSON.parse(core.account_list());
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 5);
  assert.equal(core.account_add(ACCOUNT), 6, "next id is above the seeded max");
});

test("sm_init rejects malformed account seeds", async () => {
  const core = await loadCore();
  assert.equal(core.sm_init('{"accounts":[{"id":0}]}'), -1, "id must be >= 1");
  assert.equal(core.sm_init('{"accounts":"nope"}'), -1, "accounts must be an array");
});

test("account_add carries setup_source into the registry and the persist effect (schema v2)", async () => {
  const core = await readyCore();
  core.account_add(
    '{"address":"a@example.com","host":"imap.example.com","port":993,"tls":true,"user":"a@example.com","setup_source":"ispdb"}',
  );
  const list = JSON.parse(core.account_list());
  assert.equal(list[0].setup_source, "ispdb");
  const effects = JSON.parse(core.op_effects());
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind, "store.exec");
  assert.match(effects[0].sql, /setup_source/);
  assert.equal(effects[0].params[8], "ispdb", "column value in the v2 upsert");
});

test("account_add carries the D13 transport fields; plaintext is rejected", async () => {
  const core = await readyCore();
  assert.equal(
    core.account_add(
      '{"address":"a@example.com","host":"imap.example.com","port":143,"tls":true,"user":"a@example.com","socket_type":"starttls","smtp_socket_type":"starttls"}',
    ),
    1,
  );
  const list = JSON.parse(core.account_list());
  assert.equal(list[0].socket_type, "starttls");
  assert.equal(list[0].smtp_socket_type, "starttls");
  const effects = JSON.parse(core.op_effects());
  assert.match(effects[0].sql, /socket_type/);
  assert.equal(effects[0].params[11], "starttls", "socket_type column value");
  assert.equal(effects[0].params[12], "starttls", "smtp_socket_type column value");
  // plaintext / unknown transports are rejected (D13 keeps plaintext out)
  assert.equal(
    core.account_add('{"address":"b@example.com","host":"imap.example.com","port":143,"tls":false,"user":"b@example.com","socket_type":"plain"}'),
    -1,
  );
  assert.equal(
    core.account_add('{"address":"c@example.com","host":"imap.example.com","port":993,"tls":true,"user":"c@example.com","smtp_socket_type":"nope"}'),
    -1,
  );
});

test("store.query schema drives the v1->v4 migration sequence", async () => {
  const core = await readyCore();
  const start = () => core.op_start("store.query", '{"store":"registry","query":"schema"}');
  const drain = () => JSON.parse(core.op_effects());
  const respond = (opId, eff, result) => {
    assert.equal(core.op_feed("store.result", JSON.stringify({ id: eff.id, ...result })), 0);
    return drain();
  };

  // fresh store: DDL -> setup_source found -> smtp found -> socket_type found -> stamp
  const fresh = start();
  let [step] = drain();
  assert.match(step.sql, /PRAGMA user_version = 4/);
  let queued = respond(fresh, step, { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(fresh, queued[0], { rows: [{ name: "setup_source" }], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(fresh, queued[0], { rows: [{ name: "smtp_host" }], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(fresh, queued[0], { rows: [{ name: "socket_type" }], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /PRAGMA user_version = 4/);
  respond(fresh, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.equal(JSON.parse(core.op_status(fresh)).state, "done");

  // v2-era store: setup_source found, smtp missing -> ALTER smtp -> socket_type check -> ALTER -> stamp
  const v2 = start();
  [step] = drain();
  queued = respond(v2, step, { rows: [], changes: 0, insertId: 0 });
  queued = respond(v2, queued[0], { rows: [{ name: "setup_source" }], changes: 0, insertId: 0 });
  queued = respond(v2, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /ALTER TABLE accounts ADD COLUMN smtp_host TEXT/);
  queued = respond(v2, queued[0], { rows: [], changes: 1, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(v2, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /ALTER TABLE accounts ADD COLUMN socket_type TEXT/);
  queued = respond(v2, queued[0], { rows: [], changes: 1, insertId: 0 });
  assert.match(queued[0].sql, /PRAGMA user_version = 4/);
  respond(v2, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.equal(JSON.parse(core.op_status(v2)).state, "done");

  // v1-era store: setup_source missing -> ALTER -> smtp missing -> ALTER -> socket_type missing -> ALTER -> stamp
  const legacy = start();
  [step] = drain();
  queued = respond(legacy, step, { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(legacy, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /ALTER TABLE accounts ADD COLUMN setup_source TEXT/);
  queued = respond(legacy, queued[0], { rows: [], changes: 1, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(legacy, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /ALTER TABLE accounts ADD COLUMN smtp_host TEXT/);
  queued = respond(legacy, queued[0], { rows: [], changes: 1, insertId: 0 });
  assert.match(queued[0].sql, /pragma_table_info\('accounts'\)/);
  queued = respond(legacy, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.match(queued[0].sql, /ALTER TABLE accounts ADD COLUMN socket_type TEXT/);
  queued = respond(legacy, queued[0], { rows: [], changes: 1, insertId: 0 });
  assert.match(queued[0].sql, /PRAGMA user_version = 4/);
  respond(legacy, queued[0], { rows: [], changes: 0, insertId: 0 });
  assert.equal(JSON.parse(core.op_status(legacy)).state, "done");
});

test("store.query schema fails cleanly on a store error feed", async () => {
  const core = await readyCore();
  const opId = core.op_start("store.query", '{"store":"registry","query":"schema"}');
  const [eff] = JSON.parse(core.op_effects());
  core.op_feed("store.result", JSON.stringify({ id: eff.id, error: { code: -5, where: "store.exec", detail: "disk full" } }));
  const status = JSON.parse(core.op_status(opId));
  assert.equal(status.state, "error");
  assert.equal(status.error.code, -5);
  assert.equal(status.error.detail, "disk full");
});
