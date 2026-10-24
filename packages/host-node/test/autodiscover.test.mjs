// M2 autodiscover through the REAL reactor + REAL core.wasm on loopback:
// the http.fetch ISPDB port, the disabled-DNS degradation, and probe
// verdicts against scripted servers (TLS accepted, refused, timeout).
// Zero external network; probing targets 127.0.0.1 on unprivileged ports
// via an ISPDB fixture (D5 candidates are implicit-TLS by socketType).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MailCore } from "../src/index.ts";
import { MockIMAP } from "./mock-imap.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TLS_OPTS = {
  key: readFileSync(join(fixtures, "selfsigned.key")),
  cert: readFileSync(join(fixtures, "selfsigned.pem")),
};

function ispdbXml(imapPort, smtpPort) {
  return `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="fixture.test">
    <incomingServer type="imap"><hostname>127.0.0.1</hostname><port>${imapPort}</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></incomingServer>
    <outgoingServer type="smtp"><hostname>127.0.0.1</hostname><port>${smtpPort}</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></outgoingServer>
  </emailProvider>
</clientConfig>`;
}

function ispdbStartTlsXml(imapPort, smtpPort) {
  return `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="fixture.test">
    <incomingServer type="imap"><hostname>127.0.0.1</hostname><port>${imapPort}</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></incomingServer>
    <outgoingServer type="smtp"><hostname>127.0.0.1</hostname><port>${smtpPort}</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></outgoingServer>
  </emailProvider>
</clientConfig>`;
}

async function serveIspdb(t, status, body) {
  const server = createServer((req, res) => {
    res.writeHead(status);
    res.end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

async function bootCore(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "sure-mail-ad-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = await MailCore.load({ dataDir: home, log: () => {}, ...options });
  t.after(() => core.close());
  core.init({});
  return core;
}

const strategies = (result) => result.strategies.map((s) => `${s.name}:${s.state}`);

test("autodiscover: loopback ISPDB + disabled DNS produce ranked candidates", async (t) => {
  const base = await serveIspdb(t, 200, ispdbXml(19931, 46601));
  const core = await bootCore(t, { dns: { disabled: true } });
  const opId = core.startOp("account.autodiscover", { address: "someone@yahoo.com", ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 10000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  const result = status.result;
  assert.deepEqual(strategies(result), ["provider:ok", "ispdb:ok", "mx:unsupported", "probe:skipped"]);
  assert.deepEqual(result.candidates.map((c) => c.source), ["provider", "ispdb"]);
  assert.equal(result.candidates[0].imap.host, "imap.mail.yahoo.com", "provider outranks ispdb");
  assert.equal(result.candidates[1].imap.host, "127.0.0.1");
  assert.equal(result.candidates[1].imap.port, 19931);
  assert.equal(result.candidates[1].user, "someone@yahoo.com", "%EMAILADDRESS% resolved");
});

test("autodiscover: 404 from ISPDB is not-found, not an error", async (t) => {
  const base = await serveIspdb(t, 404);
  const core = await bootCore(t, { dns: { disabled: true } });
  const opId = core.startOp("account.autodiscover", { address: "nobody@nowhere.test", ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 10000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.deepEqual(strategies(status.result), ["provider:ok", "ispdb:not-found", "mx:unsupported", "probe:skipped"]);
  assert.deepEqual(status.result.candidates, []);
});

test("autodiscover --probe: accepted verdict against a TLS mock on loopback", async (t) => {
  const mock = new MockIMAP({ tls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/LOGOUT/, "* BYE mock signing off\r\n{tag} OK LOGOUT done\r\n");
  const base = await serveIspdb(t, 200, ispdbXml(port, 46602));
  const core = await bootCore(t, {
    net: { allowSelfSigned: true, connectTimeoutMs: 3000 },
    dns: { disabled: true },
  });
  const opId = core.startOp("account.autodiscover", { address: "me@fixture.test", probe: true, ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 15000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  const result = status.result;
  assert.equal(result.candidates.length, 1, "probe verifies, does not speculate");
  assert.equal(result.candidates[0].probe, "accepted");
  assert.ok(result.candidates[0].capabilities.includes("IMAP4rev1"));
  assert.ok(mock.received.some((l) => /CAPABILITY/.test(l)), "capability was queried");
  assert.ok(mock.received.some((l) => /LOGOUT/.test(l)), "polite logout was sent");
  assert.deepEqual(strategies(result), ["provider:ok", "ispdb:ok", "mx:unsupported", "probe:ok"]);
});

test("autodiscover --probe: STARTTLS candidate verified over a real handshake", async (t) => {
  const mock = new MockIMAP({ starttls: TLS_OPTS });
  const port = await mock.listen();
  t.after(() => mock.close());
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/STARTTLS/, "{tag} OK Begin TLS negotiation now\r\n");
  mock.script(/CAPABILITY/, "* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n{tag} OK CAPABILITY done\r\n");
  mock.script(/LOGOUT/, "* BYE mock signing off\r\n{tag} OK LOGOUT done\r\n");
  const base = await serveIspdb(t, 200, ispdbStartTlsXml(port, 46610));
  const core = await bootCore(t, {
    net: { allowSelfSigned: true, connectTimeoutMs: 3000 },
    dns: { disabled: true },
  });
  const opId = core.startOp("account.autodiscover", { address: "me@fixture.test", probe: true, ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 15000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  const result = status.result;
  assert.equal(result.candidates.length, 1, "probe verifies, does not speculate");
  assert.equal(result.candidates[0].imap.socket_type, "starttls");
  assert.equal(result.candidates[0].probe, "accepted");
  assert.ok(result.candidates[0].capabilities.includes("AUTH=PLAIN"), "post-handshake capabilities");
  assert.ok(mock.received.some((l) => /STARTTLS/.test(l)), "STARTTLS was negotiated");
  assert.ok(mock.received.some((l) => /LOGOUT/.test(l)), "polite logout was sent");
});

test("autodiscover --probe: refused verdict when TLS cannot handshake", async (t) => {
  const plain = new MockIMAP(); // plain TCP: the TLS client cannot handshake
  const port = await plain.listen();
  t.after(() => plain.close());
  const base = await serveIspdb(t, 200, ispdbXml(port, 46603));
  const core = await bootCore(t, {
    net: { allowSelfSigned: true, connectTimeoutMs: 3000 },
    dns: { disabled: true },
  });
  const opId = core.startOp("account.autodiscover", { address: "me@fixture.test", probe: true, ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 15000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.candidates[0].probe, "refused");
});

test("autodiscover --probe: timeout verdict when the server stays silent", async (t) => {
  const silent = net.createServer((socket) => {
    socket.on("data", () => {}); // accept, then never speak
  });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => silent.close(resolve)));
  const base = await serveIspdb(t, 200, ispdbXml(silent.address().port, 46604));
  const core = await bootCore(t, {
    net: { allowSelfSigned: true, connectTimeoutMs: 400 },
    dns: { disabled: true },
  });
  const opId = core.startOp("account.autodiscover", { address: "me@fixture.test", probe: true, ispdbBase: base });
  const status = await core.drive(opId, { timeoutMs: 15000 });
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(status.result.candidates[0].probe, "timeout");
});
