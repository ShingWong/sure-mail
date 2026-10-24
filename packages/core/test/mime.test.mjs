// MIME parsing through the real probes.wasm: headers, multipart trees,
// transfer encodings, charsets, attachments, thread keys — with Node
// oracles where they exist (Buffer base64, TextDecoder charsets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProbes } from "./helpers/load.mjs";

const probes = await loadProbes();

function mime(raw) {
  return JSON.parse(probes.probeMime(raw));
}

function crlf(s) {
  return s.replace(/\n/g, "\r\n");
}

test("simple text/plain message", () => {
  const msg = mime(crlf([
    "From: Alice <alice@example.com>",
    "To: bob@example.com",
    "Subject: Hello",
    "Date: Tue, 15 Mar 2022 10:00:00 +0000",
    "Message-ID: <a1@example.com>",
    "",
    "Hi Bob,",
    "this is a test.",
    "",
  ].join("\n")));
  assert.equal(msg.subject, "Hello");
  assert.deepEqual(msg.from, [{ name: "Alice", address: "alice@example.com" }]);
  assert.deepEqual(msg.to, [{ name: null, address: "bob@example.com" }]);
  assert.equal(msg.bodyText, "Hi Bob,\r\nthis is a test.\r\n");
  assert.equal(msg.threadKey, "a1@example.com");
});

test("folded headers unfold; encoded-words decode", () => {
  const block = crlf([
    "Subject: a very long subject that",
    "\tkeeps going",
    "From: =?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <juergen@example.com>",
    "X-Plain: plain value",
    "",
  ].join("\n"));
  assert.equal(probes.probeHeader(block, "subject"), "a very long subject that keeps going");
  assert.equal(probes.probeHeader(block, "from"), "Jürgen Müller <juergen@example.com>");
  assert.equal(probes.probeHeader(block, "x-plain"), "plain value");
  assert.equal(probes.probeHeader(block, "missing"), "NULL");
});

test("Q-encoded words decode per charset", () => {
  const q = "Subject: =?ISO-8859-1?Q?Gr=FC=DFe?= \r\n";
  assert.equal(probes.probeHeader(q, "subject"), "Grüße");
  const utf8q = "Subject: =?utf-8?Q?caf=C3=A9?=!\r\n";
  assert.equal(probes.probeHeader(utf8q, "subject"), "café!");
});

test("address lists: groups, quotes, bare, mixed", () => {
  assert.deepEqual(JSON.parse(probes.probeAddresses("bob@example.com, Alice <alice@example.com>")), [
    { name: null, address: "bob@example.com" },
    { name: "Alice", address: "alice@example.com" },
  ]);
  assert.deepEqual(JSON.parse(probes.probeAddresses('"Smith, Bob" <bob@x.org>')), [
    { name: "Smith, Bob", address: "bob@x.org" },
  ]);
  assert.deepEqual(JSON.parse(probes.probeAddresses("undisclosed-recipients:;")), []);
  assert.deepEqual(JSON.parse(probes.probeAddresses("Team: a@b.c, c@d.e")), [
    { name: null, address: "a@b.c" },
    { name: null, address: "c@d.e" },
  ]);
});

test("multipart/alternative: text + html, base64 html", () => {
  const html = "<p>Hello <b>HTML</b></p>";
  const htmlB64 = Buffer.from(html, "utf8").toString("base64");
  const raw = crlf([
    "From: a@b.c",
    "Subject: alternative",
    'Content-Type: multipart/alternative; boundary="XYZ"',
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello plain",
    "--XYZ",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    "--XYZ--",
    "",
  ].join("\n"));
  const msg = mime(raw);
  assert.equal(msg.bodyText, "Hello plain");
  assert.equal(msg.bodyHtml, html);
  assert.deepEqual(msg.attachments, []);
  assert.equal(msg.structure.type, "multipart");
  assert.equal(msg.structure.parts.length, 2);
  assert.equal(msg.structure.parts[0].subtype, "plain");
  assert.equal(msg.structure.parts[1].subtype, "html");
});

test("multipart/mixed attachment with disposition filename", () => {
  const pdf = Buffer.from("%PDF-fake").toString("base64");
  const raw = crlf([
    "Subject: report",
    'Content-Type: multipart/mixed; boundary="OUTER"',
    "",
    "--OUTER",
    "Content-Type: text/plain",
    "",
    "See attached.",
    "--OUTER",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="q3 report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    pdf,
    "--OUTER--",
    "",
  ].join("\n"));
  const msg = mime(raw);
  assert.equal(msg.bodyText, "See attached.");
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, "q3 report.pdf");
  assert.equal(msg.attachments[0].contentType, "application/pdf");
  assert.equal(msg.attachments[0].size, "%PDF-fake".length);
});

test("nested multiparts", () => {
  const raw = crlf([
    "Subject: nested",
    'Content-Type: multipart/mixed; boundary="A"',
    "",
    "--A",
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "plain part",
    "--B",
    "Content-Type: text/html",
    "",
    "<p>html part</p>",
    "--B--",
    "",
    "--A",
    "Content-Type: text/plain",
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "attachment part",
    "--A--",
    "",
  ].join("\n"));
  const msg = mime(raw);
  assert.equal(msg.bodyText, "plain part");
  assert.equal(msg.bodyHtml, "<p>html part</p>");
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, "notes.txt");
});

test("latin-1 charset flows through decode_text", () => {
  // "Grüße" in ISO-8859-1: 47 72 FC DF 65
  const b64 = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]).toString("base64");
  const raw = crlf([
    'Content-Type: text/plain; charset="ISO-8859-1"',
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    "",
  ].join("\n"));
  assert.equal(mime(raw).bodyText, "Grüße");
});

test("quoted-printable body and soft line breaks", () => {
  const raw = crlf([
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 time=2E=20Line two=21",
    "soft line continues=",
    " here at last",
    "",
  ].join("\n"));
  // "…two=21" ends a hard line; "continues=" ends a soft break that joins
  assert.equal(mime(raw).bodyText, "Café time. Line two!\r\nsoft line continues here at last\r\n");
  // byte-level probe: hex output matches a reference decode
  assert.equal(
    probes.probeQpDecode("=41=42=C3=A9 soft=\r\nbreak =ZZ end="),
    Buffer.from("ABé softbreak =ZZ end=", "utf8").toString("hex"),
  );
});

test("thread key: references win over in-reply-to and own id", () => {
  const raw = crlf([
    "Message-ID: <self@x>",
    "In-Reply-To: <parent@x>",
    "References: <ROOT@X> <parent@x>",
    "Subject: re: thing",
    "",
    "body",
    "",
  ].join("\n"));
  assert.equal(mime(raw).threadKey, "root@x");
  const replyOnly = crlf([
    "Message-ID: <self@x>",
    "In-Reply-To: <parent@x>",
    "",
    "body",
    "",
  ].join("\n"));
  assert.equal(mime(replyOnly).threadKey, "parent@x");
});

test("headers json captures the store columns", () => {
  const msg = mime(crlf([
    "Subject: colcheck",
    "From: f@x",
    "To: t@y, u@z",
    "Cc: c@w",
    "Date: Mon, 1 Jan 2024 00:00:00 +0000",
    "Message-ID: <m@x>",
    "",
    "b",
    "",
  ].join("\n")));
  assert.equal(msg.headers.subject, "colcheck");
  assert.deepEqual(msg.headers.to, [
    { name: null, address: "t@y" },
    { name: null, address: "u@z" },
  ]);
  assert.deepEqual(msg.headers.cc, [{ name: null, address: "c@w" }]);
  assert.equal(msg.headers.messageId, "<m@x>");
});

test("multipart split probe: exact part sizes", () => {
  const body = crlf(["preamble", "--B", "one", "--B", "two", "--B--", ""].join("\n"));
  const sizes = JSON.parse(probes.probeSplitMultipart(body, "B"));
  assert.deepEqual(sizes, [3, 3]); // delimiter CRLFs are not part content
  assert.equal(probes.probeSplitMultipart("no boundary here", "B"), "NULL");
});

test("header/body split handles CRLF and bare LF", () => {
  const a = JSON.parse(probes.probeHeaderBodySplit("h1: v1\r\nh2: v2\r\n\r\nbody!"));
  assert.deepEqual(a, { headers: "h1: v1\r\nh2: v2", body: "body!" });
  const b = JSON.parse(probes.probeHeaderBodySplit("h1: v1\n\nbody!"));
  assert.deepEqual(b, { headers: "h1: v1", body: "body!" });
});
