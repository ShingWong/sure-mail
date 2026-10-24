// M3 SMTP through the REAL reactor + REAL core.wasm on loopback:
// success (implicit TLS), every failure branch (greeting, auth, relaying,
// RCPT partial, size, mid-DATA disconnect), pipelining on/off, EHLO->HELO
// fallback, AUTH LOGIN, chunked reply dribble. Zero external network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MailCore } from "../src/index.ts";
import { MockSMTP } from "./mock-smtp.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};

const RAW = [
  "From: Me <me@example.com>",
  "To: you@example.com",
  "Subject: hello",
  "Message-ID: <t-1@example.com>",
  "",
  "Hi there.",
  ".dot line",
  "",
].join("\r\n");

async function boot(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-smtp-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {}, ...options });
  t.after(() => core.close());
  core.init({});
  await core.ensureSchema("registry");
  return core;
}

function addAccount(core, port, extra = {}) {
  const id = core.accountAdd({
    address: "me@example.com",
    host: "imap.example.com",
    port: 993,
    tls: true,
    user: "me@example.com",
    auth: "plain",
    password: "hunter2",
    smtp_host: "127.0.0.1",
    smtp_port: port,
    ...extra,
  });
  assert.ok(id > 0);
  return id;
}

async function send(core, id, overrides = {}) {
  const opId = core.startOp("smtp.send", {
    account: id,
    envelope: { from: "me@example.com", to: ["you@example.com"], cc: [], bcc: [] },
    rawB64: Buffer.from(RAW, "latin1").toString("base64"),
    ...overrides,
  });
  assert.ok(opId > 0, `smtp.send failed to start: ${opId}`);
  return core.drive(opId, { timeoutMs: 10000 });
}

/** Let in-flight socket writes land on the mock before asserting. */
function settle(ms = 100) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("smtp.send success path over implicit TLS: full transcript + dot-stuffed DATA", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.scriptSuccess({ queueId: "MAILQ42" });

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  const r = status.result;
  assert.equal(r.messageId, "<t-1@example.com>");
  assert.equal(r.queueId, "MAILQ42", "queue id captured from the 250 text");
  assert.equal(r.pipelining, false, "no PIPELINING in default EHLO lines");
  assert.deepEqual(r.recipients, [
    { address: "you@example.com", code: 250, accepted: true, detail: "2.1.5 Recipient ok" },
  ]);

  await settle();
  // transcript order: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT
  const cmds = mock.received;
  assert.match(cmds[0], /^EHLO /);
  assert.match(cmds[1], /^AUTH PLAIN /);
  assert.match(cmds[2], /^MAIL FROM:<me@example\.com>$/);
  assert.match(cmds[3], /^RCPT TO:<you@example\.com>$/);
  assert.equal(cmds[4], "DATA");
  assert.equal(cmds[5], "QUIT");

  // the payload is dot-stuffed (.line -> ..line); the mock strips the
  // wire terminator, so the stored payload ends with the message CRLF
  assert.equal(mock.messages.length, 1);
  const payload = mock.messages[0];
  assert.match(payload, /\r\n\.\.dot line\r\n/, "leading dot stuffed on the wire");
  assert.ok(payload.endsWith("\r\n"), "body ends with CRLF");
  assert.match(payload, /^From: Me <me@example\.com>\r\n/);
});

test("smtp.send over STARTTLS: EHLO -> STARTTLS -> re-EHLO -> AUTH -> send", async (t) => {
  const mock = new MockSMTP({
    starttls: TLS_OPTS,
    ehloLines: ["250-mock.test", "250-STARTTLS", "250 AUTH PLAIN"],
  });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.scriptSuccessStartTls({ queueId: "STLS1" });

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port, { smtp_socket_type: "starttls" });
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.queueId, "STLS1");

  await settle();
  const cmds = mock.received;
  assert.match(cmds[0], /^EHLO /);
  assert.equal(cmds[1], "STARTTLS");
  assert.match(cmds[2], /^EHLO /, "re-EHLO after the handshake");
  assert.match(cmds[3], /^AUTH PLAIN /);
  assert.equal(cmds[4], "MAIL FROM:<me@example.com>");
  assert.equal(cmds[6], "DATA");
  assert.equal(cmds[7], "QUIT");
  assert.ok(status.result.capabilities.includes("STARTTLS"), "post-handshake capabilities");
});

test("smtp.send STARTTLS: server not advertising STARTTLS is a clear error", async (t) => {
  const mock = new MockSMTP({ starttls: TLS_OPTS }); // default EHLO has no STARTTLS
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port, { smtp_socket_type: "starttls" });
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.code, -6);
  assert.equal(status.error.where, "starttls");
  assert.match(status.error.detail, /does not advertise STARTTLS/);
  assert.ok(!mock.received.includes("AUTH PLAIN"), "no plaintext auth attempted");
});

test("smtp.send STARTTLS: capabilities re-read after the handshake", async (t) => {
  const mock = new MockSMTP({ starttls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, "250-mock.test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
  mock.script(/STARTTLS/, "220 2.0.0 Ready to start TLS\r\n");
  mock.script(/EHLO/, "250-mock.test\r\n250-AUTH PLAIN\r\n250 PIPELINING\r\n");
  mock.script(/AUTH/, "235 2.7.0 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");
  mock.script(/DATA/, "250 2.0.0 Ok: queued as RE1\r\n");
  mock.script(/QUIT/, "221 bye\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port, { smtp_socket_type: "starttls" });
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.pipelining, true, "PIPELINING only advertised post-handshake");
  assert.ok(!status.result.capabilities.includes("STARTTLS"), "capabilities replaced after upgrade");
});

test("smtp.send STARTTLS: upgrade failure fails at starttls", async (t) => {
  // Plaintext mock that OKs STARTTLS but never speaks TLS.
  const mock = new MockSMTP();
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, "250-mock.test\r\n250 STARTTLS\r\n");
  mock.script(/STARTTLS/, "220 2.0.0 Ready to start TLS\r\n");

  const core = await boot(t, { net: { connectTimeoutMs: 400 } });
  const id = addAccount(core, port, { smtp_socket_type: "starttls" });
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "starttls");
  assert.match(status.error.detail, /timeout/i);
});

test("smtp.send implicit TLS never sends STARTTLS (unchanged path)", async (t) => {
  const mock = new MockSMTP({
    tls: TLS_OPTS,
    ehloLines: ["250-mock.test", "250-STARTTLS", "250 AUTH PLAIN"],
  });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.scriptSuccess({ queueId: "IMP1" });

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port); // tls:true, no smtp_socket_type
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.queueId, "IMP1");
  await settle();
  assert.ok(!mock.received.some((l) => /STARTTLS/.test(l)), "implicit path ignores advertised STARTTLS");
});

test("pipelining capability detected when advertised", async (t) => {
  const mock = new MockSMTP({
    tls: TLS_OPTS,
    ehloLines: ["250-mock.test", "250-AUTH PLAIN", "250 PIPELINING"],
  });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.scriptSuccess();

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.pipelining, true);
  assert.ok(status.result.capabilities.includes("PIPELINING"));
  assert.ok(status.result.capabilities.includes("AUTH"));
});

test("EHLO rejected -> HELO fallback still sends", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, "502 5.5.1 Command not implemented\r\n");
  mock.script(/HELO/, "250 mock.test\r\n");
  mock.script(/AUTH/, "235 2.7.0 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");
  mock.script(/DATA/, "250 2.0.0 Ok: queued as HELO1\r\n");
  mock.script(/QUIT/, "221 bye\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.match(mock.received[1], /^HELO /);
  assert.deepEqual(status.result.capabilities, [], "HELO gives no capabilities");
});

test("auth rejected 535 -> error at where=auth", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "535 5.7.8 Authentication credentials invalid\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.code, -5);
  assert.equal(status.error.where, "auth");
  assert.match(status.error.detail, /SMTP 535 5\.7\.8 Authentication credentials invalid/);
});

test("no supported AUTH mechanism -> unsupported error", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, ehloLines: ["250-mock.test", "250 AUTH XOAUTH2"] });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.code, -6);
  assert.equal(status.error.where, "auth");
  assert.match(status.error.detail, /XOAUTH2/);
});

test("relaying denied on MAIL FROM -> error at mail-from", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 2.7.0 ok\r\n");
  mock.script(/MAIL FROM/, "550 5.7.1 Relaying denied\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "mail-from");
  assert.match(status.error.detail, /550 5\.7\.1 Relaying denied/);
});

test("RCPT partial failure: one 550 one 250 -> send continues", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO:<bad@other\.test>/, "550 5.1.1 Mailbox unknown\r\n");
  mock.script(/RCPT TO:<good@example\.com>/, "250 ok\r\n");
  mock.script(/DATA/, "250 2.0.0 Ok: queued as PARTIAL\r\n");
  mock.script(/QUIT/, "221 bye\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const opId = core.startOp("smtp.send", {
    account: id,
    envelope: { from: "me@example.com", to: ["bad@other.test"], cc: ["good@example.com"] },
    rawB64: Buffer.from(RAW, "latin1").toString("base64"),
  });
  const status = await core.drive(opId, { timeoutMs: 10000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.recipients.length, 2);
  assert.equal(status.result.recipients[0].accepted, false);
  assert.equal(status.result.recipients[0].code, 550);
  assert.equal(status.result.recipients[1].accepted, true);
  assert.equal(status.result.queueId, "PARTIAL");
  assert.equal(mock.messages.length, 1, "DATA still sent for accepted recipient");
});

test("all recipients rejected -> error at rcpt with per-recipient detail", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "550 5.7.1 Relaying denied\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "rcpt");
  assert.match(status.error.detail, /no recipient accepted/);
  assert.match(status.error.detail, /you@example\.com -> 550 5\.7\.1 Relaying denied/);
});

test("size exceeded: server SIZE cap checked before DATA", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, ehloLines: ["250-mock.test", "250-AUTH PLAIN", "250 SIZE 10"] });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "data");
  assert.match(status.error.detail, /exceeds server SIZE 10/);
  assert.ok(!mock.received.includes("DATA"), "DATA never sent");
});

test("size exceeded: 552 on the final DATA reply", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, ehloLines: ["250-mock.test", "250 AUTH PLAIN"] });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");
  mock.script(/DATA/, "552 5.3.4 Message size exceeds fixed maximum\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "data");
  assert.match(status.error.detail, /size exceeded: SMTP 552/);
});

test("abrupt disconnect mid-DATA -> protocol error", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, ehloLines: ["250-mock.test", "250 AUTH PLAIN"] });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH/, "235 ok\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");
  mock.script(/DATA/, "354 go ahead\r\n");
  // swallow the body, then hang up without the final reply
  mock.onData = () => {
    const sockets = [...mock.connections];
    for (const s of sockets) s.destroy();
    return "";
  };

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.code, -4);
  assert.equal(status.error.where, "net");
  assert.match(status.error.detail, /connection closed/);
});

test("greeting failure -> error at greeting", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, greeting: "421 4.7.0 Service not available\r\n" });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, "250 ok\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "error", JSON.stringify(status));
  assert.equal(status.error.where, "greeting");
  assert.match(status.error.detail, /SMTP 421/);
});

test("AUTH LOGIN exchange (account auth=login)", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, ehloLines: ["250-mock.test", "250 AUTH LOGIN PLAIN"] });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/EHLO/, mock.ehloResponse());
  mock.script(/AUTH LOGIN/, "334 VXNlcm5hbWU6\r\n");
  mock.script(/^[A-Za-z0-9+/=]+$/, (line) => {
    // username step: reply with the password challenge
    return "334 UGFzc3dvcmQ6\r\n";
  });
  mock.script(/^[A-Za-z0-9+/=]+$/, "235 2.7.0 Authentication successful\r\n");
  mock.script(/MAIL FROM/, "250 ok\r\n");
  mock.script(/RCPT TO/, "250 ok\r\n");
  mock.script(/DATA/, "250 2.0.0 Ok: queued as L1\r\n");
  mock.script(/QUIT/, "221 bye\r\n");

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port, { auth: "login" });
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  await settle();
  assert.equal(mock.received[1], "AUTH LOGIN");
  assert.equal(mock.received.length, 8, "EHLO AUTH user pass MAIL RCPT DATA QUIT");
});

test("chunked reply dribble parses identically", async (t) => {
  const mock = new MockSMTP({ tls: TLS_OPTS, chunkSize: 3 });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.scriptSuccess({ queueId: "CHUNKY" });

  const core = await boot(t, { net: { allowSelfSigned: true } });
  const id = addAccount(core, port);
  const status = await send(core, id);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.queueId, "CHUNKY");
});
