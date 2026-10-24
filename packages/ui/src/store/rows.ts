// Row shapes and pure helpers shared by the stores and the shell. Core hands
// back SQL rows as `Record<string, unknown>`; these mappers give the shell
// typed, string-id entities (sure-state's store contract keys on `id`).

export interface AccountRow {
  id: string;
  address: string;
  host: string;
  port: number;
  tls: boolean;
  user: string;
}

export interface FolderRow {
  id: string;
  path: string;
  name: string;
  delimiter: string;
  flags: string;
  uidvalidity: number;
  last_seen_uid: number;
}

export interface MessageRow {
  id: string;
  uid: number;
  folder: string;
  flags: string;
  internaldate: number;
  size: number;
  subject: string;
  fromaddr: string;
}

export interface Attachment {
  filename: string;
  size: number;
}

export interface MessageBody {
  id: string;
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string;
  date: number;
  bodyText: string;
  attachments: Attachment[];
}

export function toAccount(row: Record<string, unknown>): AccountRow {
  const id = String(row.id ?? "");
  return {
    id,
    address: str(row.address),
    host: str(row.host),
    port: num(row.port),
    tls: num(row.tls) !== 0,
    user: str(row.user),
  };
}

export function toFolder(row: Record<string, unknown>): FolderRow {
  const path = str(row.path);
  return {
    id: path,
    path,
    name: str(row.name) || path,
    delimiter: str(row.delimiter),
    flags: str(row.flags),
    uidvalidity: num(row.uidvalidity),
    last_seen_uid: num(row.last_seen_uid),
  };
}

export function toMessage(row: Record<string, unknown>, folder: string): MessageRow {
  const uid = num(row.uid);
  return {
    id: `${folder}:${uid}`,
    uid,
    folder,
    flags: str(row.flags),
    internaldate: num(row.internaldate),
    size: num(row.size),
    subject: str(row.subject),
    fromaddr: str(row.fromaddr),
  };
}

export function toMessageBody(row: Record<string, unknown>, folder: string): MessageBody {
  const headers = parseObject(row.headers);
  const uid = num(row.uid);
  return {
    id: `${folder}:${uid}`,
    uid,
    folder,
    subject: str(row.subject) || str(headers.subject),
    from: addressLine(headers.from) || str(row.fromaddr),
    to: addressLine(headers.to) || str(row.toaddr),
    date: num(row.internaldate) || dateToMs(str(headers.date)),
    bodyText: bodyTextOf(row),
    attachments: parseAttachments(row.attachments),
  };
}

/** A message is unread when its stored flag list does not contain \Seen. */
export function isUnread(flags: string): boolean {
  return !flags.includes("\\Seen");
}

/** `["a@b"]`-style stored flags look like `["\\Seen","\\Flagged"]`. */
export function isFlagged(flags: string): boolean {
  return flags.includes("\\Flagged");
}

export function formatDate(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const now = new Date();
  if (d.getFullYear() !== now.getFullYear()) {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatFullDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleString();
}

/** Plain-text view of a message: body_text, or tags stripped from body_html. */
export function bodyTextOf(row: Record<string, unknown>): string {
  const text = str(row.body_text);
  if (text.trim().length > 0) return text;
  return htmlToText(str(row.body_html));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseAttachments(raw: unknown): Attachment[] {
  const parsed = parseArray(raw);
  const out: Attachment[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      out.push({ filename: str(rec.filename) || "attachment", size: num(rec.size) });
    }
  }
  return out;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Names from a parsed headers blob: prefer the display name. */
export function addressLine(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const rec = entry as Record<string, unknown>;
      const name = str(rec.name);
      const address = str(rec.address);
      if (name && address) return `${name} <${address}>`;
      return name || address;
    })
    .filter((line) => line.length > 0)
    .join(", ");
}

export function senderName(value: string): string {
  return value.replace(/^<|>$/g, "").trim() || "(unknown sender)";
}

// -- small coercion helpers --------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function dateToMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
