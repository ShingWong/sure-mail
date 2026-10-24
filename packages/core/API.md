# sure-mail core — API (the agentic contract)

`dist/core.wasm` is the entire mail-logic core: ops in, effects out, feeds
in. It performs **zero I/O itself** — a test greps its wasm import section
to enforce it. This file documents every export, op kind, effect kind, feed
kind, and error code. Sources: [docs/abi.md](../../docs/abi.md).

## Shape

```
host calls (exports)                 core imports (the only wasm imports)
---------------------                ------------------------------------
sm_init / account_* / op_*           sm.host.now_ms()          -> f64
op_effects()  -> drain effect queue  sm.host.random_bytes(n)   -> fills core buffer
op_feed(...)  -> deliver a result    sm.host.decode_text(...)  -> string (TextDecoder)
op_status(op) -> observe completion
```

The host owns the reactor loop: start op(s) → drain effects and execute
them → feed results back → observe `op_status` until not `pending`.
Bytes cross the JSON boundary as base64 (`b64` fields). Reference driver:
`@shing.wong/sure-mail-host` (packages/host-node).

## Loading

`packages/core/dist/` ships asc raw bindings generated from the AS sources:

```js
import { instantiate } from "@shing.wong/sure-mail-core"; // dist/core.js
import { createRequire } from "node:module";
const wasmPath = createRequire(import.meta.url).resolve("@shing.wong/sure-mail-core/wasm");
const core = await instantiate(await WebAssembly.compile(readFileSync(wasmPath)), {
  "sm.host": { now_ms, random_bytes, decode_text },
  env: {},
});
```

`instantiate` adapts strings both ways; `decode_text(dataPtr, dataLen,
charset)` receives raw pointers plus the charset as a JS string and returns
a JS string (never null — fall back to single-byte decoding for unknown
charsets).

## Exports

| export | signature | returns |
|--------|-----------|---------|
| `sm_version()` | `() => string` | core API semver (`"0.5.0"`) |
| `sm_init(configJson)` | `(string) => number` | `0` ok, `<0` error. Config: `{accounts?: Account[], logLevel?: string}`. Seeds the in-memory account registry from host-loaded rows. Required before `op_start` (`-3`). Rejected while ops are pending (`-3`). |
| `account_add(json)` | `(Account) => number` | id `> 0`, or `<0`. Requires `address` + `host`; optional `port`, `tls`, `user`, `auth`, `password`, `setup_source`, `smtp_host`, `smtp_port` (v3), `socket_type`, `smtp_socket_type` (v4, `"tls"` \| `"starttls"` — any other value, e.g. `"plain"`, is rejected `-1`). |
| `account_update(id, json)` | `(number, Account) => number` | `0` ok; `-2` unknown id; `-1` invalid |
| `account_remove(id)` | `(number) => number` | `0` ok; `-2` unknown id |
| `account_list()` | `() => string` | JSON array of accounts |
| `op_start(kind, argsJson)` | `(string, string) => number` | op id `> 0`; `-1` bad args; `-6` unknown kind; `-3` not initialized |
| `op_status(opId)` | `(number) => string` | `{"state":"pending\|done\|error\|cancelled","result":<any>\|null,"error":{code,name,where,detail}\|null}`; unknown id → `state:"error"` with `code:-2` |
| `op_effects()` | `() => string` | JSON array of queued effects; one drain per call (host loops until `[]`) |
| `op_feed(kind, dataJson)` | `(string, string) => number` | `0` on success **and** for stale feeds (acknowledged + discarded); `-1` malformed JSON. A rejected feed fails its op. |
| `op_cancel(opId)` | `(number) => number` | `0` ok; `-2` unknown; `-3` already finished. Op ends `cancelled` with `code:-7`. |

`account_add`/`update`/`remove` also queue detached `store.exec` effects
against the `registry` store; the host drains them (e.g. `flush()`)
right after the call. Boot pattern for a fresh process:

```
sm_init({}) -> op store.query {store:"registry", query:"schema"}   // apply schema
            -> op store.query {store:"registry", query:"accounts"} // read rows
            -> sm_init({accounts: rows})                           // warm registry
```

## Op kinds (v1: M0 + M1 + M2 + M3)

| kind | args | effects | feeds in | result |
|------|------|---------|----------|--------|
| `echo` | `{msg?}` | `log` | `echo.data` `{id, echo}` | `{echo, msg}` — test-only: proves the effects/feeds loop with no network |
| `imap.connect` | `{account}` | net.* | net.* | `{capabilities}` — connects per the account's transport (implicit TLS, or STARTTLS: greeting → CAPABILITY → require `STARTTLS` → STARTTLS → net.upgrade → re-CAPABILITY → LOGIN), then LOGIN |
| `imap.folders` | `{account}` | net.*, store.exec | net.*, store.result | `{folders:[{path,name,delimiter,flags}]}` — LIST; also upserts the `folders` table |
| `imap.sync` | `{account, folder?}` | net.*, store.exec | net.*, store.result | `{folders:[{folder,newUids}]}` — per folder: SELECT, UIDVALIDITY resync (changed uidvalidity → refetch from uid 1), incremental `UID FETCH last+1:* (… ENVELOPE)` then batched `UID FETCH … (UID FLAGS INTERNALDATE BODY.PEEK[])`; stores message rows + fts refresh; updates `last_seen_uid`. Omit `folder` to sync every LISTed folder. |
| `imap.fetch` | `{account, folder, uid}` | net.*, store.exec | net.*, store.result | `{uid, flags, internalDate, size, headers, structure, bodyText, bodyHtml, attachments, threadKey, rawB64}` — full source via `BODY.PEEK[]`; stores the row and marks it `\Seen` locally |
| `imap.append` | `{account, folder, rawB64, flags?}` | net.* | net.* | `{uid, uidValidity?, literalAccepted}` — APPEND with a synchronizing literal (`{n}` + `+` continuation, RFC 3502); uid comes from `[APPENDUID uidvalidity uid]` (RFC 4315), `-1` when the server omits it (caller can resync). Unknown flags are dropped; free-form strings never reach the wire. |
| `store.query` | `{store, query, args?}` | store.exec | store.result | `{rows, changes, insertId}` — named, core-owned reads (see below) |
| `account.autodiscover` | `{address, probe?, ispdbBase?}` | http.fetch, dns.lookup, net.* | http.result, dns.result, net.* | `{address, domain, probe, candidates:[…], strategies:[…]}` — see below |
| `smtp.send` | `{account, envelope:{from, to[], cc?[], bcc?[]}, rawB64}` | net.* | net.* | `{messageId, queueId?, size, pipelining, capabilities[], recipients:[{address, code, accepted, detail}]}` — see below |
| `mime.build` | `{message}` | — (pure) | — | `{rawB64, size, messageId, boundaryMixed?, boundaryAlt?}` |

### `smtp.send` (M3)

TLS from the account's SMTP transport (D13): `smtp_host`/`smtp_port` from
the account (falling back to the IMAP host with `imap.`→`smtp.` and port
465); the transport is `smtp_socket_type` (`"tls"` implicit — handshake on
connect — or `"starttls"`), falling back to the legacy `tls` flag. One
transaction:

`EHLO` (HELO fallback on 5xx) → **[STARTTLS transport only: require
`STARTTLS`, send it, `220` → `net.upgrade` → re-`EHLO`]** → `AUTH PLAIN`
(or `AUTH LOGIN`, chosen by `account.auth`, with mechanism fallback when
the preference is not advertised; no password → no AUTH) → `MAIL FROM` →
one `RCPT TO` per envelope recipient → `DATA` (dot-stuffed,
CRLF-normalized) → final `250` → `QUIT`. `PIPELINING` is detected and
reported but the v1 client does not pipeline commands (safe under both
server settings). A STARTTLS account with a server that does not advertise
`STARTTLS` (or refuses `EHLO`) fails at `where:"starttls"` (`-6`/`-5`) —
there is no plaintext-auth fallback. The capability set is re-read after
the upgrade.

**Reply-code → error map** — every SMTP failure surfaces as
`{code, where, detail}` with `detail = "SMTP <code> [<enhanced>] <text>"`:

| where | trigger | ABI code |
|-------|---------|----------|
| `greeting` | first reply is not 220 | -5 host |
| `ehlo` | EHLO/HELO both rejected | -5 host |
| `starttls` | STARTTLS not advertised (starttls transport) | -6 unsupported |
| `starttls` | STARTTLS refused, EHLO refused, or the upgrade handshake failed | -5 host |
| `auth` | 5xx on AUTH (e.g. 535 credentials) | -5 host |
| `auth` | no advertised mechanism the client supports | -6 unsupported |
| `auth` | protocol surprise (e.g. 334 after PLAIN initial-response) | -4 protocol |
| `mail-from` | 5xx on MAIL FROM (550 relaying denied, 552 size) | -5 host |
| `rcpt` | every RCPT rejected — detail lists `addr -> code text` per recipient | -5 host |
| `data` | non-354 after DATA, 5xx final reply (552 size) | -5 host |
| `data` | message exceeds the advertised `SIZE` cap — checked **before** DATA | -5 host |
| `net` | transport error / server disconnect (e.g. mid-DATA hangup) | -5 / -4 |

**Partial RCPT success**: accepted recipients proceed to DATA; the
result's `recipients[]` carries every per-recipient code (`550` etc.) so
callers can report rejects without failing the send. `queueId` is
captured from common final-reply forms (`"queued as X"`, `"id=X"`).

### `mime.build` (M3, pure)

Assembles an RFC 5322 message from `message`:

```jsonc
{
  "from": {"name"?,"address"}, "to": [{"name"?,"address"}], "cc"?: [], "bcc"?: [],
  "subject"?, "text"?, "html"?,
  "attachments"?: [{"filename","contentType"?, "dataB64"}],
  "date"?: "<RFC5322>",            // default: host clock, always +0000 (UTC)
  "messageId"?: "<...>",           // default: generated from now_ms + random_bytes
  "inReplyTo"?: "<...>", "references"?: "<...>",   // drafts restore a chain directly
  "replyTo"?:   {subject, from, date, messageId, references?, bodyText},   // reply chain
  "forwardTo"?: {subject, from, to, date, bodyText}                        // forward chain
}
```

Encoding choices: bodies are **7bit when plain ASCII, quoted-printable
otherwise** (soft wraps at 76 columns); attachments are **base64** with
76-column lines and RFC 2231 `filename*`/`name*` params for non-ASCII
(quoted strings for ASCII); header values with non-ASCII become RFC 2047
`=?UTF-8?B?…?=` words (split at word boundaries; CR/LF stripped — header
injection cannot ride along). Structure: `multipart/mixed` wraps
`multipart/alternative` (text+html) whenever attachments exist;
alternative alone for text+html; a single part otherwise. Boundaries
derive from the Message-ID, so builds are deterministic for identical
inputs.

`replyTo` sets `Subject: Re:` (idempotent — never `Re: Re:`),
`In-Reply-To`, and `References` (original references + original id,
deduped), and quotes the original body with `>` prefixes beneath an
`On <date>, <who> wrote:` attribution. `forwardTo` sets `Fwd:` and a
`---------- Forwarded message ----------` header block, no In-Reply-To
(forwards do not thread).

### `account.autodiscover` (M2)

The strategy chain runs in rank order; every candidate is D5/D13-filtered
(implicit TLS `socketType SSL/TLS` **or** STARTTLS `socketType STARTTLS` —
canonical 993/465 and 143/587, a missing socketType inferred from the
canonical port only — plus password auth `plain`/`login`; plaintext and
OAuth offers are discarded), then ranked
**provider > ispdb > mx > probe** and deduped by endpoint pair
(first/best-rank wins). Each endpoint carries its own `socket_type` because
providers mix transports:

| strategy | source | effects | notes |
|----------|--------|---------|-------|
| built-in provider table | `provider` (rank 1) | — | offline data table (gmail/yahoo/fastmail/gmx/mail.com ...). Under D13 the SMTP-only-STARTTLS rows are viable: Outlook/Live (IMAP 993 SSL + SMTP 587 STARTTLS, password auth over STARTTLS) and iCloud (IMAP 993 SSL + SMTP 587 STARTTLS) yield candidates. |
| Thunderbird ISPDB | `ispdb` (rank 2) | `http.fetch {url: <ispdbBase><domain>}` | base defaults to `https://autoconfig.thunderbird.net/v1.1/`; `ispdbBase` overrides it (hosts/tests/mirrors, plain `http://` allowed), `""` skips the strategy. XML is parsed in core (namespace/CDATA/entity/garbage-tolerant subset parser). 404/410 → `state:"not-found"`; transport failure → `state:"error"` — both non-fatal. |
| DNS MX heuristic | `mx` (rank 3) | `dns.lookup {lookup:"mx", name:<domain>}` | derives `imap.<domain>`/`smtp.<domain>` + `mail.<domain>` pairs when records exist, each in implicit-TLS (993/465) and STARTTLS (143/587) form (D13); a null MX (RFC 7505, exchange `"."`) derives nothing; `{unsupported:true}` feeds (browser host, `dns.disabled`) → `state:"unsupported"`, never an error. |
| capability probes | `probe` (rank 4) | `net.*` | **off by default**; `probe:true` verifies presented candidates with a real IMAP handshake (greeting → CAPABILITY → [STARTTLS → net.upgrade → re-CAPABILITY] → LOGOUT, reusing the IMAP session machinery) and, when no other strategy found anything, adds common-name guesses (`imap.<domain>`, `mail.<domain>`) to verify. Each candidate gets `probe: "accepted" \| "refused" \| "timeout"` (+ `capabilities` when accepted); capped at 6 probes. `timeout` reflects the host's connect-phase timeout; a stall after handshake falls back to the drive's `timeoutMs`. SMTP is not probed (M3). |

```jsonc
// result shape
{
  "address": "alice@gmail.com", "domain": "gmail.com", "probe": false,
  "candidates": [
    { "imap": {"host":"imap.gmail.com","port":993,"socket_type":"tls"},
      "smtp": {"host":"smtp.gmail.com","port":465,"socket_type":"tls"},
      "auth": "plain", "user": "alice@gmail.com",
      "source": "provider", "rank": 1
      // Outlook/iCloud mix transports: imap socket_type "tls" (993),
      // smtp socket_type "starttls" (587).
      // with probe:true: "probe": "accepted", "capabilities": ["IMAP4rev1", ...]
    }
  ],
  "strategies": [
    {"name":"provider","state":"ok","found":1,"rejected":0},
    {"name":"ispdb","state":"ok","found":1,"rejected":0},   // ok|not-found|error|skipped
    {"name":"mx","state":"ok","found":2,"mxCount":1},       // ok|null-mx|unsupported|error
    {"name":"probe","state":"ok","found":2}                 // ok|skipped
  ]
}
```

Invalid addresses are rejected by `op_start` (`-1`) before any effect.
`setup_source` on persisted accounts carries the chosen candidate's
`source` (schema v2, see below).

### Named queries (`store.query`)

The CLI and hosts never invent SQL — they pick a query by name:

| query | args | statement |
|-------|------|-----------|
| `schema` | — | applies **schema v4**: the versioned DDL (incl. fts5, drafts, sent_messages), then the core-owned migrations on older files — v1-era: `ALTER TABLE accounts ADD COLUMN setup_source` (v2), `ADD smtp_host/smtp_port` (v3) and `ADD socket_type/smtp_socket_type` (v4); v2-era: smtp + transport columns; v3-era: the transport columns only — then `PRAGMA user_version = 4`; all as one op, idempotent |
| `accounts` | — | registry rows (incl. `setup_source`, `smtp_host`, `smtp_port`, `socket_type`, `smtp_socket_type`) |
| `folders` | `account` | folder rows incl. `uidvalidity`, `last_seen_uid` |
| `folder_meta` | `account, folder` | one folder's sync metadata |
| `messages` | `account, folder, limit?, unread?` | list columns, newest first |
| `message` | `account, folder, uid` | one full row (bodies + raw) |
| `search` | `q, limit?` | FTS5 match over subject/from/body_text (terms are quoted, so user input cannot inject FTS syntax) |
| `drafts` | `account, limit?, status?` | draft list rows (newest `updated_at` first) |
| `draft` | `account, id` | one full draft |
| `draft_save` | `account, id?, subject, fromaddr, toaddrs, ccaddrs, bccaddrs, body_text, body_html, attachments, in_reply_to?, references_hdr?, now` | INSERT (no `id`) or UPDATE; `insertId` = new draft id |
| `draft_mark_sent` | `account, id, message_id, sent_at, sent_folder, sent_uid` | flip `status='sent'` with the delivery record |
| `draft_delete` | `account, id` | delete a draft |
| `sent_audit` | `account, message_id, envelope, subject, size, queue_id?, appended, sent_folder?, sent_uid?, sent_at` | audit row for one accepted send (the M3 send trail) |
| `sent_messages` | `account, limit?` | recent audit rows |

### Schema v3 (M3) + v4 (D13)

New tables in every store (the same DDL applies to registry and
per-account files):

- **`drafts`** — composed-but-unsent messages: recipients as JSON arrays,
  `body_text`/`body_html`, `attachments` JSON, the reply chain
  (`in_reply_to`, `references_hdr`), `status` (`draft`|`sent`), and the
  delivery record (`message_id`, `sent_at`, `sent_folder`, `sent_uid`).
- **`sent_messages`** — the audit trail: one row per server-accepted
  send with the envelope JSON, server queue id, size, and whether the
  copy made it into a Sent folder (`appended` 0/1 — a failed/absent
  APPEND never un-sends and is recorded, not hidden).
- **`accounts.smtp_host`, `accounts.smtp_port`** — the SMTP endpoint
  (autodiscover persists it; the core falls back to `imap.x`→`smtp.x`
  on 465 when NULL).
- **`accounts.socket_type`, `accounts.smtp_socket_type`** (v4, D13) — the
  per-endpoint transport (`'tls'` implicit | `'starttls'`); NULL means the
  legacy `tls` boolean applies. Separate IMAP/SMTP columns because
  providers mix them (Outlook: IMAP `tls`, SMTP `starttls`). Plaintext is
  never a valid value.

### Sent-folder detection (host flow)

The send flow (`send`/`reply`/`forward`/`draft send`) has one
implementation — `packages/flows/src/send.ts`, driver-shaped so every host
runs the same code — executing `mime.build` → `smtp.send` → `imap.folders`
→ `imap.append` → `sent_audit`. Detection order against the LIST results:

| priority | rule | examples matched |
|----------|------|------------------|
| 1 | special-use `\Sent` flag | `\Sent` on any path |
| 2 | last path segment ∈ {sent, sent mail, sent items, sent messages, sent boxes} (case-insensitive; delimiter-aware) | `Sent`, `INBOX.Sent Items`, `[Gmail]/Sent Mail` |
| 3 | no match → send still succeeds, audit row `appended=0` with a note | localized names (`Envoyés`, `Gesendet`, …) are a documented limitation |

No Sent folder or a refused APPEND **never fails the send**: the message
was accepted by SMTP; the flow reports `not appended to Sent: <reason>
(recorded in sent_messages)`.

The audit row belongs to the flow, not to `smtp.send` — it carries the
append outcome (`appended`, `sent_folder`, `sent_uid`), which the raw op
cannot know. The CLI and the browser app both run the flow (D15/D16).

## Effect kinds (core → host)

All effects: `{id?: number, kind: "...", ...}`; drain in order.

| kind | payload | host duty | feed back |
|------|---------|-----------|-----------|
| `net.open` | `transport, host, port, tls` | TCP connect (TLS handshake on connect if `tls` — implicit TLS) | `net.opened`/`net.error` `{transport, ...}` |
| `net.upgrade` | `transport` | TLS upgrade on an **existing** plaintext transport (STARTTLS, D13); host SNI/self-signed/timeout rules apply | `net.upgraded` on success, `net.error` on failure (transport forgotten) |
| `net.write` | `transport, b64` | write bytes | — |
| `net.close` | `transport` | close | — |
| `dns.lookup` | `id, lookup` (e.g. `mx`), `name` | resolve | `dns.result` `{id, records}` or `{id, unsupported:true}` or `{id, error}` (e.g. NXDOMAIN — callers treat all three as non-fatal) |
| `http.fetch` | `id, url` | GET | `http.result` `{id, status, body}` or `{id, status, error}` / `{id, error}` (transport failure) |
| `store.exec` | `id, store, sql, params` | run on the SQLite store | `store.result` `{id, rows, changes, insertId}` or `{id, error:{code,where,detail}}` |
| `log` | `level, msg` | print/append | — |

`store` names: `"registry"` (account registry) or `"account:<id>"`
(per-account mailbox file); the host maps names to file paths.

## Feed kinds (host → core)

| kind | payload | routes by |
|------|---------|-----------|
| `net.opened` | `transport` | `transport` |
| `net.upgraded` | `transport` | `transport` |
| `net.error` | `transport, error` | `transport` |
| `net.data` | `transport, b64` | `transport` |
| `net.eof` | `transport` | `transport` |
| `store.result` | `id, rows?, changes?, insertId?, error?` | `id` |
| `dns.result` | `id, records? , unsupported?, error?` | `id` |
| `http.result` | `id, status?, body?, error?` (error is a host-side string) | `id` |
| `echo.data` | `id, echo` | `id` (op id) |

The core parses protocol bytes incrementally; hosts never parse protocols.
Hosts may reject any effect (read-only store → `{id, error}`); the core
treats every feed as fallible.

## Error codes (stable, negative)

| code | name | meaning |
|------|------|---------|
| -1 | invalid-arg | malformed or missing argument |
| -2 | not-found | unknown op id / account id |
| -3 | state | wrong lifecycle state (e.g. op before init, double cancel) |
| -4 | protocol | protocol violation (per-op, via handlers) |
| -5 | host | host-side failure (feed back with error) |
| -6 | unsupported | unknown op kind / feature |
| -7 | cancelled | op was cancelled |

Errors always travel as `{code, name, where, detail}` inside
`op_status` — never as bare numbers.

## Building and testing

```bash
node scripts/build.ts     # asc -> dist/{core.wasm, core.js, core.d.ts, probes.*}
node --test test/*.test.mjs
npm run lint              # tsc --noEmit (scripts) + asc --noEmit (AS sources)
```

`dist/probes.wasm` compiles the same core sources into diagnostic exports
(json/base64/ports probes) used by the tests; it is never shipped. The AS
sources use no exceptions (AS 0.28 has none) and no std JSON (also absent) —
`src/json/` and `src/encoding/base64.ts` are hand-rolled and oracle-tested
against Node.
