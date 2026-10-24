#!/usr/bin/env node
// sure-mail CLI — the Node host (packages/host-node) with a verb surface
// (M1). Local-first: reads hit the SQLite store,
// sync pulls over IMAP through core.wasm.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MailCore,
  startRelay,
  startStaticServer,
  type OpStatus,
  type StaticServerHandle,
} from "@shing.wong/sure-mail-host";
import { sendComposed, type OpDriver, type SendOutcome } from "@shing.wong/sure-mail-flows";

interface Command {
  name: string;
  summary: string;
  usage: string;
  run(args: string[]): Promise<number>;
}

const USAGE = `sure-mail — local-first mail client (headless core + Node host)

usage: sure-mail <command> [options]

commands:
  account add <address> --host <host> [--port <n>] [--tls | --starttls]
                       [--user <user>] [--smtp-host <h>] [--smtp-port <n>]
                       [--smtp-starttls] [--password-stdin]
                                            add an account (password on stdin);
                                              --tls = implicit TLS (the default),
                                              --starttls = STARTTLS (143/587)
  account add <address> --auto [--yes] [--probe]
                                          autodiscover settings, then add
  account list                              list accounts
  account remove <id>                       remove an account
  folders [<account>]                       list mail folders over IMAP
  sync [<account>] [--folder <path>]        fetch new mail into the local store
  list <folder> [--limit <n>] [--unread]    list stored messages
  read <folder> <uid> [--raw]               show a stored/fetched message
  search <query> [--limit <n>]              full-text search the local store
  send --to <a[,b]> [--cc <a>] [--bcc <a>] [--subject <s>]
                       [--body <text> | --file <path>]
                                           compose and send, append to Sent
  reply <folder> <uid> [--body <text> | --file <path>] [--cc <a>]
                                           reply to a stored message
  forward <folder> <uid> --to <a[,b]> [--body <text> | --file <path>]
                                           forward a stored message
  draft save [--to <a>] [--subject <s>] [--body <text> | --file <path>]
                                           save a new draft (prints id)
  draft list                               list drafts
  draft show <id>                          show one draft
  draft send <id>                          send a draft (marks it sent)
  draft delete <id>                        delete a draft
  doctor                                   check ports, ABI, and store health
  serve --ui [--port <n>] [--relay-port <n>] [--ui-dir <path>]
                       [--host <addr>] [--insecure-tls] [--quiet]
                                           serve the local UI + relay —
                                             open the printed URL; loopback only
  serve --relay [--port <n>] [--host <addr>]
                       [--insecure-tls] [--quiet]
                                           run the localhost WS relay alone
                                             (loopback only)
  version                                  print version
  help                                     show this help

<account> is an id (account list) or an address; omit when there is exactly
one account. Data root: SURE_MAIL_HOME or ~/.sure-mail.

send/reply/forward: addresses are comma-separated; body comes from --body,
--file, or stdin when both are omitted. After a successful SMTP send the
copy is appended to the Sent folder (detected via \\Sent or canonical
names); when no Sent folder exists or APPEND is refused the send still
counts — it is recorded locally and reported in the output.

account add --auto runs the autodiscover chain (provider table, ISPDB, DNS
MX) and lists ranked candidates; confirm interactively or pass --yes.
--probe additionally verifies candidates with a real IMAP capability
handshake (network-touching). Env: SURE_MAIL_ISPDB_BASE overrides the
ISPDB base URL; SURE_MAIL_NO_DNS=1 skips the DNS MX strategy.

Transports (D13): every account is password-auth over TLS. --tls (the
default) is implicit TLS (IMAP 993, SMTP 465); --starttls negotiates TLS
after connecting (IMAP 143, SMTP 587); --smtp-starttls does the same for
the SMTP endpoint only. Plaintext-without-TLS is not offered. Env:
SURE_MAIL_INSECURE_TLS=1 accepts self-signed server certs (test/mock
hosts only — never a default).

serve --ui is the local client in one process: it serves the built UI
(packages/ui/dist-web) with the COOP/COEP headers the browser host needs,
and runs the relay beside it — open the printed URL and the UI's default
relay (ws://127.0.0.1:8787) is already there. No native app, so it runs on
hardware too old for a current Xcode/browser (D17). --port sets the UI port
(8788), --relay-port the relay (8787), --ui-dir overrides the build location
(or set SURE_MAIL_UI_DIR).

serve --relay runs the localhost-only WebSocket relay alone, which the
browser host (packages/host-web) uses for net/dns/http (docs/relay.md).
--host accepts loopback addresses only; --port 0 picks a free port
(announced on stdout); --quiet suppresses the banner.
SURE_MAIL_RELAY_INSECURE_TLS=1 accepts self-signed upstream certs.
`;

function fail(msg: string, code = 1): number {
  console.error(`sure-mail: ${msg}`);
  return code;
}

function usageError(msg: string): number {
  console.error(`sure-mail: ${msg}`);
  process.stderr.write(USAGE);
  return 2;
}

// -- option parsing --------------------------------------------------------

interface Options {
  positional: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "host", "port", "user", "folder", "limit", "account",
  "to", "cc", "bcc", "subject", "body", "file", "smtp-host", "smtp-port",
  "relay-port", "ui-dir",
]);
const BOOL_FLAGS = new Set([
  "tls", "starttls", "smtp-starttls", "unread", "raw", "password-stdin",
  "auto", "yes", "probe", "relay", "insecure-tls", "quiet", "ui",
]);

function parseArgs(argv: string[]): Options | null {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) return null;
      flags.set(name, value);
    } else {
      return null;
    }
  }
  return { positional, flags };
}

function readPasswordStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.replace(/[\r\n]+$/, "")));
  });
}

/**
 * Read the first stdin line (the autodiscover selection), then optionally
 * everything until EOF (the password when --password-stdin is combined
 * with an interactive confirm). One pass over one stream.
 */
function readLineThenRest(needRest: boolean): Promise<{ line: string | null; rest: string }> {
  return new Promise((resolve) => {
    let buf = "";
    let line: string | null = null;
    let settled = false;
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    const settle = (rest: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ line, rest });
    };
    const onData = (chunk: string): void => {
      buf += chunk;
      if (line === null) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!needRest) settle("");
        }
      }
    };
    const onEnd = (): void => {
      if (line === null && buf.length > 0) {
        line = buf.replace(/[\r\n]+$/, "");
        buf = "";
      }
      settle(buf.replace(/[\r\n]+$/, ""));
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

// -- boot: registry schema + account rows ----------------------------------

async function boot(): Promise<MailCore> {
  const noDns = process.env.SURE_MAIL_NO_DNS === "1" || process.env.SURE_MAIL_NO_DNS === "true";
  const insecure = process.env.SURE_MAIL_INSECURE_TLS === "1" || process.env.SURE_MAIL_INSECURE_TLS === "true";
  const core = await MailCore.load({ dns: { disabled: noDns }, net: { allowSelfSigned: insecure } });
  core.init({});
  await core.ensureSchema("registry");
  const query = core.startOp("store.query", { store: "registry", query: "accounts" });
  const status = await core.drive(query, { timeoutMs: 15000 });
  if (status.state !== "done") throw new Error(`cannot read registry: ${describe(status)}`);
  const rows = (status.result as { rows: Record<string, unknown>[] }).rows;
  core.init({ accounts: rows });
  return core;
}

interface Account {
  id: number;
  address: string;
  host: string;
  port: number;
  tls: number;
  socket_type?: string | null;
  smtp_socket_type?: string | null;
  user: string;
  password?: string | null;
  setup_source?: string | null;
}

function accountsOf(core: MailCore): Account[] {
  return core.accountList() as unknown as Account[];
}

function resolveAccount(core: MailCore, want: string | undefined): Account {
  const accounts = accountsOf(core);
  if (accounts.length === 0) throw new Error("no accounts configured (see: sure-mail account add)");
  if (want === undefined) {
    if (accounts.length === 1) return accounts[0];
    throw new Error(`multiple accounts; pass one of: ${accounts.map((a) => a.id).join(", ")}`);
  }
  const byId = accounts.find((a) => String(a.id) === want);
  if (byId) return byId;
  const byAddress = accounts.find((a) => a.address === want);
  if (byAddress) return byAddress;
  throw new Error(`unknown account '${want}' (see: sure-mail account list)`);
}

async function accountStore(core: MailCore, account: Account): Promise<void> {
  await core.ensureSchema(`account:${account.id}`);
}

function describe(status: OpStatus): string {
  if (status.error) return `${status.error.where}: ${status.error.detail} (code ${status.error.code})`;
  return status.state;
}

async function runOp(core: MailCore, kind: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<Record<string, unknown>> {
  const opId = core.startOp(kind, args);
  if (opId < 0) throw new Error(`${kind} rejected: ${opId}`);
  const status = await core.drive(opId, { timeoutMs });
  if (status.state !== "done") throw new Error(`${kind} failed: ${describe(status)}`);
  return status.result as Record<string, unknown>;
}

/** Adapt this host's op runner to the driver the send flow expects. */
function opDriver(core: MailCore): OpDriver {
  return (kind, args, timeoutMs) => runOp(core, kind, args, timeoutMs);
}

/** Where the built UI lives: --ui-dir, then SURE_MAIL_UI_DIR, then the repo layout. */
function resolveUiDir(flag: unknown): string {
  if (typeof flag === "string" && flag.length > 0) return flag;
  const env = process.env.SURE_MAIL_UI_DIR;
  if (env !== undefined && env.length > 0) return env;
  return fileURLToPath(new URL("../../ui/dist-web/", import.meta.url));
}

// -- rendering helpers -----------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/tr)[^>]*>/gi, "\n")
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

function fmtDate(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "                    ";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function fmtRow(row: Record<string, unknown>): string {
  const flags = String(row.flags ?? "[]");
  const seen = flags.includes("\\Seen") ? " " : "*";
  const uid = String(row.uid).padStart(6);
  const from = String(row.fromaddr ?? "").slice(0, 28).padEnd(28);
  const subject = String(row.subject ?? "");
  return `${seen}${uid}  ${fmtDate(row.internaldate)}  ${from}  ${subject}`;
}

// -- autodiscover (account add --auto) ---------------------------------------

interface Candidate {
  imap: { host: string; port: number; socket_type: string };
  smtp: { host: string; port: number; socket_type: string };
  auth: string;
  user: string;
  source: string;
  rank: number;
  probe?: string;
  capabilities?: string[];
}

function printAutodiscover(result: Record<string, unknown>, candidates: Candidate[]): void {
  const probing = result.probe === true;
  console.log(
    `${candidates.length} candidate(s) for ${result.address} (domain ${result.domain}${probing ? ", probe on" : ""}):`,
  );
  if (candidates.length === 0) {
    console.log("  (none — v1 requires TLS (implicit or STARTTLS) + password auth, D5/D13)");
  }
  candidates.forEach((c, i) => {
    const bits = [`auth=${c.auth}`, `source=${c.source}`, `user=${c.user}`];
    if (c.probe !== undefined) bits.push(`probe=${c.probe}`);
    console.log(
      `  ${i + 1}. ${c.imap.host}:${c.imap.port}/${c.imap.socket_type} + ${c.smtp.host}:${c.smtp.port}/${c.smtp.socket_type}  ${bits.join("  ")}`,
    );
  });
  const strategies = (result.strategies ?? []) as Record<string, unknown>[];
  const summary = strategies
    .map((s) => {
      const found = Number(s.found ?? 0);
      const rejected = Number(s.rejected ?? 0);
      let text = `${s.name}:${s.state}`;
      if (found > 0) text += `(${found}${rejected > 0 ? `+${rejected} rejected` : ""})`;
      return text;
    })
    .join("  ");
  console.log(`  strategies: ${summary}`);
}

/** Best default pick: first candidate that is accepted or went unprobed. */
function defaultCandidateIndex(candidates: Candidate[]): number {
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].probe === undefined || candidates[i].probe === "accepted") return i;
  }
  return -1;
}

async function addAutoAccount(core: MailCore, address: string, opts: Options): Promise<number> {
  const yes = opts.flags.get("yes") === true;
  const passwordStdin = opts.flags.get("password-stdin") === true;
  const args: Record<string, unknown> = { address, probe: opts.flags.get("probe") === true };
  const ispdbBase = process.env.SURE_MAIL_ISPDB_BASE;
  if (ispdbBase !== undefined) args.ispdbBase = ispdbBase;
  const result = await runOp(core, "account.autodiscover", args);
  const candidates = (result.candidates ?? []) as Candidate[];
  printAutodiscover(result, candidates);

  const fallback = defaultCandidateIndex(candidates);
  if (candidates.length === 0) {
    return fail(
      result.probe === true
        ? `no candidate answered for ${address} (v1: TLS + password auth, D5/D13)`
        : `no candidates for ${address} (v1: TLS + password auth, D5/D13); retry with --probe to test common hostnames`,
    );
  }

  let index = fallback;
  let password = "";
  if (!yes) {
    if (index < 0) {
      return fail("no candidate answered the probe (re-run without --probe to list unverified settings)");
    }
    process.stderr.write(`select candidate [1-${candidates.length}] (default ${index + 1}): `);
    const read = await readLineThenRest(passwordStdin);
    if (read.line === null) {
      return fail("confirmation required (pass --yes to accept the best match)");
    }
    if (passwordStdin) password = read.rest;
    const choice = read.line.trim();
    if (choice !== "") {
      const n = Number(choice);
      if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
        return fail(`invalid selection '${choice}' (1-${candidates.length})`);
      }
      index = n - 1;
    }
  } else {
    if (fallback < 0) {
      return fail("no candidate answered the probe (re-run without --probe to list unverified settings)");
    }
    index = fallback;
    if (passwordStdin) password = await readPasswordStdin();
  }

  const chosen = candidates[index];
  const id = core.accountAdd({
    address,
    host: chosen.imap.host,
    port: chosen.imap.port,
    tls: true,
    socket_type: chosen.imap.socket_type,
    user: chosen.user.length > 0 ? chosen.user : address,
    auth: chosen.auth,
    password,
    setup_source: chosen.source,
    smtp_host: chosen.smtp.host,
    smtp_port: chosen.smtp.port,
    smtp_socket_type: chosen.smtp.socket_type,
  });
  if (id < 0) return fail(`invalid account (${id})`);
  await core.flush();
  console.log(
    `added account ${id}: ${address} (${chosen.imap.host}:${chosen.imap.port}/${chosen.imap.socket_type}) via ${chosen.source}`,
  );
  return 0;
}

// -- compose / send flow (M3) ---------------------------------------------------

interface AddressList {
  addresses: { name?: string; address: string }[];
}

/** Parse "a@x, Bob <b@y>" into [{name,address}] (comma-separated). */
function parseAddressFlag(value: string): AddressList {
  const addresses: { name?: string; address: string }[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const angle = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle) {
      const name = angle[1].trim().replace(/^"(.*)"$/, "$1");
      addresses.push({ ...(name ? { name } : {}), address: angle[2].trim() });
    } else {
      addresses.push({ address: trimmed });
    }
  }
  return { addresses };
}

async function readBody(opts: Options): Promise<string> {
  const body = opts.flags.get("body");
  if (typeof body === "string") return body;
  const file = opts.flags.get("file");
  if (typeof file === "string") return readFileSync(file, "utf8");
  if (process.stdin.isTTY) return "";
  const stdin = await readPasswordStdin();
  return stdin;
}

function reportSend(outcome: SendOutcome): void {
  const queue = outcome.queueId ? ` queue ${outcome.queueId}` : "";
  const rejected = outcome.recipients.filter((r) => !r.accepted);
  console.log(
    `sent ${outcome.messageId} (${outcome.size} bytes${queue}) to ${outcome.recipients.length} recipient(s)`,
  );
  for (const r of outcome.recipients) {
    console.log(`  ${r.address}: ${r.accepted ? "accepted" : "rejected"} ${r.code}`);
  }
  if (outcome.appended) {
    const uid = outcome.sentUid >= 0 ? ` uid ${outcome.sentUid}` : "";
    console.log(`appended to ${outcome.sentFolder}${uid}`);
  } else {
    console.log(`not appended to Sent: ${outcome.appendNote} (recorded in sent_messages)`);
  }
  if (rejected.length > 0 && rejected.length < outcome.recipients.length) {
    console.log(`warning: ${rejected.length} recipient(s) rejected`);
  }
}

/** Load one stored message row (reply/forward source); sync hint when absent. */
async function loadStoredMessage(
  core: MailCore,
  account: Account,
  folder: string,
  uid: number,
): Promise<Record<string, unknown>> {
  const result = await runOp(core, "store.query", {
    store: `account:${account.id}`,
    query: "message",
    args: { account: account.id, folder, uid },
  });
  const rows = result.rows as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new Error(`message ${folder}/${uid} not in the local store (run: sure-mail sync --folder ${folder})`);
  }
  return rows[0];
}

function headersOf(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.headers;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Address header value from parsed headers JSON for attribution text. */
function headerAddress(headers: Record<string, unknown>, key: "from" | "to" | "replyTo"): string {
  const list = (headers[key] ?? []) as { name?: string | null; address: string }[];
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(", ");
}

// -- commands ---------------------------------------------------------------

const commands: Command[] = [
  {
    name: "account",
    summary: "add, list, or remove accounts",
    usage: "sure-mail account add|list|remove",
    run: async (argv) => {
      const [action, ...rest] = argv;
      if (action === "add") {
        const opts = parseArgs(rest);
        if (!opts || opts.positional.length !== 1) return usageError("account add needs <address>");
        const address = opts.positional[0];
        const auto = opts.flags.get("auto") === true;
        const host = opts.flags.get("host");
        if (auto && host !== undefined) return usageError("--auto and --host are mutually exclusive");
        if (!auto && typeof host !== "string") return usageError("account add needs --host or --auto");
        if (auto && !address.includes("@")) return usageError("account add needs a valid <address>");
        if (opts.flags.get("tls") === true && opts.flags.get("starttls") === true) {
          return usageError("--tls and --starttls are mutually exclusive");
        }
        const core = await boot();
        try {
          if (auto) return await addAutoAccount(core, address, opts);
          const starttls = opts.flags.get("starttls") === true;
          const password = opts.flags.get("password-stdin") ? await readPasswordStdin() : "";
          const smtpHost = opts.flags.get("smtp-host");
          const smtpPort = opts.flags.get("smtp-port");
          const account: Record<string, unknown> = {
            address,
            host,
            port: Number(opts.flags.get("port") ?? (starttls ? 143 : 993)),
            tls: true, // D13: password auth is always over TLS (implicit or STARTTLS)
            socket_type: starttls ? "starttls" : "tls",
            user: String(opts.flags.get("user") ?? address),
            password,
          };
          if (typeof smtpHost === "string") account.smtp_host = smtpHost;
          if (smtpPort !== undefined) account.smtp_port = Number(smtpPort);
          if (opts.flags.get("smtp-starttls") === true) account.smtp_socket_type = "starttls";
          const id = core.accountAdd(account);
          if (id < 0) return fail(`invalid account (${id})`);
          await core.flush();
          console.log(`added account ${id}: ${address} (${host})`);
          return 0;
        } finally {
          core.close();
        }
      }
      if (action === "list") {
        const core = await boot();
        try {
          const accounts = accountsOf(core);
          if (accounts.length === 0) {
            console.log("no accounts configured");
            return 0;
          }
          for (const a of accounts) {
            const transport = a.socket_type === "starttls" ? "starttls" : "tls";
            const source = a.setup_source ? `  source=${a.setup_source}` : "";
            console.log(`${String(a.id).padStart(3)}  ${a.address}  ${a.host}:${a.port} (${transport})  user=${a.user}${source}`);
          }
          return 0;
        } finally {
          core.close();
        }
      }
      if (action === "remove") {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) return usageError("account remove needs <id>");
        const core = await boot();
        try {
          const rc = core.accountRemove(id);
          if (rc < 0) return fail(`cannot remove account ${id} (${rc})`);
          await core.flush();
          console.log(`removed account ${id}`);
          return 0;
        } finally {
          core.close();
        }
      }
      return usageError(`unknown account action '${action ?? ""}'`);
    },
  },
  {
    name: "folders",
    summary: "list mail folders over IMAP",
    usage: "sure-mail folders [<account>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts) return usageError("bad options");
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.positional[0] ?? (opts.flags.get("account") as string | undefined));
        await accountStore(core, account);
        const result = await runOp(core, "imap.folders", { account: account.id });
        const folders = result.folders as Record<string, unknown>[];
        for (const f of folders) {
          console.log(`${String(f.path)}  [${(f.flags as string[]).join(" ")}]`);
        }
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "sync",
    summary: "fetch new mail into the local store",
    usage: "sure-mail sync [<account>] [--folder <path>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts) return usageError("bad options");
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.positional[0] ?? (opts.flags.get("account") as string | undefined));
        await accountStore(core, account);
        const args: Record<string, unknown> = { account: account.id };
        const folder = opts.flags.get("folder");
        if (typeof folder === "string") args.folder = folder;
        const result = await runOp(core, "imap.sync", args);
        const folders = result.folders as Record<string, unknown>[];
        let total = 0;
        for (const f of folders) {
          const uids = f.newUids as number[];
          total += uids.length;
          console.log(`${f.folder}: ${uids.length} new (${uids.slice(0, 10).join(", ")}${uids.length > 10 ? ", …" : ""})`);
        }
        console.log(`sync complete: ${total} new message(s)`);
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "list",
    summary: "list stored messages",
    usage: "sure-mail list <folder> [--limit <n>] [--unread] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts || opts.positional.length !== 1) return usageError("list needs <folder>");
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const args: Record<string, unknown> = {
          account: account.id,
          folder: opts.positional[0],
          limit: Number(opts.flags.get("limit") ?? 50),
        };
        if (opts.flags.get("unread")) args.unread = true;
        const result = await runOp(core, "store.query", { store: `account:${account.id}`, query: "messages", args });
        const rows = result.rows as Record<string, unknown>[];
        if (rows.length === 0) {
          console.log("no messages (see: sure-mail sync)");
          return 0;
        }
        for (const row of [...rows].sort((a, b) => Number(a.uid) - Number(b.uid))) {
          console.log(fmtRow(row));
        }
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "read",
    summary: "show one message",
    usage: "sure-mail read <folder> <uid> [--raw] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      const uid = Number(opts?.positional[1]);
      if (!opts || opts.positional.length !== 2 || !Number.isInteger(uid)) {
        return usageError("read needs <folder> <uid>");
      }
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const result = await runOp(core, "imap.fetch", { account: account.id, folder: opts.positional[0], uid });
        if (opts.flags.get("raw")) {
          process.stdout.write(Buffer.from(String(result.rawB64), "base64"));
          return 0;
        }
        console.log(`Subject: ${String(result.subject ?? subjectOf(result))}`);
        console.log(`From: ${addressesOf(result, "from")}`);
        console.log(`To: ${addressesOf(result, "to")}`);
        console.log(`Date: ${String(dateOf(result))}`);
        console.log("");
        let text = String(result.bodyText ?? "");
        if (text.trim().length === 0) text = htmlToText(String(result.bodyHtml ?? ""));
        console.log(text);
        const attachments = result.attachments as Record<string, unknown>[];
        if (attachments.length > 0) {
          console.log("");
          console.log(`attachments: ${attachments.map((a) => `${a.filename} (${a.size}b)`).join(", ")}`);
        }
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "search",
    summary: "full-text search the local store",
    usage: "sure-mail search <query> [--limit <n>] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts || opts.positional.length < 1) return usageError("search needs <query>");
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const args = {
          q: opts.positional.join(" "),
          limit: Number(opts.flags.get("limit") ?? 50),
        };
        const result = await runOp(core, "store.query", { store: `account:${account.id}`, query: "search", args });
        const rows = result.rows as Record<string, unknown>[];
        if (rows.length === 0) {
          console.log("no matches");
          return 0;
        }
        for (const row of rows) {
          console.log(`${row.folder}  ${String(row.uid).padStart(6)}  ${fmtDate(row.internaldate)}  ${String(row.subject ?? "")}`);
        }
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "send",
    summary: "compose and send a message",
    usage: "sure-mail send --to <a[,b]> [--cc <a>] [--bcc <a>] [--subject <s>] [--body <text> | --file <path>] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts) return usageError("bad options");
      const to = opts.flags.get("to");
      if (typeof to !== "string" || to.trim().length === 0) {
        return usageError("send needs --to <address>");
      }
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const text = await readBody(opts);
        const subject = typeof opts.flags.get("subject") === "string" ? String(opts.flags.get("subject")) : "";
        const message: Record<string, unknown> = {
          from: { address: account.address },
          to: parseAddressFlag(to).addresses,
          cc: typeof opts.flags.get("cc") === "string" ? parseAddressFlag(String(opts.flags.get("cc"))).addresses : [],
          bcc: typeof opts.flags.get("bcc") === "string" ? parseAddressFlag(String(opts.flags.get("bcc"))).addresses : [],
          subject,
          text,
        };
        const outcome = await sendComposed(opDriver(core), account, message);
        reportSend(outcome);
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "reply",
    summary: "reply to a stored message",
    usage: "sure-mail reply <folder> <uid> [--body <text> | --file <path>] [--cc <a>] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      const uid = Number(opts?.positional[1]);
      if (!opts || opts.positional.length !== 2 || !Number.isInteger(uid)) {
        return usageError("reply needs <folder> <uid>");
      }
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const row = await loadStoredMessage(core, account, opts.positional[0], uid);
        const headers = headersOf(row);
        const replyToList = (headers.replyTo ?? []) as { address: string }[];
        const fromList = (headers.from ?? []) as { address: string }[];
        const target = replyToList.length > 0 ? replyToList : fromList;
        if (target.length === 0) {
          throw new Error("stored message has no From/Reply-To address to reply to");
        }
        const text = await readBody(opts);
        const message: Record<string, unknown> = {
          from: { address: account.address },
          to: target,
          cc: typeof opts.flags.get("cc") === "string" ? parseAddressFlag(String(opts.flags.get("cc"))).addresses : [],
          text,
          replyTo: {
            subject: String(headers.subject ?? ""),
            from: headerAddress(headers, "from"),
            date: String(headers.date ?? ""),
            messageId: String(headers.messageId ?? ""),
            references: String(headers.references ?? ""),
            bodyText: String(row.body_text ?? ""),
          },
        };
        const outcome = await sendComposed(opDriver(core), account, message);
        reportSend(outcome);
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "forward",
    summary: "forward a stored message",
    usage: "sure-mail forward <folder> <uid> --to <a[,b]> [--body <text> | --file <path>] [--account <a>]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      const uid = Number(opts?.positional[1]);
      if (!opts || opts.positional.length !== 2 || !Number.isInteger(uid)) {
        return usageError("forward needs <folder> <uid>");
      }
      const to = opts.flags.get("to");
      if (typeof to !== "string" || to.trim().length === 0) {
        return usageError("forward needs --to <address>");
      }
      const core = await boot();
      try {
        const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
        await accountStore(core, account);
        const row = await loadStoredMessage(core, account, opts.positional[0], uid);
        const headers = headersOf(row);
        const text = await readBody(opts);
        const message: Record<string, unknown> = {
          from: { address: account.address },
          to: parseAddressFlag(to).addresses,
          text,
          forwardTo: {
            subject: String(headers.subject ?? ""),
            from: headerAddress(headers, "from"),
            to: headerAddress(headers, "to"),
            date: String(headers.date ?? ""),
            bodyText: String(row.body_text ?? ""),
          },
        };
        const outcome = await sendComposed(opDriver(core), account, message);
        reportSend(outcome);
        return 0;
      } finally {
        core.close();
      }
    },
  },
  {
    name: "draft",
    summary: "save, list, show, send, or delete drafts",
    usage: "sure-mail draft save|list|show <id>|send <id>|delete <id>",
    run: async (argv) => {
      const [action, ...rest] = argv;
      if (action === "save") {
        const opts = parseArgs(rest);
        if (!opts) return usageError("bad options");
        const core = await boot();
        try {
          const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
          await accountStore(core, account);
          const text = await readBody(opts);
          const to = typeof opts.flags.get("to") === "string" ? parseAddressFlag(String(opts.flags.get("to"))).addresses : [];
          const result = await runOp(core, "store.query", {
            store: `account:${account.id}`,
            query: "draft_save",
            args: {
              account: account.id,
              subject: typeof opts.flags.get("subject") === "string" ? String(opts.flags.get("subject")) : "",
              fromaddr: account.address,
              toaddrs: JSON.stringify(to),
              ccaddrs: JSON.stringify(typeof opts.flags.get("cc") === "string" ? parseAddressFlag(String(opts.flags.get("cc"))).addresses : []),
              bccaddrs: JSON.stringify(typeof opts.flags.get("bcc") === "string" ? parseAddressFlag(String(opts.flags.get("bcc"))).addresses : []),
              body_text: text,
              body_html: "",
              attachments: "[]",
              now: Date.now(),
            },
          });
          console.log(`draft ${result.insertId} saved`);
          return 0;
        } finally {
          core.close();
        }
      }
      if (action === "list" || action === "show" || action === "send" || action === "delete") {
        const opts = parseArgs(rest);
        if (!opts) return usageError("bad options");
        const id = Number(opts.positional[0]);
        if ((action === "show" || action === "send" || action === "delete") && !Number.isInteger(id)) {
          return usageError(`draft ${action} needs <id>`);
        }
        const core = await boot();
        try {
          const account = resolveAccount(core, opts.flags.get("account") as string | undefined);
          await accountStore(core, account);
          if (action === "list") {
            const result = await runOp(core, "store.query", {
              store: `account:${account.id}`,
              query: "drafts",
              args: { account: account.id },
            });
            const rows = result.rows as Record<string, unknown>[];
            if (rows.length === 0) {
              console.log("no drafts");
              return 0;
            }
            for (const row of rows) {
              const when = fmtDate(row.updated_at);
              const marker = row.status === "sent" ? "sent" : "    ";
              console.log(
                `${String(row.id).padStart(4)} ${marker}  ${when}  ${String(row.subject ?? "")}  -> ${String(row.toaddrs ?? "[]")}`,
              );
            }
            return 0;
          }
          const result = await runOp(core, "store.query", {
            store: `account:${account.id}`,
            query: "draft",
            args: { account: account.id, id },
          });
          const rows = result.rows as Record<string, unknown>[];
          if (rows.length === 0) return fail(`draft ${id} not found`);
          const row = rows[0];
          if (action === "delete") {
            await runOp(core, "store.query", {
              store: `account:${account.id}`,
              query: "draft_delete",
              args: { account: account.id, id },
            });
            console.log(`draft ${id} deleted`);
            return 0;
          }
          if (action === "show") {
            console.log(`draft ${row.id} (${row.status})`);
            console.log(`From: ${row.fromaddr}`);
            console.log(`To: ${row.toaddrs}`);
            if (String(row.ccaddrs ?? "[]") !== "[]") console.log(`Cc: ${row.ccaddrs}`);
            if (String(row.bccaddrs ?? "[]") !== "[]") console.log(`Bcc: ${row.bccaddrs}`);
            console.log(`Subject: ${row.subject ?? ""}`);
            console.log("");
            console.log(String(row.body_text ?? ""));
            return 0;
          }
          // draft send
          if (row.status === "sent") return fail(`draft ${id} already sent (${row.message_id})`);
          const to = JSON.parse(String(row.toaddrs ?? "[]")) as { name?: string; address: string }[];
          const cc = JSON.parse(String(row.ccaddrs ?? "[]")) as { name?: string; address: string }[];
          const bcc = JSON.parse(String(row.bccaddrs ?? "[]")) as { name?: string; address: string }[];
          if (to.length + cc.length + bcc.length === 0) {
            return fail(`draft ${id} has no recipients`);
          }
          const message: Record<string, unknown> = {
            from: { address: String(row.fromaddr) },
            to,
            cc,
            bcc,
            subject: String(row.subject ?? ""),
            text: String(row.body_text ?? ""),
            html: String(row.body_html ?? ""),
          };
          const inReplyTo = row.in_reply_to;
          if (typeof inReplyTo === "string" && inReplyTo.length > 0) {
            message.inReplyTo = inReplyTo;
            message.references = String(row.references_hdr ?? "");
          }
          const outcome = await sendComposed(opDriver(core), account, message);
          reportSend(outcome);
          await runOp(core, "store.query", {
            store: `account:${account.id}`,
            query: "draft_mark_sent",
            args: {
              account: account.id,
              id,
              message_id: outcome.messageId,
              sent_at: Date.now(),
              sent_folder: outcome.sentFolder ?? "",
              sent_uid: outcome.sentUid,
            },
          });
          console.log(`draft ${id} marked sent`);
          return 0;
        } finally {
          core.close();
        }
      }
      return usageError(`unknown draft action '${action ?? ""}'`);
    },
  },
  {
    name: "doctor",
    summary: "check ports, ABI, and store health",
    usage: "sure-mail doctor",
    run: async () => {
      let failures = 0;
      const check = (ok: boolean, name: string, detail: string): void => {
        if (!ok) failures++;
        console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
      };

      const [major, minor] = process.versions.node.split(".").map(Number);
      check(major > 22 || (major === 22 && minor >= 18), "node", process.version);

      let sqliteOk = false;
      let sqliteDetail = "";
      try {
        const { DatabaseSync } = await import("node:sqlite");
        new DatabaseSync(":memory:").close();
        sqliteOk = true;
        sqliteDetail = "node:sqlite";
      } catch (err) {
        sqliteDetail = err instanceof Error ? err.message : String(err);
      }
      check(sqliteOk, "store port", sqliteDetail);

      const core = await MailCore.load({ log: () => {} });
      try {
        check(/^\d+\.\d+\.\d+$/.test(core.version()), "core.wasm", `sm_version ${core.version()}`);

        const imports = WebAssembly.Module.imports(
          new WebAssembly.Module(readFileSync(core.wasmPath)),
        );
        const allowed = new Set(["sm.host:now_ms", "sm.host:random_bytes", "sm.host:decode_text", "env:abort"]);
        const bad = imports.filter((i) => !allowed.has(`${i.module}:${i.name}`));
        check(
          bad.length === 0,
          "abi imports",
          bad.length === 0 ? `${imports.length} imports, all sm.host/abort` : `forbidden: ${bad.map((i) => `${i.module}:${i.name}`).join(", ")}`,
        );

        const initRc = core.init({});
        check(initRc === 0, "sm_init", `rc ${initRc}`);

        const opId = core.startOp("echo", { msg: "doctor" });
        if (opId > 0) core.feedExternal("echo.data", { id: opId, echo: "ok" });
        const status = opId > 0 ? await core.drive(opId, { timeoutMs: 3000 }) : null;
        check(status?.state === "done", "effects/feeds loop", `op ${opId} -> ${status?.state ?? "start failed"}`);

        await core.ensureSchema("registry");
        const q = core.startOp("store.query", { store: "registry", query: "accounts" });
        const rows = await core.drive(q, { timeoutMs: 5000 });
        check(rows.state === "done", "registry store", `accounts query -> ${rows.state}`);
      } finally {
        core.close();
      }
      console.log(failures === 0 ? "doctor: all checks passed" : `doctor: ${failures} check(s) failed`);
      return failures === 0 ? 0 : 1;
    },
  },
  {
    name: "serve",
    summary: "serve the local UI (+ relay), or just the relay",
    usage: "sure-mail serve (--ui | --relay) [--port <n>] [--relay-port <n>] [--ui-dir <path>] [--host <addr>] [--insecure-tls] [--quiet]",
    run: async (argv) => {
      const opts = parseArgs(argv);
      if (!opts) return usageError("bad options");
      const ui = opts.flags.get("ui") === true;
      const relayOnly = opts.flags.get("relay") === true;
      if (ui === relayOnly) return usageError("serve needs exactly one of --ui or --relay");
      const hostFlag = opts.flags.get("host");
      const host = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
      const quiet = opts.flags.get("quiet") === true;
      const insecureTls = opts.flags.get("insecure-tls") === true || process.env.SURE_MAIL_RELAY_INSECURE_TLS === "1";
      // `--port` is the relay port in --relay mode (historical) and the UI
      // port in --ui mode, where the relay moves to --relay-port.
      const portFlag = opts.flags.get("port");
      const relayPortFlag = opts.flags.get("relay-port");
      const relayPort = ui
        ? relayPortFlag !== undefined ? Number(relayPortFlag) : 8787
        : portFlag !== undefined ? Number(portFlag) : 8787;
      const uiPort = portFlag !== undefined ? Number(portFlag) : 8788;
      for (const [label, value] of [["--port", ui ? uiPort : relayPort], ["--relay-port", relayPort]] as const) {
        if (!Number.isInteger(value) || value < 0 || value > 65535) return usageError(`${label} must be 0-65535`);
      }
      let uiDir = "";
      if (ui) {
        uiDir = resolveUiDir(opts.flags.get("ui-dir"));
        if (!existsSync(join(uiDir, "index.html"))) {
          return fail(`no built UI at ${uiDir} — run \`npm run build:web\`, or pass --ui-dir <path>`);
        }
      }
      // startRelay refuses any non-loopback bind (relay security posture).
      const relay = await startRelay({
        port: relayPort,
        host,
        allowSelfSigned: insecureTls,
        ...(quiet ? {} : { log: (msg: string) => console.error(msg) }),
      });
      if (!quiet) {
        console.log(`relay ready on ws://${relay.address().address}:${relay.port}${insecureTls ? " (insecure-tls)" : ""}`);
      }
      // The UI is served with COOP/COEP; its default relay URL is
      // ws://127.0.0.1:8787, which is why the relay default matters here.
      let uiServer: StaticServerHandle | null = null;
      if (ui) {
        uiServer = await startStaticServer({ port: uiPort, outDir: uiDir, host });
        if (!quiet) console.log(`sure-mail UI on ${uiServer.url} (relay ws://${host}:${relay.port})`);
      }
      // Run until signalled: this is a daemon, not a one-shot verb.
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          const closers = [relay.close(), ...(uiServer ? [uiServer.close()] : [])];
          void Promise.all(closers).then(() => resolve());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      if (!quiet) console.error(ui ? "sure-mail stopped" : "relay stopped");
      return 0;
    },
  },
  {
    name: "version",
    summary: "print version",
    usage: "sure-mail version",
    run: async () => {
      console.log(VERSION);
      return 0;
    },
  },
];

function subjectOf(result: Record<string, unknown>): string {
  const headers = result.headers as Record<string, unknown> | undefined;
  return headers ? String(headers.subject ?? "") : "";
}

function dateOf(result: Record<string, unknown>): string {
  const headers = result.headers as Record<string, unknown> | undefined;
  return headers ? String(headers.date ?? "") : "";
}

function addressesOf(result: Record<string, unknown>, key: "from" | "to"): string {
  const headers = result.headers as Record<string, unknown> | undefined;
  const addrs = (headers?.[key] ?? []) as Record<string, string>[];
  return addrs
    .map((a) => (a.name ? `${a.name} <${a.address}>` : String(a.address ?? "")))
    .join(", ");
}

export const VERSION = "0.1.0";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(VERSION);
    return 0;
  }
  const command = commands.find((c) => c.name === cmd);
  if (!command) return usageError(`unknown command '${cmd}'`);
  try {
    return await command.run(rest);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`sure-mail: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
