// Unit tests for the shared send flow — offline, no host, no wasm: the
// flow is pure orchestration over a driver, so any host runs the same code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSentFolder, sendComposed } from "../src/index.ts";

// -- detectSentFolder --------------------------------------------------------

test("detectSentFolder: the \\Sent special-use flag wins", () => {
  const folders = [
    { path: "Archive", flags: [], delimiter: "/" },
    { path: "Sent", flags: ["\\Sent"], delimiter: "/" },
  ];
  assert.equal(detectSentFolder(folders), "Sent");
});

test("detectSentFolder: flag match is case-insensitive", () => {
  assert.equal(detectSentFolder([{ path: "Gesendet", flags: ["\\sent"], delimiter: "/" }]), "Gesendet");
});

test("detectSentFolder: canonical name on the last path segment (Gmail shape)", () => {
  const folders = [{ path: "[Gmail]/Sent Mail", flags: [], delimiter: "/" }];
  assert.equal(detectSentFolder(folders), "[Gmail]/Sent Mail");
});

test("detectSentFolder: falls back to dotted segments when no delimiter is given", () => {
  assert.equal(detectSentFolder([{ path: "INBOX.Sent", flags: [], delimiter: "" }]), "INBOX.Sent");
});

test("detectSentFolder: localized/unknown names are a documented miss", () => {
  assert.equal(detectSentFolder([{ path: "Envoyés", flags: [], delimiter: "/" }]), null);
});

// -- sendComposed ------------------------------------------------------------

/** A scripted op driver: records every call, returns canned results. */
function scripted(handlers = {}) {
  const calls = [];
  const driver = async (kind, args, timeoutMs) => {
    calls.push({ kind, args, timeoutMs });
    const handler = handlers[kind];
    if (handler) return handler(args);
    return {};
  };
  return { driver, calls };
}

const HAPPY = {
  "mime.build": () => ({ rawB64: "cmF3", messageId: "<built@id>" }),
  "smtp.send": () => ({
    messageId: "<sent@id>",
    size: 306,
    queueId: "Q1",
    recipients: [{ address: "you@example.com", code: 250, accepted: true }],
  }),
  "imap.folders": () => ({ folders: [{ path: "Sent", flags: ["\\Sent"], delimiter: "/" }] }),
  "imap.append": () => ({ uid: 55 }),
  "store.query": () => ({ changes: 1 }),
};

test("sendComposed: runs build -> send -> folders -> append -> audit in order", async () => {
  const { driver, calls } = scripted(HAPPY);
  const outcome = await sendComposed(driver, { id: 1, address: "me@example.com" }, {
    from: { address: "me@example.com" },
    to: [{ address: "you@example.com" }],
    subject: "Hi",
    text: "body",
  });

  assert.deepEqual(
    calls.map((c) => c.kind),
    ["mime.build", "smtp.send", "imap.folders", "imap.append", "store.query"],
  );
  assert.equal(outcome.messageId, "<sent@id>");
  assert.equal(outcome.sentFolder, "Sent");
  assert.equal(outcome.sentUid, 55);
  assert.equal(outcome.appended, true);
  assert.equal(outcome.size, 306);

  // the envelope is flattened from to/cc/bcc, and the append used the built bytes
  const send = calls.find((c) => c.kind === "smtp.send");
  assert.deepEqual(send.args.envelope, {
    from: "me@example.com",
    to: ["you@example.com"],
    cc: [],
    bcc: [],
  });
  assert.equal(calls.find((c) => c.kind === "imap.append").args.rawB64, "cmF3");

  // the audit row records the append outcome
  const audit = calls.find((c) => c.kind === "store.query");
  assert.equal(audit.args.store, "account:1");
  assert.equal(audit.args.query, "sent_audit");
  assert.equal(audit.args.args.appended, true);
  assert.equal(audit.args.args.sent_folder, "Sent");
  assert.equal(audit.args.args.sent_uid, 55);
  assert.equal(audit.args.args.subject, "Hi");
  assert.deepEqual(JSON.parse(audit.args.args.envelope).to, ["you@example.com"]);
});

test("sendComposed: a refused append never un-sends — audit records appended:false", async () => {
  const { driver, calls } = scripted({
    ...HAPPY,
    "imap.append": () => {
      throw new Error("append to Sent failed: NO [TRYCREATE]");
    },
  });
  const outcome = await sendComposed(driver, { id: 1, address: "me@example.com" }, {
    from: { address: "me@example.com" },
    to: [{ address: "you@example.com" }],
    subject: "Hi",
    text: "body",
  });

  assert.equal(outcome.appended, false);
  assert.equal(outcome.sentFolder, null);
  assert.match(outcome.appendNote, /append to Sent failed/);
  assert.equal(outcome.messageId, "<sent@id>", "the send still succeeded");

  const audit = calls.find((c) => c.kind === "store.query");
  assert.ok(audit, "audit row still written");
  assert.equal(audit.args.args.appended, false);
  assert.equal(audit.args.args.sent_folder, "");
});

test("sendComposed: no Sent folder -> no append, note explains the miss", async () => {
  const { driver, calls } = scripted({
    ...HAPPY,
    "imap.folders": () => ({ folders: [{ path: "INBOX", flags: [], delimiter: "/" }] }),
  });
  const outcome = await sendComposed(driver, { id: 1, address: "me@example.com" }, {
    from: { address: "me@example.com" },
    to: [{ address: "you@example.com" }],
    subject: "Hi",
    text: "body",
  });

  assert.equal(outcome.sentFolder, null);
  assert.match(outcome.appendNote, /no Sent folder found/);
  assert.equal(calls.some((c) => c.kind === "imap.append"), false);
  assert.equal(calls.find((c) => c.kind === "store.query").args.args.appended, false);
});

test("sendComposed: a failed send throws and writes no audit row", async () => {
  const { driver, calls } = scripted({
    ...HAPPY,
    "smtp.send": () => {
      throw new Error("smtp.send failed: auth: 535 rejected");
    },
  });
  await assert.rejects(
    sendComposed(driver, { id: 1, address: "me@example.com" }, {
      from: { address: "me@example.com" },
      to: [{ address: "you@example.com" }],
      subject: "Hi",
      text: "body",
    }),
    /smtp\.send failed/,
  );
  assert.equal(
    calls.some((c) => c.kind === "store.query"),
    false,
    "nothing was sent, so nothing is audited",
  );
});
