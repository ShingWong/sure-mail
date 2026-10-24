// Live-account smoke test — OPT-IN, never part of the default gate.
// Excluded from `node --test test/*.test.mjs` by living in test/live/.
//
//   SURE_MAIL_TEST_ACCOUNT='{"address":"me@example.com","host":"imap.example.com",
//     "port":993,"tls":true,"user":"me@example.com","password":"..."}' \
//     node --test test/live/live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCore } from "../../../host-node/src/index.ts";

const raw = process.env.SURE_MAIL_TEST_ACCOUNT;

test("live smoke: connect, folders, sync against a real account", { skip: !raw }, async (t) => {
  const account = JSON.parse(raw);
  const home = mkdtempSync(join(tmpdir(), "sure-mail-live-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());

  core.init({});
  await core.ensureSchema("registry");
  const id = core.accountAdd(account);
  assert.ok(id > 0, `account_add failed: ${id}`);
  await core.flush();
  await core.ensureSchema(`account:${id}`);

  const connect = await core.drive(core.startOp("imap.connect", { account: id }), { timeoutMs: 30000 });
  assert.equal(connect.state, "done", JSON.stringify(connect));
  assert.ok(connect.result.capabilities.length > 0);

  const folders = await core.drive(core.startOp("imap.folders", { account: id }), { timeoutMs: 60000 });
  assert.equal(folders.state, "done", JSON.stringify(folders));
  assert.ok(folders.result.folders.length > 0, "server reported folders");

  const sync = await core.drive(core.startOp("imap.sync", { account: id, folder: "INBOX" }), {
    timeoutMs: 180000,
  });
  assert.equal(sync.state, "done", JSON.stringify(sync));
});
