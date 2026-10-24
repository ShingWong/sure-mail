// IMAP response parsing through the real probes.wasm: transcripts,
// literals, chunk-boundary fuzzing (every split parses identically).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProbes } from "./helpers/load.mjs";

const probes = await loadProbes();

const TRANSCRIPT = [
  "* OK [CAPABILITY IMAP4rev1 LOGINDISABLED] IMAP4rev1 service ready\r\n",
  "* CAPABILITY IMAP4rev1 AUTH=PLAIN IDLE\r\n",
  "a001 OK CAPABILITY completed\r\n",
  "a002 OK LOGIN completed\r\n",
  "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n",
  "* 18 EXISTS\r\n",
  "* 0 RECENT\r\n",
  "* OK [UIDVALIDITY 123456789] UIDs valid\r\n",
  "a003 OK [READ-WRITE] SELECT completed\r\n",
  '* LIST (\\HasNoChildren) "/" "INBOX"\r\n',
  '* LIST (\\HasNoChildren) "/" "Sent Items"\r\n',
  '* LIST (\\Noselect) "/" "[Gmail]/All Mail"\r\n',
  "a004 OK LIST completed\r\n",
].join("");

const FETCH_TRANSCRIPT = [
  '* 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 6121 ',
  'ENVELOPE ("Wed, 17 Jul 1996 02:44:25 -0700 (PDT)" "IMAP4rev1 summary" ',
  '((NIL NIL "mjc" "critters.com")) ((NIL NIL "mjc" "critters.com")) ((NIL NIL "mjc" "critters.com")) ',
  '((NIL NIL "imap" "washington.edu")) ((NIL NIL "imap" "washington.edu")) ',
  'NIL NIL "<crit2072@example.com>"))\r\n',
  "a005 OK UID FETCH completed\r\n",
].join("");

const LITERAL_TRANSCRIPT = [
  "* 5 FETCH (UID 7 BODY[] {46}\r\n",
  "From: a@b.c\r\nSubject: hi\r\n\r\nHello body\r\n--tail)\r\n",
  "a006 OK FETCH completed\r\n",
].join("");

function parse(b64, chunkSize) {
  return chunkSize === undefined
    ? probes.probeParseTranscript(b64)
    : probes.probeParseChunked(b64, chunkSize);
}

function b64(text) {
  return Buffer.from(text, "binary").toString("base64");
}

test("control transcript: greeting, capabilities, tagged, select, list", () => {
  const events = JSON.parse(parse(b64(TRANSCRIPT)));
  assert.equal(events.length, 13);

  assert.equal(events[0].kind, 1); // EV_SELECT (greeting)
  assert.equal(events[0].status, "OK");
  assert.equal(events[0].code, "CAPABILITY");

  assert.equal(events[1].kind, 5); // capability
  assert.deepEqual(events[1].capabilities, ["IMAP4rev1", "AUTH=PLAIN", "IDLE"]);

  assert.equal(events[2].kind, 2); // tagged a001
  assert.equal(events[2].tag, "a001");
  assert.equal(events[2].status, "OK");

  const select = events.find((e) => e.tag === "a003");
  assert.equal(select.status, "OK");
  assert.equal(select.code, "READ-WRITE");

  const lists = events.filter((e) => e.kind === 6);
  assert.equal(lists.length, 3);
  assert.deepEqual(lists.map((e) => e.mailbox), ["INBOX", "Sent Items", "[Gmail]/All Mail"]);
  assert.equal(lists[0].delimiter, "/");
  assert.deepEqual(lists[0].flags, ["\\HasNoChildren"]);
  assert.deepEqual(lists[2].flags, ["\\Noselect"]);

  const recent = events.filter((e) => e.kind === 7 || e.kind === 8);
  assert.deepEqual(recent.map((e) => e.num), [18, 0]); // EXISTS + RECENT
  const uidValidity = events.find((e) => e.kind === 1 && e.num === 123456789);
  assert.ok(uidValidity, "UIDVALIDITY event");
});

test("fetch transcript: envelope, flags, internaldate, size", () => {
  const events = JSON.parse(parse(b64(FETCH_TRANSCRIPT)));
  assert.equal(events.length, 2);
  const fetch = events[0];
  assert.equal(fetch.kind, 10);
  assert.equal(fetch.uid, 1);
  assert.deepEqual(fetch.flags, ["\\Seen"]);
  assert.equal(fetch.internalDate, "17-Jul-1996 02:44:25 -0700");
  assert.equal(fetch.size, 6121);
  assert.equal(fetch.envelope.subject, "IMAP4rev1 summary");
  assert.equal(fetch.envelope.messageId, "<crit2072@example.com>");
  assert.deepEqual(fetch.envelope.from, [{ name: null, address: "mjc@critters.com" }]);
  assert.deepEqual(fetch.envelope.to, [{ name: null, address: "imap@washington.edu" }]);
});

test("literal framing: {n} content is recovered as raw bytes", () => {
  const events = JSON.parse(parse(b64(LITERAL_TRANSCRIPT)));
  assert.equal(events.length, 2);
  const fetch = events[0];
  assert.equal(fetch.uid, 7);
  const raw = Buffer.from(fetch.rawB64, "base64").toString("binary");
  assert.equal(raw, "From: a@b.c\r\nSubject: hi\r\n\r\nHello body\r\n--tail");
  assert.equal(events[1].tag, "a006");
});

test("chunk-boundary fuzz: every split size parses identically", () => {
  const expected = parse(b64(TRANSCRIPT));
  const fetchExpected = parse(b64(FETCH_TRANSCRIPT));
  const literalExpected = parse(b64(LITERAL_TRANSCRIPT));
  for (const size of [1, 2, 3, 5, 7, 8, 13, 16, 64]) {
    assert.equal(parse(b64(TRANSCRIPT), size), expected, `transcript chunk=${size}`);
    assert.equal(parse(b64(FETCH_TRANSCRIPT), size), fetchExpected, `fetch chunk=${size}`);
    assert.equal(parse(b64(LITERAL_TRANSCRIPT), size), literalExpected, `literal chunk=${size}`);
  }
});

test("continuation and BYE and NO/BAD tagged responses", () => {
  const t = [
    "* OK ready\r\n",
    "+ ready for literal\r\n",
    "a001 NO [AUTHENTICATIONFAILED] login failed\r\n",
    "a002 BAD command error\r\n",
    "* BYE closing down\r\n",
  ].join("");
  const events = JSON.parse(parse(b64(t)));
  assert.equal(events.length, 5);
  assert.equal(events[1].kind, 3); // continuation
  assert.equal(events[1].text, "ready for literal");
  assert.equal(events[2].status, "NO");
  assert.equal(events[2].code, "AUTHENTICATIONFAILED");
  assert.equal(events[3].status, "BAD");
  assert.equal(events[4].kind, 4); // BYE
});

test("empty and garbage lines do not crash the parser", () => {
  const events = JSON.parse(parse(b64("foo bar\r\n* ZAP thing\r\n")));
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 0); // treated as tagged (no '*')
});

test("internaldate parses to epoch milliseconds", () => {
  const ms = probes.probeDate("17-Jul-1996 02:44:25 -0700");
  assert.equal(ms, Date.UTC(1996, 6, 17, 9, 44, 25));
  assert.ok(Number.isNaN(probes.probeDate("not a date")));
  assert.equal(probes.probeDate("01-Jan-2000 00:00:00 +0000"), Date.UTC(2000, 0, 1));
  assert.equal(probes.probeDate("31-Dec-1999 23:59:59 +0100"), Date.UTC(1999, 11, 31, 22, 59, 59));
});
