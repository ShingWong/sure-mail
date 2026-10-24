// CLI smoke tests: the sure-mail executable runs natively under Node 22
// type stripping and answers --version/help/doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MockIMAP, envelopeLine, bodyLine, starttlsLoginScripts } from "../../host-node/test/mock-imap.mjs";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sure-mail.ts");
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "host-node", "test", "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};
// STARTTLS fixtures use a self-signed cert; the CLI host accepts it only
// when this env seam is set (never a default).
const INSECURE = { SURE_MAIL_INSECURE_TLS: "1" };

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Async variant: the MockIMAP server lives in THIS process, so the CLI
// child must not be spawned synchronously (that would block the server's
// event loop).
function runAsync(args, env = {}, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("--version prints the package version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("version verb matches --version", () => {
  const a = run(["--version"]);
  const b = run(["version"]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout.trim(), a.stdout.trim());
});

test("help lists the commands", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /sure-mail <command>/);
});

test("no args prints usage and exits 2", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /usage: sure-mail/);
});

test("unknown command exits 2 with usage on stderr", () => {
  const result = run(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'frobnicate'/);
});

test("doctor passes every check on a clean machine", (t) => {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = run(["doctor"], { SURE_MAIL_HOME: home });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ok   node:/m);
  assert.match(result.stdout, /^ok   store port: node:sqlite$/m);
  assert.match(result.stdout, /^ok   core\.wasm: sm_version \d+\.\d+\.\d+$/m);
  assert.match(result.stdout, /^ok   abi imports:/m);
  assert.match(result.stdout, /^ok   sm_init: rc 0$/m);
  assert.match(result.stdout, /^ok   effects\/feeds loop: op \d+ -> done$/m);
  assert.match(result.stdout, /^ok   registry store: accounts query -> done$/m);
  assert.match(result.stdout, /all checks passed/);
});

// -- end-to-end: CLI against the scripted MockIMAP --------------------------

const RAW = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: Invoice October",
  "Date: Thu, 16 Oct 2026 12:00:00 +0000",
  "Message-ID: <inv-oct@example.com>",
  "",
  "Your invoice is attached, total is 42 EUR.",
  "",
].join("\r\n");

test("full loop over STARTTLS: account add -> sync -> list -> read -> search", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-cli-e2e-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { SURE_MAIL_HOME: home, ...INSECURE };
  const mock = new MockIMAP({ starttls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());

  const add = await runAsync(
    ["account", "add", "me@example.com", "--host", "127.0.0.1", "--port", String(port), "--starttls", "--user", "me@example.com", "--password-stdin"],
    env,
    "hunter2\n",
  );
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /added account 1: me@example.com/);

  const listAccounts = await runAsync(["account", "list"], env);
  assert.equal(listAccounts.status, 0, listAccounts.stderr);
  assert.match(listAccounts.stdout, /1 {2}me@example\.com {2}127\.0\.0\.1:\d+ \(starttls\)/);

  // folders
  starttlsLoginScripts(mock);
  mock.script(/LIST/, '* LIST (\\HasNoChildren) "/" "INBOX"\r\n{tag} OK LIST done\r\n');
  const folders = await runAsync(["folders"], env);
  assert.equal(folders.status, 0, folders.stdout + folders.stderr);
  assert.match(folders.stdout, /INBOX/);

  // sync
  starttlsLoginScripts(mock);
  mock.script(/LIST/, '* LIST (\\HasNoChildren) "/" "INBOX"\r\n{tag} OK LIST done\r\n');
  mock.script(
    /SELECT "INBOX"/,
    "* 1 EXISTS\r\n* OK [UIDVALIDITY 100] ok\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  mock.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822\.SIZE ENVELOPE\)/, (line) => {
    const tag = line.split(" ")[0];
    return envelopeLine(1, 1, "Invoice October", "alice", "me", "16-Oct-2026 12:00:00 +0000") + "\r\n" + `${tag} OK done\r\n`;
  });
  mock.script(/UID FETCH 1 \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 1, RAW) + "\r\n" + `${tag} OK done\r\n`;
  });
  const sync = await runAsync(["sync"], env);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /INBOX: 1 new \(1\)/);
  assert.match(sync.stdout, /sync complete: 1 new message\(s\)/);

  // list (from the local store — no server needed; scripts stay unused)
  const listed = await runAsync(["list", "INBOX"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /Invoice October/);
  assert.match(listed.stdout, /Alice/);

  // read hits the server again
  starttlsLoginScripts(mock);
  mock.script(
    /SELECT "INBOX"/,
    "* 1 EXISTS\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  mock.script(/UID FETCH 1 \(UID FLAGS INTERNALDATE RFC822\.SIZE BODY\.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 1, RAW) + "\r\n" + `${tag} OK done\r\n`;
  });
  const read = await runAsync(["read", "INBOX", "1"], env);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.match(read.stdout, /Subject: Invoice October/);
  assert.match(read.stdout, /total is 42 EUR/);
  assert.match(read.stdout, /Alice <alice@example\.com>/);

  // search is local FTS
  const search = await runAsync(["search", "invoice"], env);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /Invoice October/);
  const search2 = await runAsync(["search", "nomatchxyz"], env);
  assert.equal(search2.status, 0);
  assert.match(search2.stdout, /no matches/);
});

// -- end-to-end: send/reply/forward/drafts vs MockSMTP + MockIMAP (M3) ----------

import { MockSMTP } from "../../host-node/test/mock-smtp.mjs";

async function setupSend(t, { sentFolder = true, appendOk = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-cli-send-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { SURE_MAIL_HOME: home, ...INSECURE };

  const smtp = new MockSMTP({ starttls: TLS_OPTS });
  const smtpPort = await smtp.listen();
  t.after(() => smtp.close());
  smtp.scriptSuccessStartTls({ queueId: "CLIQ1" });

  const imap = new MockIMAP({ starttls: TLS_OPTS });
  const imapPort = await imap.listen();
  t.after(() => imap.close());

  const add = await runAsync(
    [
      "account", "add", "me@example.com",
      "--host", "127.0.0.1", "--port", String(imapPort),
      "--starttls",
      "--smtp-host", "127.0.0.1", "--smtp-port", String(smtpPort), "--smtp-starttls",
      "--user", "me@example.com", "--password-stdin",
    ],
    env,
    "hunter2\n",
  );
  assert.equal(add.status, 0, add.stdout + add.stderr);

  // scripts for the two IMAP connections the flow opens (folders + append)
  const folderScripts = () => {
    starttlsLoginScripts(imap);
    const listing = sentFolder
      ? '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n{tag} OK LIST done\r\n'
      : '* LIST (\\HasNoChildren) "/" "INBOX"\r\n{tag} OK LIST done\r\n';
    imap.script(/LIST/, listing);
  };
  const appendScripts = () => {
    starttlsLoginScripts(imap);
    if (appendOk) {
      imap.script(/APPEND "Sent"/, "{tag} OK [APPENDUID 900 55] done\r\n");
    } else {
      imap.script(/APPEND/, "{tag} NO APPEND not supported\r\n");
    }
  };
  return { env, imap, smtp, folderScripts, appendScripts, home };
}

test("send e2e: mime.build -> smtp.send -> Sent detection -> append -> audit", async (t) => {
  const { env, smtp, folderScripts, appendScripts } = await setupSend(t);

  folderScripts();
  appendScripts();
  const send = await runAsync(
    [
      "send", "--to", "you@example.com, Bob <bob@x.org>",
      "--cc", "cc@example.com",
      "--subject", "Hello CLI",
      "--body", "Hi from the test.",
    ],
    env,
  );
  assert.equal(send.status, 0, send.stdout + send.stderr);
  assert.match(send.stdout, /sent <[^>]+> \(\d+ bytes queue CLIQ1\) to 3 recipient\(s\)/);
  assert.match(send.stdout, /you@example\.com: accepted 250/);
  assert.match(send.stdout, /appended to Sent uid 55/);

  // SMTP saw the envelope (to + cc) and the full message
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(smtp.received.some((l) => /^RCPT TO:<you@example\.com>/.test(l)));
  assert.ok(smtp.received.some((l) => /^RCPT TO:<bob@x\.org>/.test(l)));
  assert.ok(smtp.received.some((l) => /^RCPT TO:<cc@example\.com>/.test(l)));
  const payload = smtp.messages[0];
  assert.match(payload, /Subject: Hello CLI/);
  assert.match(payload, /Hi from the test\./);

  // audit row landed in the account store
  const db = new DatabaseSync(join(env.SURE_MAIL_HOME, "accounts", "1", "mail.sqlite"));
  const audit = db.prepare("SELECT * FROM sent_messages").get();
  assert.ok(audit, "audit row exists");
  assert.equal(audit.appended, 1);
  assert.equal(audit.sent_folder, "Sent");
  assert.equal(audit.sent_uid, 55);
  assert.equal(audit.queue_id, "CLIQ1");
  assert.equal(audit.subject, "Hello CLI");
  db.close();
});

test("send e2e: append refused -> send still succeeds, recorded locally", async (t) => {
  const { env, folderScripts, appendScripts } = await setupSend(t, { appendOk: false });

  folderScripts();
  appendScripts();
  const send = await runAsync(
    ["send", "--to", "you@example.com", "--subject", "No append", "--body", "body"],
    env,
  );
  assert.equal(send.status, 0, send.stdout + send.stderr);
  assert.match(send.stdout, /sent </);
  assert.match(send.stdout, /not appended to Sent: append to Sent failed/);
  assert.match(send.stdout, /recorded in sent_messages/);

  const db = new DatabaseSync(join(env.SURE_MAIL_HOME, "accounts", "1", "mail.sqlite"));
  const audit = db.prepare("SELECT * FROM sent_messages").get();
  assert.ok(audit);
  assert.equal(audit.appended, 0, "audit records the failed append");
  db.close();
});

test("send e2e: no Sent folder -> local record with detection note", async (t) => {
  const { env, folderScripts, appendScripts } = await setupSend(t, { sentFolder: false });

  folderScripts();
  const send = await runAsync(
    ["send", "--to", "you@example.com", "--subject", "s", "--body", "b"],
    env,
  );
  assert.equal(send.status, 0, send.stdout + send.stderr);
  assert.match(send.stdout, /not appended to Sent: no Sent folder found/);
  void appendScripts;
});

test("send without --to exits 2", async () => {
  const result = await runAsync(["send", "--subject", "x"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /send needs --to/);
});

// -- reply/forward e2e ----------------------------------------------------------

const ORIGINAL = [
  "From: Alice <alice@example.com>",
  "To: me@example.com",
  "Subject: Project status",
  "Date: Thu, 15 Oct 2026 09:30:00 +0000",
  "Message-ID: <orig-9@example.com>",
  "",
  "Here is the status:",
  "All on track.",
  "",
].join("\r\n");

async function syncOneMessage(env, imap) {
  starttlsLoginScripts(imap);
  imap.script(/LIST/, '* LIST (\\HasNoChildren) "/" "INBOX"\r\n{tag} OK LIST done\r\n');
  imap.script(
    /SELECT "INBOX"/,
    "* 1 EXISTS\r\n* OK [UIDVALIDITY 100] ok\r\n{tag} OK [READ-WRITE] SELECT done\r\n",
  );
  imap.script(/UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822\.SIZE ENVELOPE\)/, (line) => {
    const tag = line.split(" ")[0];
    return (
      envelopeLine(1, 1, "Project status", "alice", "me", "15-Oct-2026 09:30:00 +0000") +
      "\r\n" + `${tag} OK done\r\n`
    );
  });
  imap.script(/UID FETCH 1 \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)/, (line) => {
    const tag = line.split(" ")[0];
    return bodyLine(1, 1, ORIGINAL) + "\r\n" + `${tag} OK done\r\n`;
  });
  const sync = await runAsync(["sync"], env);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
}

test("reply e2e: Re:/In-Reply-To/References + quoted body, then send flow", async (t) => {
  const { env, imap, smtp, folderScripts, appendScripts } = await setupSend(t);
  await syncOneMessage(env, imap);

  folderScripts();
  appendScripts();
  const reply = await runAsync(
    ["reply", "INBOX", "1", "--body", "Thanks!"],
    env,
  );
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  assert.match(reply.stdout, /sent </);

  await new Promise((r) => setTimeout(r, 150));
  const payload = smtp.messages[smtp.messages.length - 1];
  assert.match(payload, /Subject: Re: Project status/);
  assert.match(payload, /In-Reply-To: <orig-9@example\.com>/);
  assert.match(payload, /References: <orig-9@example\.com>/);
  assert.match(payload, /Thanks!/, "user text present");
  assert.match(payload, /> Here is the status:/, "quoted original");
  assert.ok(smtp.received.some((l) => /^RCPT TO:<alice@example\.com>/.test(l)), "replied to From");
});

test("forward e2e: Fwd:/forwarded block + send flow", async (t) => {
  const { env, imap, smtp, folderScripts, appendScripts } = await setupSend(t);
  await syncOneMessage(env, imap);

  folderScripts();
  appendScripts();
  const fwd = await runAsync(
    ["forward", "INBOX", "1", "--to", "carol@example.com", "--body", "FYI:"],
    env,
  );
  assert.equal(fwd.status, 0, fwd.stdout + fwd.stderr);
  assert.match(fwd.stdout, /sent </);

  await new Promise((r) => setTimeout(r, 150));
  const payload = smtp.messages[smtp.messages.length - 1];
  assert.match(payload, /Subject: Fwd: Project status/);
  assert.match(payload, /---------- Forwarded message ----------/);
  assert.match(payload, /From: Alice <alice@example\.com>/);
  assert.match(payload, /> Here is the status:/);
  assert.ok(smtp.received.some((l) => /^RCPT TO:<carol@example\.com>/.test(l)));
  assert.ok(!/In-Reply-To:/.test(payload), "forwards do not thread");
});

test("reply of a missing message fails with a sync hint", async (t) => {
  const { env } = await setupSend(t);
  const reply = await runAsync(["reply", "INBOX", "77"], env);
  assert.notEqual(reply.status, 0);
  assert.match(reply.stderr, /not in the local store \(run: sure-mail sync/);
});

// -- draft e2e -------------------------------------------------------------------

test("draft e2e: save -> list -> show -> send -> marked sent + audit", async (t) => {
  const { env, smtp, folderScripts, appendScripts } = await setupSend(t);

  const save = await runAsync(
    ["draft", "save", "--to", "you@example.com", "--subject", "Draft to send", "--body", "draft body"],
    env,
  );
  assert.equal(save.status, 0, save.stdout + save.stderr);
  assert.match(save.stdout, /draft 1 saved/);

  const list = await runAsync(["draft", "list"], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /1\s+20.*Draft to send/s);

  const show = await runAsync(["draft", "show", "1"], env);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Subject: Draft to send/);
  assert.match(show.stdout, /draft body/);

  folderScripts();
  appendScripts();
  const send = await runAsync(["draft", "send", "1"], env);
  assert.equal(send.status, 0, send.stdout + send.stderr);
  assert.match(send.stdout, /sent </);
  assert.match(send.stdout, /draft 1 marked sent/);

  await new Promise((r) => setTimeout(r, 150));
  const payload = smtp.messages[0];
  assert.match(payload, /Subject: Draft to send/);
  assert.match(payload, /draft body/);

  const db = new DatabaseSync(join(env.SURE_MAIL_HOME, "accounts", "1", "mail.sqlite"));
  const draft = db.prepare("SELECT * FROM drafts WHERE id = 1").get();
  assert.equal(draft.status, "sent");
  assert.ok(draft.message_id.startsWith("<"));
  assert.ok(draft.sent_at > 0);
  assert.equal(draft.sent_folder, "Sent");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sent_messages").get().n, 1, "audit row");
  db.close();

  // sending again refuses
  const again = await runAsync(["draft", "send", "1"], env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already sent/);
});

test("draft delete removes the row", async (t) => {
  const { env } = await setupSend(t);
  const save = await runAsync(["draft", "save", "--to", "x@y.z", "--subject", "temp"], env);
  assert.equal(save.status, 0, save.stderr);
  const del = await runAsync(["draft", "delete", "1"], env);
  assert.equal(del.status, 0, del.stderr);
  assert.match(del.stdout, /draft 1 deleted/);
  const list = await runAsync(["draft", "list"], env);
  assert.match(list.stdout, /no drafts/);
});

// -- end-to-end: account add --auto against a fixture-backed ISPDB ----------

import http from "node:http";

function autoIspdbXml() {
  return `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="gmail.com">
    <incomingServer type="imap"><hostname>imap.autofixture.test</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.autofixture.test</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></outgoingServer>
  </emailProvider>
</clientConfig>`;
}

async function serveIspdbFixture(t, status, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(status);
    res.end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

function autoEnv(t, ispdbStatus = 200, ispdbBody = autoIspdbXml()) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-cli-auto-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return serveIspdbFixture(t, ispdbStatus, ispdbBody).then((base) => ({
    SURE_MAIL_HOME: home,
    SURE_MAIL_ISPDB_BASE: base,
    SURE_MAIL_NO_DNS: "1",
  }));
}

test("account add --auto --yes: ranked candidates, provider wins, persisted with setup_source", async (t) => {
  const env = await autoEnv(t);
  const add = await runAsync(
    ["account", "add", "someone@gmail.com", "--auto", "--yes", "--password-stdin"],
    env,
    "hunter2\n",
  );
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /2 candidate\(s\) for someone@gmail\.com \(domain gmail\.com\):/);
  assert.match(add.stdout, /1\. imap\.gmail\.com:993\/tls \+ smtp\.gmail\.com:465\/tls {2}auth=plain {2}source=provider {2}user=someone@gmail\.com/);
  assert.match(add.stdout, /2\. imap\.autofixture\.test:993\/tls \+ smtp\.autofixture\.test:465\/tls {2}auth=plain {2}source=ispdb/);
  assert.match(add.stdout, /strategies: provider:ok\(1\) {2}ispdb:ok\(1\) {2}mx:unsupported {2}probe:skipped/);
  assert.match(add.stdout, /added account 1: someone@gmail\.com \(imap\.gmail\.com:993\/tls\) via provider/);

  const list = await runAsync(["account", "list"], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /\(tls\) {2}user=someone@gmail\.com {2}source=provider/);
});

test("account add --auto: interactive selection picks the chosen candidate", async (t) => {
  const env = await autoEnv(t);
  const add = await runAsync(["account", "add", "someone@gmail.com", "--auto"], env, "2\n");
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.match(add.stderr, /select candidate \[1-2\] \(default 1\): /);
  assert.match(add.stdout, /added account 1: someone@gmail\.com \(imap\.autofixture\.test:993\/tls\) via ispdb/);
});

test("account add --auto without --yes aborts on empty stdin", async (t) => {
  const env = await autoEnv(t);
  const add = await runAsync(["account", "add", "someone@gmail.com", "--auto"], env);
  assert.notEqual(add.status, 0);
  assert.match(add.stderr, /confirmation required \(pass --yes/);
});

test("account add --auto: no candidates fails with D5 guidance", async (t) => {
  const env = await autoEnv(t, 404);
  const add = await runAsync(["account", "add", "nobody@nowhere.test", "--auto", "--yes"], env);
  assert.notEqual(add.status, 0);
  assert.match(add.stderr, /no candidates for nobody@nowhere\.test .*retry with --probe/);
});

test("account add: --auto and --host are mutually exclusive", async (t) => {
  const env = await autoEnv(t);
  const add = await runAsync(["account", "add", "x@y.test", "--auto", "--host", "imap.y.test"], env);
  assert.equal(add.status, 2);
  assert.match(add.stderr, /--auto and --host are mutually exclusive/);
});

test("account add defaults to implicit TLS; --starttls selects STARTTLS", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-cli-tls-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { SURE_MAIL_HOME: home };

  const add = await runAsync(
    ["account", "add", "me@example.com", "--host", "imap.example.com", "--user", "me@example.com", "--password-stdin"],
    env,
    "pw\n",
  );
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const list = await runAsync(["account", "list"], env);
  assert.match(list.stdout, /me@example\.com {2}imap\.example\.com:993 \(tls\)/, "default is implicit TLS on 993");

  const addSt = await runAsync(
    ["account", "add", "alt@example.com", "--host", "imap.example.com", "--starttls", "--smtp-starttls", "--user", "alt@example.com", "--password-stdin"],
    env,
    "pw\n",
  );
  assert.equal(addSt.status, 0, addSt.stdout + addSt.stderr);
  const list2 = await runAsync(["account", "list"], env);
  assert.match(list2.stdout, /alt@example\.com {2}imap\.example\.com:143 \(starttls\)/, "--starttls defaults to port 143");
});

test("account add rejects --tls combined with --starttls", async () => {
  const result = await runAsync(["account", "add", "x@y.test", "--host", "imap.y.test", "--tls", "--starttls"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--tls and --starttls are mutually exclusive/);
});

test("serve without --relay is a usage error", () => {
  const result = run(["serve"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--relay/);
});

test("apply-update replaces the target, keeps the old build, and relaunches", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sure-mail-apply-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "app");
  writeFileSync(target, "old build\n");
  chmodSync(target, 0o755);

  // A pid that is certainly gone: the helper must not wait for it.
  const run = spawnSync(process.execPath, [cliPath, "apply-update", "999999", target], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /replaced/);

  // The target is now this build (in tests that is the node binary running the
  // CLI, which is exactly what the helper copies), and the old file survived as
  // `.old`, so a bad update is a rename away from undone.
  assert.ok(statSync(target).size > 1024, "target replaced with a real binary");
  assert.equal(readFileSync(`${target}.old`, "utf8"), "old build\n");
});

test("serve --relay refuses a non-loopback --host", async () => {
  const result = await runAsync(["serve", "--relay", "--host", "0.0.0.0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /loopback only/);
});

test("serve --relay binds loopback, serves the protocol, exits 0 on SIGTERM", async () => {
  const child = spawn(process.execPath, [cliPath, "serve", "--relay", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  // the banner announces the ephemeral port on stdout, loopback only
  const port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`no banner; stdout=${stdout} stderr=${stderr}`)), 8000);
    child.stdout.on("data", (d) => {
      stdout += d;
      const match = stdout.match(/relay ready on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
  });
  assert.ok(Number.isInteger(port) && port > 0);

  // the daemon answers the relay wire protocol (ws imported lazily: cli-only concern)
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply from relay")), 3000);
    ws.on("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
    ws.send(JSON.stringify({ kind: "write", transport: "nobody", b64: "" }));
  });
  assert.equal(reply.kind, "error");
  assert.match(reply.error, /unknown transport/);
  ws.close();

  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 0, `serve --relay should exit 0 on SIGTERM (stderr: ${stderr})`);
});

test("serve --ui serves the UI with COOP/COEP and the relay beside it", async () => {
  // A throwaway --ui-dir keeps this hermetic: the verb's contract is the
  // serving + headers, not the web build.
  const dir = mkdtempSync(join(tmpdir(), "sure-mail-serve-ui-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="app">sure-mail</div>');
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
  const child = spawn(
    process.execPath,
    [cliPath, "serve", "--ui", "--port", "0", "--relay-port", "0", "--ui-dir", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  // both banners announce their ephemeral ports, loopback only
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner; stdout=${stdout} stderr=${stderr}`)), 8000);
    child.stdout.on("data", () => {
      // The banner carries the build stamp now ("sure-mail 0.1.0 (build …) —
      // UI on …"): two previews otherwise print identical windows.
      const ui = stdout.match(/UI on http:\/\/127\.0\.0\.1:(\d+)\//);
      const relay = stdout.match(/relay ready on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (ui && relay) {
        clearTimeout(timer);
        resolve({ ui: Number(ui[1]), relay: Number(relay[1]) });
      }
    });
    child.on("error", reject);
  });
  assert.ok(urls.ui > 0 && urls.relay > 0, `ui=${urls.ui} relay=${urls.relay}`);

  const res = await fetch(`http://127.0.0.1:${urls.ui}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  // cross-origin isolation: without these the store worker cannot persist
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.match(await res.text(), /sure-mail/);

  const js = await fetch(`http://127.0.0.1:${urls.ui}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal((await fetch(`http://127.0.0.1:${urls.ui}/nope.js`)).status, 404);

  child.kill("SIGTERM");
  assert.equal(await exited, 0, `serve --ui should exit 0 on SIGTERM (stderr: ${stderr})`);
  rmSync(dir, { recursive: true, force: true });
});

test("serve --ui fails clearly when there is no UI build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sure-mail-serve-noui-"));
  const result = await runAsync(["serve", "--ui", "--ui-dir", dir, "--port", "0", "--relay-port", "0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /no built UI at/);
  rmSync(dir, { recursive: true, force: true });
});

test("serve --relay --quiet starts without a banner", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "serve", "--relay", "--port", "0", "--quiet"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout });
    });
  });
  assert.equal(result.code, null, "daemon should still be running until killed");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stdout, "", "--quiet must suppress the banner");
});
