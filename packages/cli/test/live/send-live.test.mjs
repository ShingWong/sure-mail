// Live self-addressed send — OPT-IN, never part of the default gate.
// Excluded from `node --test test/*.test.mjs` by living in test/live/.
//
// Drives the real product flow (@shing.wong/sure-mail-flows): mime.build ->
// smtp.send through the real SMTP endpoint -> detect Sent -> real IMAP
// APPEND -> sent_messages audit row. Then syncs INBOX and finds the
// self-addressed copy locally.
//
// The audit row belongs to the flow, not to the raw smtp.send op (the row
// carries the append outcome), so this test exercises the flow the CLI
// actually runs rather than re-implementing it here.
//
//   SURE_MAIL_TEST_SEND_ACCOUNT='{"address":"me@example.com",
//     "host":"imap.example.com","port":993,"tls":true,
//     "user":"me@example.com","password":"...",
//     "smtp_host":"smtp.example.com","smtp_port":465}' \
//   node --test test/live/send-live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MailCore } from "../../../host-node/src/index.ts";
import { sendComposed } from "@shing.wong/sure-mail-flows";

const raw = process.env.SURE_MAIL_TEST_SEND_ACCOUNT;

test(
  "live send: self-addressed round trip over real SMTP + Sent append + audit",
  { skip: !raw, timeout: 180000 },
  async (t) => {
    const account = JSON.parse(raw);
    const home = mkdtempSync(join(tmpdir(), "sure-mail-send-live-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const core = await MailCore.load({ dataDir: home, log: () => {} });
    t.after(() => core.close());

    core.init({});
    await core.ensureSchema("registry");
    const id = core.accountAdd(account);
    assert.ok(id > 0, `account_add failed: ${id}`);
    await core.flush();
    await core.ensureSchema(`account:${id}`);

    const driver = async (kind, args, timeoutMs = 120000) => {
      const opId = core.startOp(kind, args);
      assert.ok(opId > 0, `${kind} start failed: ${opId}`);
      const status = await core.drive(opId, { timeoutMs });
      assert.equal(status.state, "done", `${kind}: ${JSON.stringify(status.error)}`);
      return status.result;
    };

    // unique subject so we can find the round trip again
    const marker = `sure-mail live send ${Date.now()}`;
    const outcome = await sendComposed(driver, { id, address: account.address }, {
      from: { address: account.address },
      to: [{ address: account.address }],
      subject: marker,
      text: "Live self-addressed round trip.\n",
    });

    assert.ok(String(outcome.messageId).length > 0, "message id returned");
    assert.equal(outcome.recipients.every((r) => r.accepted), true, JSON.stringify(outcome.recipients));
    assert.ok(outcome.sentFolder, `no Sent folder detected: ${outcome.appendNote}`);
    assert.equal(outcome.appended, true, `Sent append failed: ${outcome.appendNote}`);
    console.log(
      `  sent=${outcome.messageId} folder=${outcome.sentFolder} uid=${outcome.sentUid} size=${outcome.size}`,
    );

    // audit row — written by the flow, not by the raw op
    const db = new DatabaseSync(join(home, "accounts", String(id), "mail.sqlite"));
    const audit = db.prepare("SELECT * FROM sent_messages").get();
    assert.ok(audit, "audit row written");
    assert.equal(audit.appended, 1, "audit records the successful append");
    assert.equal(audit.sent_folder, outcome.sentFolder);
    assert.equal(audit.subject, marker);
    db.close();

    // round trip: the server delivers asynchronously, so poll INBOX briefly
    const deadline = Date.now() + 90000;
    let hit = null;
    while (hit == null && Date.now() < deadline) {
      await driver("imap.sync", { account: id, folder: "INBOX" }, 120000);
      const found = await driver("store.query", {
        store: `account:${id}`,
        query: "search",
        args: { q: `sure-mail live send`, limit: 10 },
      });
      hit = found.rows.find((r) => r.subject === marker) ?? null;
      if (hit == null) await new Promise((r) => setTimeout(r, 5000));
    }
    assert.ok(hit, `self-addressed message not in INBOX within 90s (marker ${marker})`);
    console.log(`  round trip: uid=${hit.uid} folder=${hit.folder}`);
  },
);
