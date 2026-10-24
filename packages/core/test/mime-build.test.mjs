// M3 MIME build: golden files (byte-exact fixtures), round-trip property
// (every build parses back through the M1 parser to equal fields), QP/
// RFC 2047/2231 encoders, reply/forward helpers, dot-stuffing, and SMTP
// reply parsing — all through the real probes.wasm / core.wasm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProbes, loadCore } from "./helpers/load.mjs";

const probes = await loadProbes();
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mime");

function build(message) {
  const out = probes.probeMimeBuild(JSON.stringify(message));
  assert.ok(!out.startsWith("ERR:"), out);
  return out;
}

function parse(raw) {
  return JSON.parse(probes.probeMime(raw));
}

/** Normalize for round-trip: CRLF + strip trailing newlines both sides. */
function norm(s) {
  return s.replace(/\r\n|\n|\r/g, "\n").replace(/\n+$/, "");
}

function golden(name) {
  return readFileSync(join(fixtures, name + ".eml"), "latin1");
}

// -- the golden messages (inputs mirror the fixture generator) ---------------

const ASCII = {
  from: { name: "Me", address: "me@example.com" },
  to: [{ name: "You", address: "you@example.com" }],
  cc: [{ address: "cc@example.com" }],
  subject: "Invoice October",
  text: "Hi,\nPlease find the invoice attached.\n\nRegards,\nMe",
  messageId: "<ascii-1@example.com>",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
};

const UTF8 = (() => {
  const long =
    "Grüße aus München: " +
    "Das ist eine sehr lange Zeile mit Umlauten äöü und mehr Text ".repeat(4) +
    " Ende.";
  return {
    from: { name: "Jürgen Müller", address: "juergen@example.com" },
    to: [{ name: "Søren Ångström", address: "soren@example.com" }],
    subject: "Grüße aus München — Semesterstart",
    text: long + "\nZweite Zeile mit ✨ Emoji.\n",
    messageId: "<utf8-1@example.com>",
    date: "Fri, 16 Oct 2026 12:00:00 +0000",
  };
})();

const NESTED = {
  from: { name: "Me", address: "me@example.com" },
  to: [{ address: "you@example.com" }],
  subject: "Q3 report",
  text: "See the attached report.\n",
  html: "<p>See the attached <b>report</b>.</p>",
  attachments: [
    {
      filename: "bericht-q3.pdf",
      contentType: "application/pdf",
      dataB64: Buffer.from("%PDF-1.4 fake content for golden").toString("base64"),
    },
  ],
  messageId: "<nested-1@example.com>",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
};

const UNICODE_ATT = {
  from: { address: "me@example.com" },
  to: [{ address: "you@example.com" }],
  subject: "Anhang",
  text: "Mit Anhang.\n",
  attachments: [
    {
      filename: "Übersicht 2026.csv",
      contentType: "text/csv",
      dataB64: Buffer.from("a,b,c\n1,2,3\n").toString("base64"),
    },
  ],
  messageId: "<att-1@example.com>",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
};

const REPLY = {
  from: { address: "me@example.com" },
  to: [{ address: "alice@example.com" }],
  text: "Thanks for the update!",
  replyTo: {
    subject: "Project status",
    from: "Alice <alice@example.com>",
    date: "Thu, 15 Oct 2026 09:30:00 +0000",
    messageId: "<orig-1@example.com>",
    references: "<root-1@example.com>",
    bodyText: "Here is the status:\nAll on track.",
  },
  messageId: "<reply-1@example.com>",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
};

// -- golden files: byte-exact rebuild -----------------------------------------

const GOLDENS = [
  ["ascii-simple", ASCII],
  ["utf8-quoted", UTF8],
  ["nested-multipart", NESTED],
  ["unicode-attachment", UNICODE_ATT],
  ["reply-chain", REPLY],
];

for (const [name, message] of GOLDENS) {
  test(`golden ${name}.eml: build is byte-exact`, () => {
    const expected = golden(name);
    const actual = build(message);
    assert.equal(actual, expected, `byte mismatch for ${name}`);
    assert.ok(actual.endsWith("\r\n"), "message ends with CRLF");
    assert.ok(!actual.includes("\n\n"), "no bare LF pairs (all line ends are CRLF)");
    // every line ending in the file is CRLF
    const bareLf = actual.replace(/\r\n/g, "").includes("\n");
    assert.ok(!bareLf, "no bare LF outside CRLF pairs");
  });
}

// -- round-trip: build -> M1 parser -> fields equal ---------------------------

test("round-trip: ascii-simple parses back to equal fields", () => {
  const msg = parse(build(ASCII));
  assert.equal(msg.subject, ASCII.subject);
  assert.deepEqual(msg.from, [{ name: "Me", address: "me@example.com" }]);
  assert.deepEqual(msg.to, [{ name: "You", address: "you@example.com" }]);
  assert.deepEqual(msg.cc, [{ name: null, address: "cc@example.com" }]);
  assert.equal(msg.headers.date, ASCII.date);
  assert.equal(msg.headers.messageId, "<ascii-1@example.com>");
  assert.equal(norm(msg.bodyText), norm(ASCII.text));
  assert.deepEqual(msg.attachments, []);
  assert.equal(msg.structure.type, "text");
});

test("round-trip: UTF-8 subject/names/body survive encode+parse", () => {
  const msg = parse(build(UTF8));
  assert.equal(msg.subject, UTF8.subject, "RFC 2047 subject decodes exactly");
  assert.equal(msg.from[0].name, "Jürgen Müller");
  assert.equal(msg.to[0].name, "Søren Ångström");
  assert.equal(norm(msg.bodyText), norm(UTF8.text), "QP body decodes to the original");
  assert.equal(msg.structure.encoding, "quoted-printable");
});

test("round-trip: nested multipart (alternative in mixed) with attachment", () => {
  const msg = parse(build(NESTED));
  assert.equal(norm(msg.bodyText), norm(NESTED.text));
  assert.equal(norm(msg.bodyHtml), norm(NESTED.html));
  assert.equal(msg.structure.type, "multipart");
  assert.equal(msg.structure.subtype, "mixed");
  assert.equal(msg.structure.parts[0].subtype, "alternative");
  assert.equal(msg.structure.parts[0].parts.length, 2, "text + html inside");
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, "bericht-q3.pdf");
  assert.equal(
    msg.attachments[0].size,
    Buffer.from(NESTED.attachments[0].dataB64, "base64").length,
  );
});

test("round-trip: RFC 2231 non-ASCII filename decodes back", () => {
  const msg = parse(build(UNICODE_ATT));
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, "Übersicht 2026.csv");
  assert.equal(msg.attachments[0].contentType, "text/csv");
});

test("round-trip: reply chain headers + quoted body", () => {
  const msg = parse(build(REPLY));
  assert.equal(msg.subject, "Re: Project status");
  assert.equal(msg.headers.messageId, "<reply-1@example.com>");
  assert.equal(msg.headers.inReplyTo, "<orig-1@example.com>");
  assert.equal(msg.headers.references, "<root-1@example.com> <orig-1@example.com>");
  assert.equal(msg.threadKey, "root-1@example.com", "thread root from References");
  const body = norm(msg.bodyText);
  assert.ok(body.startsWith("Thanks for the update!"), body);
  assert.ok(body.includes("On Thu, 15 Oct 2026 09:30:00 +0000, Alice <alice@example.com> wrote:"));
  assert.ok(body.includes("> Here is the status:"));
  assert.ok(body.includes("> All on track."));
});

// -- builder validation ---------------------------------------------------------

test("mime.build validation: missing from, recipients, empty body", () => {
  assert.match(probes.probeMimeBuild(JSON.stringify({ to: [{ address: "a@b.c" }], text: "x" })), /^ERR: from/);
  assert.match(
    probes.probeMimeBuild(JSON.stringify({ from: { address: "a@b.c" }, text: "x" })),
    /^ERR: at least one recipient/,
  );
  assert.match(
    probes.probeMimeBuild(
      JSON.stringify({ from: { address: "a@b.c" }, to: [{ address: "d@e.f" }] }),
    ),
    /^ERR: message is empty/,
  );
  assert.equal(probes.probeMimeBuild("not json"), "ERR: invalid JSON");
});

test("envelope recipients: to+cc+bcc flattened and deduped", () => {
  const r = JSON.parse(
    probes.probeEnvelopeRecipients(
      JSON.stringify({
        to: [{ address: "a@b.c" }, { address: "dup@b.c" }],
        cc: [{ address: "dup@b.c" }, { address: "c@d.e" }],
        bcc: [{ address: "hidden@b.c" }],
      }),
    ),
  );
  assert.equal(r, "a@b.c,dup@b.c,c@d.e,hidden@b.c");
});

// -- encoders --------------------------------------------------------------------

test("QP encoder: non-ASCII -> =XX, soft breaks at <= 76 columns", () => {
  const enc = probes.probeQpEncode("Grüße und ©符号");
  assert.match(enc, /Gr=C3=BC=C3=9Fe und =C2=A9=E7=AC=A6=E5=8F=B7/);
  // long non-ASCII line wraps with soft breaks
  const long = "ä".repeat(60) + "\nsecond line with = sign and trailing space \nend";
  const out = probes.probeQpEncode(long);
  const lines = out.split("\r\n");
  for (const l of lines.slice(0, -1)) {
    assert.ok(l.length <= 76, `line too long: ${l.length}`);
  }
  assert.match(out, /=3D/, "'=' escaped");
  assert.match(out, /=20(\r\n|$)/, "trailing space escaped at line end");
});

test("QP encoder round-trip via the existing decoder (bytes equal)", () => {
  const text = "Liné with = sig & 100% ☃\r\n\ttabbed, trailing \r\nend";
  const enc = probes.probeQpEncode(text);
  // decode with Node's oracle: soft breaks + =XX
  const bytes = [];
  for (let i = 0; i < enc.length; i++) {
    const c = enc.charCodeAt(i);
    if (c === 61 && i + 2 < enc.length && /^[0-9A-Fa-f]{2}$/.test(enc.slice(i + 1, i + 3))) {
      bytes.push(parseInt(enc.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === 61 && enc.slice(i + 1, i + 3) === "\r\n") {
      i += 2; // soft break
    } else if (c === 13 && enc.charCodeAt(i + 1) === 10) {
      bytes.push(10); // our own line split
      i += 1;
    } else {
      bytes.push(c);
    }
  }
  assert.equal(Buffer.from(bytes).toString("utf8"), text.replace(/\r\n/g, "\n"));
});

test("RFC 2047: ASCII passthrough, non-ASCII B-encoded words", () => {
  assert.equal(probes.probeEncodeHeaderWord("Plain subject"), "Plain subject");
  const enc = probes.probeEncodeHeaderWord("Grüße");
  assert.match(enc, /^\=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?\=$/);
  // injection attempt: CR/LF stripped
  const injected = probes.probeEncodeHeaderWord("evil\r\nBcc: x@y.z");
  assert.ok(!injected.includes("\r") && !injected.includes("\n"));
  // long values split into multiple <=75-char words
  const long = probes.probeEncodeHeaderWord("文".repeat(60));
  for (const word of long.split("\r\n ")) assert.ok(word.length <= 75, `word too long: ${word.length}`);
});

test("RFC 2231: ASCII quoted, non-ASCII star-encoded", () => {
  assert.equal(probes.probeRfc2231("filename", "report.pdf"), 'filename="report.pdf"');
  assert.equal(
    probes.probeRfc2231("filename", "Übersicht 2026.csv"),
    "filename*=UTF-8''%C3%9Cbersicht%202026.csv",
  );
});

test("Date header formatting (fixed epoch)", () => {
  assert.equal(probes.probeFormatDate(0), "Thu, 01 Jan 1970 00:00:00 +0000");
  assert.equal(probes.probeFormatDate(1792152000000), "Fri, 16 Oct 2026 12:00:00 +0000");
});

test("address formatting: quotes, encoded words, bare", () => {
  assert.equal(
    probes.probeFormatAddresses(JSON.stringify([{ name: "Smith, Bob", address: "b@x.org" }])),
    '"Smith, Bob" <b@x.org>',
  );
  assert.equal(
    probes.probeFormatAddresses(JSON.stringify([{ address: "plain@x.org" }])),
    "plain@x.org",
  );
  assert.equal(
    probes.probeFormatAddresses(JSON.stringify([{ name: "Jürgen", address: "j@x.org" }])),
    "=?UTF-8?B?SsO8cmdlbg==?= <j@x.org>",
  );
});

test("base64 body wrapping at 76 columns", () => {
  const b64 = Buffer.from("x".repeat(200)).toString("base64");
  const out = probes.probeBase64Wrapped(b64);
  for (const line of out.split("\r\n")) assert.ok(line.length <= 76);
  assert.equal(out.replace(/\r\n/g, ""), b64, "wrapping preserves the stream");
});

// -- reply/forward helpers --------------------------------------------------------

test("Re:/Fwd: subjects are idempotent", () => {
  assert.equal(probes.probeReplySubject("Status"), "Re: Status");
  assert.equal(probes.probeReplySubject("Re: Status"), "Re: Status", "no Re: Re:");
  assert.equal(probes.probeReplySubject("re: Status"), "re: Status", "case-insensitive");
  assert.equal(probes.probeReplySubject("RE: Status"), "RE: Status");
  assert.equal(probes.probeReplySubject("Fwd: Status"), "Re: Fwd: Status");
  assert.equal(probes.probeForwardSubject("Status"), "Fwd: Status");
  assert.equal(probes.probeForwardSubject("Fwd: Status"), "Fwd: Status");
  assert.equal(probes.probeForwardSubject("fwd: Status"), "fwd: Status");
  assert.equal(probes.probeForwardSubject("Re: Status"), "Fwd: Status");
  // nested reply of an already-Re: subject stays single
  assert.equal(probes.probeReplySubject(probes.probeReplySubject("x")), "Re: x");
});

test('quoteBody prefixes "> " on every line (empty lines become ">")', () => {
  assert.equal(probes.probeQuoteBody("one\ntwo"), "> one\r\n> two");
  assert.equal(probes.probeQuoteBody("a\n\nb"), "> a\r\n>\r\n> b");
});

// -- forward chain ---------------------------------------------------------------

const FORWARD = {
  from: { address: "me@example.com" },
  to: [{ address: "bob@example.com" }],
  text: "FYI:",
  forwardTo: {
    subject: "Budget numbers",
    from: "Carol <carol@example.com>",
    to: "me@example.com",
    date: "Wed, 15 Oct 2026 16:45:00 +0000",
    bodyText: "The budget is attached.\nTotals look fine.",
  },
  messageId: "<fwd-1@example.com>",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
};

test("forward: Fwd: subject (idempotent) + forwarded block + quoted body, no In-Reply-To", () => {
  const raw = build(FORWARD);
  const msg = parse(raw);
  assert.equal(msg.subject, "Fwd: Budget numbers");
  assert.equal(msg.headers.inReplyTo, "", "forwards do not thread");
  const body = norm(msg.bodyText);
  assert.ok(body.startsWith("FYI:"), body);
  assert.ok(body.includes("---------- Forwarded message ----------"));
  assert.ok(body.includes("From: Carol <carol@example.com>"));
  assert.ok(body.includes("Date: Wed, 15 Oct 2026 16:45:00 +0000"));
  assert.ok(body.includes("Subject: Budget numbers"));
  assert.ok(body.includes("> The budget is attached."));
  assert.ok(body.includes("> Totals look fine."));
  // idempotent: forwarding an already-forwarded subject doesn't double it
  assert.equal(probes.probeForwardSubject("Fwd: Budget numbers"), "Fwd: Budget numbers");
});

// -- SMTP reply parser + dot-stuffing ----------------------------------------------

test("SMTP replies: single-line, multiline, enhanced codes", () => {
  const t = (s, chunk = 0) => JSON.parse(probes.probeSmtpTranscript(Buffer.from(s, "latin1").toString("base64"), chunk));
  assert.deepEqual(t("220 ready\r\n"), [{ code: 220, text: "ready", enhanced: "" }]);
  const multi = t("250-mock.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1024\r\n");
  assert.equal(multi.length, 1, "multiline is one reply");
  assert.equal(multi[0].code, 250);
  assert.equal(multi[0].text, "mock.test\nAUTH PLAIN LOGIN\nSIZE 1024");
  assert.deepEqual(t("535 5.7.8 bad credentials\r\n")[0], {
    code: 535,
    text: "5.7.8 bad credentials",
    enhanced: "5.7.8",
  });
});

test("SMTP replies: chunked feeding parses identically", () => {
  // well-formed transcripts: a multiline 250 followed by a final 421
  const raw = "220 ready\r\n250-AUTH PLAIN\r\n250 PIPELINING\r\n421 try later\r\n";
  const b64 = Buffer.from(raw, "latin1").toString("base64");
  const whole = probes.probeSmtpTranscript(b64, 0);
  for (const size of [1, 2, 3, 7, 13]) {
    assert.equal(probes.probeSmtpTranscript(b64, size), whole, `chunk size ${size}`);
  }
  assert.equal(JSON.parse(whole).length, 3);
});

test("SMTP replies: leading banner garbage is skipped, malformed folded once", () => {
  const t = (s) => JSON.parse(probes.probeSmtpTranscript(Buffer.from(s, "latin1").toString("base64"), 0));
  assert.equal(t("junk line\r\n220 ok\r\n")[0].code, 220);
  const malformed = t("250-ok\r\nnot-a-code line\r\n");
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].code, 250);
  assert.match(malformed[0].text, /not-a-code line/);
});

test("dotStuff: dot-stuffs, normalizes, guarantees trailing CRLF", () => {
  assert.equal(probes.probeDotStuff("hi\r\nbye"), "hi\r\nbye\r\n", "trailing CRLF added");
  assert.equal(probes.probeDotStuff(".hi\r\nbye"), "..hi\r\nbye\r\n", "leading dot stuffed");
  assert.equal(probes.probeDotStuff("a\n.b\nc"), "a\r\n..b\r\nc\r\n", "LF->CRLF + stuff");
  assert.equal(probes.probeDotStuff("x\r\n.\r\ny"), "x\r\n..\r\ny\r\n", "bare dot line stuffed");
  // no stuff for indented dots
  assert.equal(probes.probeDotStuff(" .x"), " .x\r\n");
});

// -- mime.build as a real op (core.wasm export surface) ----------------------------

test("mime.build op completes synchronously with rawB64 and messageId", async () => {
  const core = await loadCore();
  assert.equal(core.sm_init("{}"), 0);
  const opId = core.op_start("mime.build", JSON.stringify({ message: ASCII }));
  assert.ok(opId > 0);
  const status = JSON.parse(core.op_status(opId));
  assert.equal(status.state, "done");
  assert.equal(status.result.messageId, "<ascii-1@example.com>");
  const raw = Buffer.from(status.result.rawB64, "base64").toString("latin1");
  assert.equal(raw, golden("ascii-simple"));
  assert.equal(JSON.parse(core.op_effects()).length, 0, "pure op emits no effects");
});

test("mime.build op rejects bad input with -1", async () => {
  const core = await loadCore();
  assert.equal(core.sm_init("{}"), 0);
  assert.equal(core.op_start("mime.build", "{}"), -1, "message required");
  assert.equal(
    core.op_start("mime.build", JSON.stringify({ message: { from: { address: "a@b.c" } } })),
    -1,
    "recipients required",
  );
});
