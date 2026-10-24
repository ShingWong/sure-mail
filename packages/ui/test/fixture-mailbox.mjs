// Deterministic fixture mailbox for the M5 visual QA harness, the measured
// skin-fidelity checks and the runtime switch e2e: three folders (INBOX plus a
// special Drafts — Thunderbird's purple folder icon — and a non-special
// Receipts, so the rail renders both groups) with six INBOX messages covering
// unread / flagged / read rows. The mock serves the scripted sync the core
// drives; no network beyond loopback.
import { envelopeLine, loginScripts } from "../../host-node/test/mock-imap.mjs";

export const FIXTURE_FOLDERS = ["INBOX", "Drafts", "Receipts"];

export const FIXTURE_MESSAGES = [
  { uid: 1, subject: "Security alert - new sign-in on Chrome", from: "Google", date: "16-Oct-2026 10:42:00 +0000", flags: "" },
  { uid: 2, subject: "Q4 planning - agenda", from: "Alex Rivera", date: "16-Oct-2026 09:58:00 +0000", flags: "\\Seen" },
  { uid: 3, subject: "PR #482 merged: token-driven mail list", from: "GitHub", date: "16-Oct-2026 09:31:00 +0000", flags: "" },
  { uid: 4, subject: "Your statement is ready - October", from: "Contoso Bank", date: "15-Oct-2026 18:00:00 +0000", flags: "\\Flagged" },
  { uid: 5, subject: "Pictures from the coast - finally sorted", from: "Mom", date: "15-Oct-2026 12:00:00 +0000", flags: "" },
  { uid: 6, subject: "Billing notification - October", from: "AWS", date: "14-Oct-2026 08:00:00 +0000", flags: "\\Seen" },
];

// MockIMAP writes scripted responses as latin1, so the fixture text stays
// ASCII (an em dash would be mangled into a control byte and render as tofu).
const BODY = (m) =>
  [
    `From: ${m.from} <${m.from.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com>`,
    "To: me@example.com",
    `Subject: ${m.subject}`,
    `Date: ${m.date}`,
    `Message-ID: <m${m.uid}@example.com>`,
    "",
    `Hi team, this is the body of "${m.subject}".`,
    "",
    "Thanks,",
    m.from,
    "",
  ].join("\r\n");

const META = /UID FETCH 1:\* \(UID FLAGS INTERNALDATE RFC822\.SIZE ENVELOPE\)/;

/** The standard connect + LIST + per-folder sync the core drives (no folder arg). */
export function armFixture(mock) {
  loginScripts(mock);
  mock.script(
    /LIST "" "\*"/,
    [
      ...FIXTURE_FOLDERS.map((folder) => `* LIST (\\HasNoChildren) "/" "${folder}"`),
      "{tag} OK LIST done",
    ].join("\r\n") + "\r\n",
  );
  let uidValidity = 100;
  for (const folder of FIXTURE_FOLDERS) {
    const messages = folder === "INBOX" ? FIXTURE_MESSAGES : [];
    mock.script(
      new RegExp(`SELECT "${folder}"`),
      [
        `* ${messages.length} EXISTS`,
        "* 0 RECENT",
        `* OK [UIDVALIDITY ${uidValidity}] UIDs valid`,
        "{tag} OK [READ-WRITE] SELECT done",
      ].join("\r\n") + "\r\n",
    );
    mock.script(META, (line) => {
      const tag = line.split(" ")[0];
      const rows = messages.map((m) =>
        envelopeLine(m.uid, m.uid, m.subject, m.from.toLowerCase().replace(/[^a-z]+/g, "."), "me", m.date).replace(
          "FLAGS (\\Seen)",
          `FLAGS (${m.flags})`,
        ),
      );
      return rows.length > 0
        ? rows.join("\r\n") + `\r\n${tag} OK UID FETCH done\r\n`
        : `${tag} OK UID FETCH done\r\n`;
    });
    if (messages.length > 0) {
      mock.script(/UID FETCH 1,2,3,4,5,6 \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)/, (line) => {
        const tag = line.split(" ")[0];
        const rows = messages.map((m) => {
          const raw = BODY(m);
          const bytes = Buffer.byteLength(raw, "latin1");
          return (
            `* ${m.uid} FETCH (UID ${m.uid} FLAGS (${m.flags}) INTERNALDATE "${m.date}" BODY[] {${bytes}}\r\n` +
            `${raw})`
          );
        });
        return rows.join("\r\n") + `\r\n${tag} OK bodies done\r\n`;
      });
    }
    uidValidity += 100;
  }
}
