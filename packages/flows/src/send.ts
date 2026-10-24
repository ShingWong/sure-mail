// The send flow (M3): mime.build -> smtp.send -> detect Sent ->
// imap.append (best effort) -> sent_messages audit row.
//
// Flow ownership (M3): the core ops stay
// single-purpose per the ABI, so the composition lives here, above them.
// It is deliberately driver-shaped rather than bound to a host class, so
// every host with the op ABI runs the same flow (D15) instead of
// re-implementing it and drifting.
//
// No imports: this module is pure orchestration over the driver, so the
// live tests can drive the real product path against a real server.

/** Run one core op to completion; throws when the op fails or is rejected. */
export interface OpDriver {
  (kind: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** The account facts the flow needs (structural subset of the host's Account). */
export interface SendAccount {
  id: number;
  address: string;
}

/** Canonical Sent-folder names (last path segment, case-insensitive). */
const SENT_NAMES = ["sent", "sent mail", "sent items", "sent messages", "sent boxes"];

/**
 * Detect the Sent folder from imap.folders results:
 * 1. special-use `\Sent` flag wins,
 * 2. else the last path segment against canonical names (Gmail's
 *    "[Gmail]/Sent Mail" matches on its last segment),
 * 3. else null — localized names are a documented limitation (API.md).
 */
export function detectSentFolder(folders: Record<string, unknown>[]): string | null {
  const seg = (path: string, delimiter: string): string => {
    const parts = delimiter ? path.split(delimiter) : path.split(/[/.]/);
    return parts[parts.length - 1].toLowerCase();
  };
  for (const f of folders) {
    const flags = (f.flags as string[]) ?? [];
    if (flags.some((fl) => fl.toLowerCase() === "\\sent")) return String(f.path);
  }
  for (const f of folders) {
    const name = seg(String(f.path), String(f.delimiter ?? ""));
    if (SENT_NAMES.includes(name)) return String(f.path);
  }
  return null;
}

export interface SendOutcome {
  messageId: string;
  queueId?: string;
  size: number;
  recipients: { address: string; code: number; accepted: boolean }[];
  sentFolder: string | null;
  sentUid: number;
  appended: boolean;
  appendNote: string;
}

/**
 * The full send flow. `message` is the mime.build input (from/to/cc/bcc,
 * subject, text/html, attachments, reply/forward helpers).
 *
 * A failed Sent append never un-sends the mail: the audit row records the
 * outcome either way, so the caller can report "not appended".
 */
export async function sendComposed(
  driver: OpDriver,
  account: SendAccount,
  message: Record<string, unknown>,
): Promise<SendOutcome> {
  const built = await driver("mime.build", { message });
  const rawB64 = String(built.rawB64);
  const envelope = {
    from: (message.from as { address: string }).address,
    to: ((message.to as { address: string }[]) ?? []).map((a) => a.address),
    cc: ((message.cc as { address: string }[]) ?? []).map((a) => a.address),
    bcc: ((message.bcc as { address: string }[]) ?? []).map((a) => a.address),
  };
  const sent = await driver("smtp.send", { account: account.id, envelope, rawB64 });

  // append to Sent — best effort; a failed append never un-sends the mail
  let sentFolder: string | null = null;
  let sentUid = -1;
  let appendNote = "";
  try {
    const folders = await driver("imap.folders", { account: account.id });
    sentFolder = detectSentFolder(folders.folders as Record<string, unknown>[]);
    if (sentFolder === null) {
      appendNote = "no Sent folder found (localized names are not detected)";
    } else {
      const appended = await driver("imap.append", {
        account: account.id,
        folder: sentFolder,
        rawB64,
        flags: ["\\Seen"],
      });
      sentUid = Number(appended.uid ?? -1);
    }
  } catch (err) {
    appendNote = `append to Sent failed: ${err instanceof Error ? err.message : String(err)}`;
    sentFolder = null;
  }

  // audit row — always recorded once the server accepted the message
  await driver("store.query", {
    store: `account:${account.id}`,
    query: "sent_audit",
    args: {
      account: account.id,
      message_id: String(built.messageId ?? sent.messageId ?? ""),
      envelope: JSON.stringify(envelope),
      subject: String(message.subject ?? ""),
      size: Number(sent.size ?? 0),
      queue_id: String(sent.queueId ?? ""),
      appended: sentUid >= 0,
      sent_folder: sentFolder ?? "",
      sent_uid: sentUid,
      sent_at: Date.now(),
    },
  });

  return {
    messageId: String(sent.messageId ?? built.messageId ?? ""),
    queueId: sent.queueId as string | undefined,
    size: Number(sent.size ?? 0),
    recipients: (sent.recipients ?? []) as SendOutcome["recipients"],
    sentFolder,
    sentUid,
    appended: sentUid >= 0,
    appendNote,
  };
}
