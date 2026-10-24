// Live autodiscover smoke — OPT-IN, never part of the default gate.
// Excluded from `node --test test/*.test.mjs` by living in test/live/.
//
//   SURE_MAIL_TEST_AUTODISCOVER='someone@gmail.com' \
//     node --test test/live/autodiscover-live.test.mjs
//
// Add SURE_MAIL_TEST_PROBE=1 to also run the capability probes (touches
// the provider's real IMAP port).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCore } from "../../../host-node/src/index.ts";

const address = process.env.SURE_MAIL_TEST_AUTODISCOVER;

test("live autodiscover: real ISPDB + DNS produce candidates", { skip: !address }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-live-ad-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {} });
  t.after(() => core.close());
  core.init({});

  const probe = process.env.SURE_MAIL_TEST_PROBE === "1";
  const opId = core.startOp("account.autodiscover", { address, probe });
  const status = await core.drive(opId, { timeoutMs: 120000 });
  assert.equal(status.state, "done", JSON.stringify(status));

  const result = status.result;
  assert.ok(result.candidates.length > 0, `no candidates: ${JSON.stringify(result.strategies)}`);
  for (const c of result.candidates) {
    assert.equal(c.tls, true, "D5: implicit TLS only");
    assert.ok(["plain", "login"].includes(c.auth), "D5: password auth only");
  }
  const byName = Object.fromEntries(result.strategies.map((s) => [s.name, s]));
  assert.equal(byName.provider.state, "ok");
  assert.equal(byName.ispdb.state, "ok", `ISPDB: ${JSON.stringify(byName.ispdb)}`);
  if (probe) {
    assert.equal(byName.probe.state, "ok");
    const accepted = result.candidates.filter((c) => c.probe === "accepted");
    assert.ok(accepted.length > 0, `no candidate answered: ${JSON.stringify(result.candidates)}`);
  }
});
