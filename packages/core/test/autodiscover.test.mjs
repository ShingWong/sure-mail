// M2 autodiscover — strategies 1-3 (provider table, ISPDB XML, DNS MX) and
// the D5 candidate filter, through the real probes.wasm. Fully offline:
// the table is data, the parser and filter are pure. Fixtures: test/fixtures/ispdb/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProbes } from "./helpers/load.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ispdb");
const fixture = (name) => readFileSync(join(fixtures, name), "utf8");

async function provider(domain, address = `me@${domain}`) {
  const probes = await loadProbes();
  return JSON.parse(probes.probeProvider(domain, address));
}

test("provider table: Gmail resolves to the documented implicit-TLS pair", async () => {
  const r = await provider("gmail.com", "alice@gmail.com");
  assert.equal(r.rejected, 0);
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0], {
    imap: { host: "imap.gmail.com", port: 993, socket_type: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, socket_type: "tls" },
    auth: "plain",
    user: "alice@gmail.com",
    source: "provider",
    rank: 1,
  });
});

test("provider table: alias domains map to the same config", async () => {
  const googlemail = await provider("googlemail.com", "bob@googlemail.com");
  assert.equal(googlemail.candidates[0].imap.host, "imap.gmail.com");
  const yahoo = await provider("yahoo.com", "c@yahoo.com");
  assert.deepEqual(
    [yahoo.candidates[0].imap, yahoo.candidates[0].smtp],
    [
      { host: "imap.mail.yahoo.com", port: 993, socket_type: "tls" },
      { host: "smtp.mail.yahoo.com", port: 465, socket_type: "tls" },
    ],
  );
  for (const domain of ["fastmail.com", "fastmail.fm", "gmx.com", "gmx.net", "gmx.de", "mail.com", "email.com"]) {
    const r = await provider(domain);
    assert.equal(r.candidates.length, 1, `${domain} should have a viable candidate`);
    assert.equal(r.rejected, 0, `${domain} should not need a rejection`);
  }
});

test("provider table: unknown domains and subdomains do not match", async () => {
  assert.deepEqual((await provider("example.com")).candidates, []);
  assert.deepEqual((await provider("mail.gmail.com")).candidates, [], "exact match only");
  assert.deepEqual((await provider("")).candidates, []);
});

test("D13 viability: Outlook and iCloud documented configs now yield candidates", async () => {
  for (const domain of ["outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com"]) {
    const r = await provider(domain, `x@${domain}`);
    assert.equal(r.candidates.length, 1, `${domain} is viable under D13`);
    assert.equal(r.rejected, 0, `${domain} is no longer rejected`);
    assert.equal(r.candidates[0].imap.socket_type, "tls", `${domain} IMAP is implicit TLS 993`);
    assert.equal(r.candidates[0].smtp.socket_type, "starttls", `${domain} SMTP is STARTTLS 587`);
    assert.equal(r.candidates[0].smtp.port, 587);
  }
});

test("D13 filter: STARTTLS is accepted; plaintext and OAuth are discarded", async () => {
  const probes = await loadProbes();
  const pair = (imapPort, imapSocket, smtpPort, smtpSocket, auth) =>
    probes.probeD5Pair("imap.example.com", imapPort, imapSocket, "smtp.example.com", smtpPort, smtpSocket, auth, "a@example.com", "ispdb");

  // STARTTLS on 587 (the classic ISPDB offer) — now accepted.
  const st = JSON.parse(pair(993, "ssl", 587, "STARTTLS", "password-cleartext"));
  assert.equal(st.smtp.socket_type, "starttls");
  assert.equal(st.imap.socket_type, "tls");
  // STARTTLS on both sides (143 + 587) — accepted.
  const both = JSON.parse(pair(143, "STARTTLS", 587, "STARTTLS", "password-cleartext"));
  assert.equal(both.imap.socket_type, "starttls");
  assert.equal(both.smtp.socket_type, "starttls");
  // Plaintext IMAP/SMTP — rejected (D13 keeps the exclusion).
  assert.equal(pair(143, "", 25, "", "password-cleartext"), "NULL");
  assert.equal(pair(143, "plain", 587, "plain", "password-cleartext"), "NULL");
  // OAuth auth mechanism — rejected (no OAuth2 in v1, D5/D13).
  assert.equal(pair(993, "ssl", 465, "ssl", "OAuth2"), "NULL");
  assert.equal(pair(993, "ssl", 465, "ssl", "client-encrypted"), "NULL");
  // Unknown auth mechanism — rejected (never guessed).
  assert.equal(pair(993, "ssl", 465, "ssl", "magic-auth"), "NULL");
  // Missing socketType on non-canonical ports — rejected.
  assert.equal(pair(10143, "", 10025, "", "password-cleartext"), "NULL");
  // Invalid/zero ports — rejected.
  assert.equal(pair(0, "ssl", 0, "ssl", "plain"), "NULL");
  // Sanity: a clean implicit-TLS pair survives.
  assert.notEqual(pair(993, "ssl", 465, "ssl", "plain"), "NULL");
  // Hostile host content — rejected.
  const bad = probes.probeD5Pair(
    "imap.example.com\r\nEVIL", 993, "ssl", "smtp.example.com", 465, "ssl", "plain", "a@example.com", "provider",
  );
  assert.equal(bad, "NULL");
});

test("D13 transport filter: SSL on any port, canonical inference, STARTTLS 143/587", async () => {
  const probes = await loadProbes();
  const t = (socket, port, imap) => probes.probeAcceptTransport(socket, port, imap ? 1 : 0);
  assert.equal(t("ssl", 993, true), "tls");
  assert.equal(t("SSL", 465, false), "tls");
  assert.equal(t("tls", 19939, true), "tls", "SSL socketType is the acceptance signal (unprivileged test ports)");
  assert.equal(t("", 993, true), "tls", "missing socketType infers implicit from the canonical port");
  assert.equal(t("", 465, false), "tls");
  assert.equal(t("", 143, true), "starttls", "canonical STARTTLS port inferred");
  assert.equal(t("", 587, false), "starttls");
  assert.equal(t("starttls", 993, true), "starttls", "explicit STARTTLS wins on any port");
  assert.equal(t("STARTTLS", 19939, true), "starttls");
  assert.equal(t("plain", 143, true), "", "explicit plaintext rejected");
  assert.equal(t("", 25, false), "", "non-canonical port without socketType rejected");
  assert.equal(t("", 70000, true), "", "out-of-range port");
});

test("auth mapping: password methods survive, OAuth does not", async () => {
  const probes = await loadProbes();
  assert.equal(probes.probeAuthMap("password-cleartext"), "plain");
  assert.equal(probes.probeAuthMap("PLAIN"), "plain");
  assert.equal(probes.probeAuthMap(""), "plain", "absent element defaults to password-cleartext");
  assert.equal(probes.probeAuthMap("login"), "login");
  assert.equal(probes.probeAuthMap("password-encrypted"), "login");
  assert.equal(probes.probeAuthMap("OAuth2"), "");
  assert.equal(probes.probeAuthMap("XOAUTH2"), "");
  assert.equal(probes.probeAuthMap("client-encrypted"), "");
  assert.equal(probes.probeAuthMap("unknown-mech"), "");
});

test("dedupe: first (best-rank) occurrence wins, distinct pairs survive", async () => {
  const probes = await loadProbes();
  const c = (host, port, source, rank) => ({
    imap: { host, port, socket_type: "tls" },
    smtp: { host: `smtp.${host}`, port: 465, socket_type: "tls" },
    auth: "plain",
    user: "a@example.com",
    source,
    rank,
  });
  const input = [
    c("imap.example.com", 993, "provider", 1),
    c("imap.example.com", 993, "ispdb", 2), // duplicate pair
    c("mail.example.com", 993, "mx", 3), // distinct
    c("imap.example.com", 993, "probe", 4), // duplicate pair
  ];
  const out = JSON.parse(probes.probeDedupe(JSON.stringify(input)));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.source), ["provider", "mx"]);
  assert.equal(out[0].rank, 1, "the surviving duplicate carries the best rank");
  assert.equal(probes.probeDedupe("not json"), "INVALID");
});

// -- strategy 2: Thunderbird ISPDB XML (pure parser in core) ----------------

async function ispdb(xml, address = "alice@example.test") {
  const probes = await loadProbes();
  return JSON.parse(probes.probeIspdbXml(xml, address, address.split("@")[1]));
}

test("ISPDB: well-formed document yields the SSL pair with rank 2", async () => {
  const r = await ispdb(fixture("well-formed.xml"));
  assert.equal(r.rejected, 0);
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers[0], {
    type: "imap",
    hostname: "imap.example.test",
    port: "993",
    socketType: "SSL",
    auth: "password-cleartext",
    username: "%EMAILADDRESS%",
  });
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0], {
    imap: { host: "imap.example.test", port: 993, socket_type: "tls" },
    smtp: { host: "smtp.example.test", port: 465, socket_type: "tls" },
    auth: "plain",
    user: "alice@example.test",
    source: "ispdb",
    rank: 2,
  });
});

test("ISPDB: namespaces, CDATA, entities, authMethod, and missing port survive", async () => {
  const r = await ispdb(fixture("hostile.xml"), "alice@odd.test");
  assert.equal(r.candidates.length, 1, JSON.stringify(r));
  const c = r.candidates[0];
  assert.equal(c.imap.host, "imap.odd.test", "CDATA hostname + namespace prefix stripped");
  assert.equal(c.smtp.port, 465, "missing port defaults to the canonical implicit port");
  assert.equal(c.auth, "plain", "authMethod element mapped");
  assert.equal(c.user, "alice&co", "%EMAILLOCALPART% substituted, &amp; entity decoded");
});

test("ISPDB: missing hostname and OAuth auth are rejected, both counted", async () => {
  const r = await ispdb(fixture("missing.xml"), "x@bad.test");
  assert.equal(r.candidates.length, 0);
  assert.equal(r.rejected, 1);
  assert.equal(r.servers[0].hostname, "", "parser records the missing field honestly");
  assert.equal(r.servers[0].auth, "OAuth2");
});

test("ISPDB: garbage input never crashes and still yields parsed servers", async () => {
  const r = await ispdb(fixture("garbage.xml"), "x@garbage.test");
  assert.equal(r.candidates.length, 1, JSON.stringify(r));
  assert.equal(r.candidates[0].imap.host, "imap.garbage.test");
  assert.equal(r.candidates[0].smtp.host, "smtp.garbage.test");
  assert.equal(r.servers.length, 2);

  // control junk + truncated tag: total function, no hang, no abort
  const truncated = await ispdb(
    "\u0000\u0001 <clientConfig><emailProvider><incomingServer type=\"imap\"><hostname>imap.junk.test",
  );
  assert.equal(truncated.servers.length, 1, "truncated tail still yields the open server");
  assert.equal(truncated.candidates.length, 0, "no smtp -> no pair");
});

test("ISPDB: multiple servers pair index-wise; POP3 servers are ignored", async () => {
  const xml = [
    "<clientConfig><emailProvider>",
    '<incomingServer type="imap"><hostname>imap1.a.test</hostname><port>993</port><socketType>SSL</socketType><authentication>password-cleartext</authentication></incomingServer>',
    '<incomingServer type="pop3"><hostname>pop.a.test</hostname></incomingServer>',
    '<outgoingServer type="smtp"><hostname>smtp1.a.test</hostname><port>465</port><socketType>SSL</socketType><authentication>password-cleartext</authentication></outgoingServer>',
    "</emailProvider></clientConfig>",
  ].join("\n");
  const r = await ispdb(xml, "u@a.test");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].imap.host, "imap1.a.test", "pop3 server does not shift pairing");
});

test("ISPDB: STARTTLS document yields a viable candidate (D13)", async () => {
  const xml = [
    "<clientConfig><emailProvider>",
    '<incomingServer type="imap"><hostname>imap.b.test</hostname><port>143</port><socketType>STARTTLS</socketType><authentication>password-cleartext</authentication></incomingServer>',
    '<outgoingServer type="smtp"><hostname>smtp.b.test</hostname><port>587</port><socketType>STARTTLS</socketType><authentication>password-cleartext</authentication></outgoingServer>',
    "</emailProvider></clientConfig>",
  ].join("\n");
  const r = await ispdb(xml, "u@b.test");
  assert.equal(r.rejected, 0);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].imap.socket_type, "starttls");
  assert.equal(r.candidates[0].imap.port, 143);
  assert.equal(r.candidates[0].smtp.socket_type, "starttls");
  assert.equal(r.candidates[0].smtp.port, 587);
});

test("ISPDB: plaintext document still yields nothing (D13 exclusion)", async () => {
  const xml = [
    "<clientConfig><emailProvider>",
    '<incomingServer type="imap"><hostname>imap.p.test</hostname><port>143</port><socketType>plain</socketType><authentication>password-cleartext</authentication></incomingServer>',
    '<outgoingServer type="smtp"><hostname>smtp.p.test</hostname><port>587</port><socketType>plain</socketType><authentication>password-cleartext</authentication></outgoingServer>',
    "</emailProvider></clientConfig>",
  ].join("\n");
  const r = await ispdb(xml, "u@p.test");
  assert.equal(r.candidates.length, 0);
  assert.equal(r.rejected, 1, "one offer pair, rejected once");
});

test("username templates resolve against the address", async () => {
  const probes = await loadProbes();
  assert.equal(probes.probeUsernameSubst("%EMAILADDRESS%", "a@x.test", "x.test"), "a@x.test");
  assert.equal(probes.probeUsernameSubst("%EMAILLOCALPART%", "a@x.test", "x.test"), "a");
  assert.equal(probes.probeUsernameSubst("%EMAILDOMAIN%", "a@x.test", "x.test"), "x.test");
  assert.equal(probes.probeUsernameSubst("static-user", "a@x.test", "x.test"), "static-user");
});

// -- strategy 3: DNS MX heuristic -------------------------------------------

async function mx(domain, address, records) {
  const probes = await loadProbes();
  return JSON.parse(probes.probeMxDerive(domain, address, JSON.stringify(records)));
}

test("MX derivation: records yield imap./mail. guesses in TLS and STARTTLS forms", async () => {
  const r = await mx("example.test", "u@example.test", [
    { exchange: "mx1.example.test.", priority: 10 },
    { exchange: "mx2.example.test.", priority: 20 },
  ]);
  assert.equal(r.mxCount, 2);
  assert.equal(r.nullMx, false);
  assert.equal(r.candidates.length, 4, "two hostnames x {implicit TLS, STARTTLS}");
  assert.deepEqual(r.candidates[0], {
    imap: { host: "imap.example.test", port: 993, socket_type: "tls" },
    smtp: { host: "smtp.example.test", port: 465, socket_type: "tls" },
    auth: "plain",
    user: "u@example.test",
    source: "mx",
    rank: 3,
  });
  assert.equal(r.candidates[1].imap.socket_type, "starttls");
  assert.equal(r.candidates[1].imap.port, 143);
  assert.equal(r.candidates[1].smtp.port, 587);
  assert.equal(r.candidates[2].imap.host, "mail.example.test");
  assert.equal(r.candidates[3].imap.host, "mail.example.test");
  assert.equal(r.candidates[3].imap.socket_type, "starttls");
});

test("MX derivation: null MX (RFC 7505) and empty records derive nothing", async () => {
  const nullMx = await mx("example.test", "u@example.test", [{ exchange: ".", priority: 0 }]);
  assert.equal(nullMx.nullMx, true);
  assert.equal(nullMx.candidates.length, 0);

  const empty = await mx("example.test", "u@example.test", []);
  assert.equal(empty.mxCount, 0);
  assert.equal(empty.candidates.length, 0);

  const malformed = await mx("example.test", "u@example.test", { exchange: "mx1.example.test" });
  assert.equal(malformed.candidates.length, 0, "non-array records derive nothing");
});

// -- the account.autodiscover op (through the real core.wasm) ---------------

import { loadCore } from "./helpers/load.mjs";

function startAutodiscover(core, args) {
  core.sm_init("{}");
  return core.op_start("account.autodiscover", JSON.stringify(args));
}
const effectsOf = (core) => JSON.parse(core.op_effects());
const statusOf = (core, id) => JSON.parse(core.op_status(id));
const feed = (core, kind, data) => core.op_feed(kind, JSON.stringify(data));
const wire = (text) => Buffer.from(text, "latin1").toString("base64");

test("account.autodiscover rejects invalid addresses before any effect", async () => {
  const core = await loadCore();
  core.sm_init("{}");
  for (const address of [
    "",
    "alice",
    "@x.test",
    "alice@",
    "alice@-bad.test",
    "alice@bad..test",
    "alice@127.0.0.1", // no letter in the TLD-ish part
    "alice@exa mple.test",
  ]) {
    assert.equal(core.op_start("account.autodiscover", JSON.stringify({ address })), -1, address);
  }
  assert.deepEqual(effectsOf(core), [], "no effects for rejected addresses");
});

test("account.autodiscover: full chain ranks provider > ispdb > mx, deduped", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "alice@gmail.com" });
  assert.ok(opId > 0);

  const [http] = effectsOf(core);
  assert.equal(http.kind, "http.fetch");
  assert.equal(http.url, "https://autoconfig.thunderbird.net/v1.1/gmail.com");
  feed(core, "http.result", { id: http.id, status: 200, body: fixture("well-formed.xml") });

  const [dns] = effectsOf(core);
  assert.equal(dns.kind, "dns.lookup");
  assert.equal(dns.lookup, "mx");
  assert.equal(dns.name, "gmail.com");
  feed(core, "dns.result", { id: dns.id, records: [{ exchange: "gmail-smtp-in.l.google.com", priority: 10 }] });

  const status = statusOf(core, opId);
  assert.equal(status.state, "done", JSON.stringify(status));
  const result = status.result;
  assert.equal(result.address, "alice@gmail.com");
  assert.equal(result.domain, "gmail.com");
  assert.equal(result.probe, false);
  assert.deepEqual(
    result.candidates.map((c) => c.source),
    ["provider", "ispdb", "mx", "mx", "mx"],
    "ranked by source",
  );
  assert.deepEqual(result.candidates.map((c) => c.rank), [1, 2, 3, 3, 3]);
  assert.equal(result.candidates[0].imap.host, "imap.gmail.com");
  assert.equal(result.candidates[1].imap.host, "imap.example.test");
  assert.equal(result.candidates[2].imap.host, "imap.gmail.com", "mx implicit duplicate of the provider pair was dropped");
  assert.equal(result.candidates[2].imap.socket_type, "starttls", "mx STARTTLS variant survives");
  assert.equal(result.candidates[3].imap.host, "mail.gmail.com");
  assert.equal(result.candidates[4].imap.host, "mail.gmail.com");
  assert.equal(result.candidates[4].imap.socket_type, "starttls");
  const keys = result.candidates.map((c) => `${c.imap.host}:${c.imap.port}/${c.imap.socket_type}|${c.smtp.host}:${c.smtp.port}/${c.smtp.socket_type}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate endpoint pairs");
  assert.deepEqual(
    result.strategies.map((s) => `${s.name}:${s.state}`),
    ["provider:ok", "ispdb:ok", "mx:ok", "probe:skipped"],
  );
  assert.equal(result.strategies[2].found, 4, "mx contributed four; one deduped away");
  assert.equal(result.candidates.every((c) => c.probe === undefined), true, "no probes without --probe");
});

test("account.autodiscover: http errors and {unsupported:true} DNS degrade, never error", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "someone@noprovider.test" });
  const [http] = effectsOf(core);
  feed(core, "http.result", { id: http.id, error: "connect ECONNREFUSED 127.0.0.1:443" });
  const [dns] = effectsOf(core);
  feed(core, "dns.result", { id: dns.id, unsupported: true });

  const status = statusOf(core, opId);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.deepEqual(status.result.candidates, [], "probe off: no speculative guesses");
  assert.deepEqual(
    status.result.strategies.map((s) => `${s.name}:${s.state}`),
    ["provider:ok", "ispdb:error", "mx:unsupported", "probe:skipped"],
  );
  assert.match(status.result.strategies[1].detail, /ECONNREFUSED/);

  // 404 is its own state (domain simply not in ISPDB)
  const op404 = startAutodiscover(core, { address: "someone@not-in-ispdb.test" });
  const [http404] = effectsOf(core);
  feed(core, "http.result", { id: http404.id, status: 404 });
  feed(core, "dns.result", { id: effectsOf(core)[0].id, error: "NXDOMAIN" });
  const s404 = statusOf(core, op404);
  assert.equal(s404.state, "done");
  assert.equal(s404.result.strategies[1].state, "not-found");
  assert.equal(s404.result.strategies[2].state, "error");
});

test("account.autodiscover: empty ispdbBase skips the ISPDB strategy", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "u@plain.test", ispdbBase: "" });
  const first = effectsOf(core);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "dns.lookup", "no http effect at all");
  feed(core, "dns.result", { id: first[0].id, unsupported: true });
  const status = statusOf(core, opId);
  assert.equal(status.state, "done");
  assert.equal(status.result.strategies[1].state, "skipped");
});

test("account.autodiscover --probe: capability handshakes report verdicts", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "bob@fixture.test", probe: true, ispdbBase: "" });
  feed(core, "dns.result", { id: effectsOf(core)[0].id, unsupported: true });

  // common-name fallback: two candidates, probed in order
  let eff = effectsOf(core);
  assert.equal(eff[0].kind, "net.open");
  assert.deepEqual(
    { host: eff[0].host, port: eff[0].port, tls: eff[0].tls },
    { host: "imap.fixture.test", port: 993, tls: true },
  );
  const t1 = eff[0].transport;
  feed(core, "net.opened", { transport: t1 });
  feed(core, "net.data", { transport: t1, b64: wire("* OK [CAPABILITY IMAP4rev1] probe ready\r\n") });
  eff = effectsOf(core);
  assert.equal(Buffer.from(eff[0].b64, "base64").toString("latin1"), "a1 CAPABILITY\r\n");
  feed(core, "net.data", { transport: t1, b64: wire("* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\na1 OK done\r\n") });
  eff = effectsOf(core);
  assert.equal(Buffer.from(eff[0].b64, "base64").toString("latin1"), "a2 LOGOUT\r\n");
  feed(core, "net.data", { transport: t1, b64: wire("* BYE see you\r\na2 OK bye\r\n") });

  eff = effectsOf(core);
  assert.ok(eff.some((e) => e.kind === "net.close" && e.transport === t1), "probe 1 closes its transport");
  assert.equal(eff.some((e) => e.kind === "net.open" && e.host === "mail.fixture.test"), true, "probe 2 starts");

  const t2 = eff.find((e) => e.kind === "net.open").transport;
  feed(core, "net.error", { transport: t2, error: "connect ECONNREFUSED 127.0.0.1:993" });

  const status = statusOf(core, opId);
  assert.equal(status.state, "done", JSON.stringify(status));
  const result = status.result;
  assert.equal(result.probe, true);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].probe, "accepted");
  assert.deepEqual(result.candidates[0].capabilities, ["IMAP4rev1", "AUTH=PLAIN"]);
  assert.equal(result.candidates[1].probe, "refused");
  assert.deepEqual(result.strategies[3], { name: "probe", state: "ok", found: 2, rejected: 0 });
});

test("account.autodiscover --probe: timeout and bad-greeting verdicts", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "carol@fixture.test", probe: true });
  // ispdb (1) + mx (imap./mail. x {tls, starttls}) candidates, all probed
  const [http] = effectsOf(core);
  feed(core, "http.result", { id: http.id, status: 200, body: fixture("well-formed.xml") });
  const [dns] = effectsOf(core);
  feed(core, "dns.result", {
    id: dns.id,
    records: [{ exchange: "mx.fixture.test", priority: 10 }],
  });

  // probe 1: connect timeout
  const t1 = effectsOf(core)[0].transport;
  feed(core, "net.error", { transport: t1, error: "connect timeout after 300ms" });
  // probe 2: NO greeting
  const t2 = effectsOf(core).find((e) => e.kind === "net.open").transport;
  feed(core, "net.opened", { transport: t2 });
  feed(core, "net.data", { transport: t2, b64: wire("* NO maintenance window\r\n") });
  // remaining probes: a non-IMAP greeting is a refusal; drain until done
  for (let guard = 0; guard < 8 && statusOf(core, opId).state === "pending"; guard++) {
    const open = effectsOf(core).find((e) => e.kind === "net.open");
    if (!open) break;
    feed(core, "net.opened", { transport: open.transport });
    feed(core, "net.data", { transport: open.transport, b64: wire("SSH-2.0-OpenSSH_9.0\r\n") });
  }

  const status = statusOf(core, opId);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.deepEqual(
    status.result.candidates.map((c) => c.probe),
    ["timeout", "refused", "refused", "refused", "refused"],
  );
});

test("account.autodiscover --probe: cancel mid-probe closes the transport", async () => {
  const core = await loadCore();
  const opId = startAutodiscover(core, { address: "dan@fixture.test", probe: true, ispdbBase: "" });
  feed(core, "dns.result", { id: effectsOf(core)[0].id, unsupported: true });
  const t1 = effectsOf(core)[0].transport;
  assert.equal(core.op_cancel(opId), 0);
  assert.equal(statusOf(core, opId).state, "cancelled");
  const eff = effectsOf(core);
  assert.ok(eff.some((e) => e.kind === "net.close" && e.transport === t1), "cancelled probe closes its socket");
  assert.equal(feed(core, "net.data", { transport: t1, b64: wire("* OK late\r\n") }), 0, "stale feeds discarded");
});
