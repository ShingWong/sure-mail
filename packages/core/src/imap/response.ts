// IMAP response parser: tokens -> typed events. Pure machine — no I/O,
// no state beyond the input. One RawResponse produces exactly one event.

import { RawResponse } from "./reader.ts";
import { Token, Tokenizer, TOK_ATOM, TOK_EOF, TOK_LITERAL, TOK_LPAREN, TOK_RPAREN, TOK_STRING, strInt, strNum, tokenInt } from "./token.ts";
import { Json } from "../json/value.ts";

export const EV_OTHER: i8 = 0;
export const EV_SELECT: i8 = 1; // * OK (greeting or [UIDVALIDITY ...] etc.)
export const EV_TAGGED: i8 = 2;
export const EV_CONTINUATION: i8 = 3;
export const EV_BYE: i8 = 4;
export const EV_CAPABILITY: i8 = 5;
export const EV_LIST: i8 = 6;
export const EV_EXISTS: i8 = 7;
export const EV_RECENT: i8 = 8;
export const EV_FLAGS: i8 = 9;
export const EV_FETCH: i8 = 10;

export class ImapEvent {
  kind: i8 = EV_OTHER;
  tag: string = "";
  status: string = ""; // OK | NO | BAD | PREAUTH | BYE
  code: string = ""; // resp-text-code: UIDVALIDITY, READ-ONLY, ...
  text: string = "";
  num: f64 = 0; // sequence / UIDVALIDITY / EXISTS / RECENT number (f64: UIDVALIDITY is u32)
  capabilities: string[] = [];
  mailbox: string = "";
  delimiter: string = "";
  flags: string[] = [];
  uid: i32 = -1;
  internalDate: string = "";
  size: i32 = -1;
  envelope: Json | null = null;
  raw: Uint8Array | null = null; // BODY[] literal bytes
}

function upper(s: string): string {
  return s.toUpperCase();
}

function isNil(tok: Token): bool {
  return tok.kind == TOK_ATOM && tok.text == "NIL";
}

/** STRING/LITERAL/ATOM value as text, or null for NIL/EOF. */
function optString(tok: Token): string | null {
  if (tok.kind == TOK_EOF) return null;
  if (isNil(tok)) return null;
  if (tok.kind == TOK_STRING || tok.kind == TOK_LITERAL || tok.kind == TOK_ATOM) return tok.text;
  return null;
}

/** Skip a balanced paren group (cursor must sit just after the '('). */
function skipGroup(tok: Tokenizer): void {
  let depth = 1;
  for (;;) {
    const t = tok.next();
    if (t.kind == TOK_EOF) return;
    if (t.kind == TOK_LPAREN) depth++;
    else if (t.kind == TOK_RPAREN) {
      depth--;
      if (depth == 0) return;
    }
  }
}

export function parseResponse(resp: RawResponse): ImapEvent {
  const ev = new ImapEvent();
  const tok = new Tokenizer(resp);
  const first = tok.next();
  if (first.kind == TOK_EOF) return ev; // empty response: EV_OTHER
  if (first.text == "+") {
    ev.kind = EV_CONTINUATION;
    ev.text = restText(tok);
    return ev;
  }
  if (first.text != "*") {
    // tagged: <tag> <OK|NO|BAD> [code] text — anything else is not a
    // well-formed response (tolerated as EV_OTHER).
    const st = tok.peek();
    const status = st.kind == TOK_EOF ? "" : upper(st.text);
    if (status != "OK" && status != "NO" && status != "BAD") {
      ev.kind = EV_OTHER;
      ev.text = first.text;
      return ev;
    }
    ev.kind = EV_TAGGED;
    ev.tag = first.text;
    tok.next(); // consume status
    ev.status = status;
    parseStatusTail(tok, ev);
    return ev;
  }
  // untagged: * [number] type ...
  let type = tok.next();
  if (type.kind == TOK_ATOM && tokenInt(type, -1) >= 0 && type.text != "OK" && type.text != "BYE") {
    ev.num = strNum(type.text, 0);
    type = tok.next();
  }
  const name = upper(type.text);
  if (name == "OK" || name == "PREAUTH") {
    ev.kind = EV_SELECT;
    ev.status = name;
    parseStatusTail(tok, ev);
    return ev;
  }
  if (name == "BYE") {
    ev.kind = EV_BYE;
    ev.status = "BYE";
    ev.text = restText(tok);
    return ev;
  }
  if (name == "CAPABILITY") {
    ev.kind = EV_CAPABILITY;
    for (;;) {
      const t = tok.next();
      if (t.kind != TOK_ATOM && t.kind != TOK_STRING) break;
      ev.capabilities.push(t.text);
    }
    return ev;
  }
  if (name == "FLAGS") {
    ev.kind = EV_FLAGS;
    ev.flags = readParenList(tok);
    return ev;
  }
  if (name == "LIST" || name == "LSUB") {
    ev.kind = EV_LIST;
    const attrs = readParenList(tok); // \HasNoChildren etc.
    ev.flags = attrs;
    const delim = tok.next();
    if (delim.kind == TOK_ATOM && delim.text == "NIL") ev.delimiter = "";
    else ev.delimiter = delim.text;
    const box = tok.next();
    const boxText = optString(box);
    ev.mailbox = boxText == null ? "" : boxText;
    return ev;
  }
  if (name == "EXISTS") {
    ev.kind = EV_EXISTS;
    return ev;
  }
  if (name == "RECENT") {
    ev.kind = EV_RECENT;
    return ev;
  }
  if (name == "FETCH") {
    ev.kind = EV_FETCH;
    parseFetchItems(tok, ev);
    return ev;
  }
  ev.kind = EV_OTHER; // SEARCH, ENABLED, etc. — ignored by v1
  ev.text = restText(tok);
  return ev;
}

function restText(tok: Tokenizer): string {
  let out = "";
  for (;;) {
    const t = tok.next();
    if (t.kind == TOK_EOF) break;
    if (out.length > 0) out += " ";
    out += t.text;
  }
  return out;
}

/** Optional [CODE ...] bracket group + free text (tagged/OK/BYE lines). */
function parseStatusTail(tok: Tokenizer, ev: ImapEvent): void {
  const p = tok.peek();
  if (p.kind == TOK_ATOM && p.text.startsWith("[")) {
    const open = tok.next(); // "[CODE" or "[CODE]" or "["
    let code = open.text.substring(1); // strip '['
    let done = code.endsWith("]");
    if (done) code = code.substring(0, code.length - 1); // strip ']'
    if (code.length == 0) {
      const c = tok.next();
      if (c.kind == TOK_EOF) return;
      code = c.text;
      done = code.endsWith("]");
      if (done) code = code.substring(0, code.length - 1);
    }
    ev.code = upper(code);
    if (!done) {
      // Optional numeric code value: [UIDVALIDITY 123] — the number may
      // carry the closing bracket: [UIDVALIDITY 123].
      const v = tok.peek();
      if (v.kind == TOK_ATOM) {
        let numText = v.text;
        let closes = false;
        if (numText.endsWith("]")) {
          numText = numText.substring(0, numText.length - 1);
          closes = true;
        }
        const n = strNum(numText, -1);
        if (n >= 0) {
          ev.num = n;
          tok.next();
          done = closes;
        }
      }
      // [APPENDUID <uidvalidity> <uid>] — the second number is the new
      // UID (RFC 4315); stash it on ev.uid.
      if (ev.code == "APPENDUID" && !done) {
        const v2 = tok.peek();
        if (v2.kind == TOK_ATOM) {
          let numText2 = v2.text;
          let closes2 = false;
          if (numText2.endsWith("]")) {
            numText2 = numText2.substring(0, numText2.length - 1);
            closes2 = true;
          }
          const n2 = strNum(numText2, -1);
          if (n2 >= 0) {
            ev.uid = <i32>n2;
            tok.next();
            done = closes2;
          }
        }
      }
      if (!done) {
        // Skip the rest of the bracket group (parens-aware, e.g. CAPABILITY).
        let depth = 1;
        for (;;) {
          const t = tok.next();
          if (t.kind == TOK_EOF) return;
          if (t.kind == TOK_LPAREN) depth++;
          else if (t.kind == TOK_RPAREN) {
            depth--;
            if (depth == 0) break;
          } else if (t.text.endsWith("]") && depth == 1) {
            break;
          }
        }
      }
    }
  }
  ev.text = restText(tok);
}

/** Paren list of atoms/strings; cursor after '(' — used for FLAGS etc. */
function readParenList(tok: Tokenizer): string[] {
  const out: string[] = [];
  const p = tok.peek();
  if (p.kind == TOK_LPAREN) {
    tok.next();
    for (;;) {
      const t = tok.next();
      if (t.kind == TOK_RPAREN || t.kind == TOK_EOF) break;
      if (t.kind == TOK_LPAREN) {
        skipGroup(tok);
        continue;
      }
      out.push(t.text);
    }
  } else if (isNil(p)) {
    tok.next();
  }
  return out;
}

function parseFetchItems(tok: Tokenizer, ev: ImapEvent): void {
  const open = tok.next();
  if (open.kind != TOK_LPAREN) return;
  for (;;) {
    const t = tok.next();
    if (t.kind == TOK_RPAREN || t.kind == TOK_EOF) return;
    if (t.kind == TOK_LPAREN) {
      skipGroup(tok);
      continue;
    }
    if (t.kind != TOK_ATOM) continue;
    const key = upper(t.text);
    if (key == "UID") {
      ev.uid = tokenInt(tok.next(), -1);
    } else if (key == "FLAGS") {
      ev.flags = readParenList(tok);
    } else if (key == "INTERNALDATE") {
      const d = tok.next();
      ev.internalDate = d.text;
    } else if (key == "RFC822.SIZE" || key == "SIZE") {
      ev.size = tokenInt(tok.next(), -1);
    } else if (key == "ENVELOPE") {
      ev.envelope = parseEnvelope(tok);
    } else if (key.startsWith("BODY")) {
      const section = consumeSection(tok, t.text);
      const value = tok.next();
      if (section == "[]" || section == "[TEXT]") {
        if (value.kind == TOK_LITERAL) ev.raw = value.bytes;
        else if (value.kind == TOK_STRING) ev.raw = utf8ish(value.text);
      }
      // other sections (HEADER, MIME, partials) are skipped in v1
    } else {
      skipValue(tok);
    }
  }
}

/** utf-8-agnostic bytes for a quoted fallback (protocol text). */
function utf8ish(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = <u8>(s.charCodeAt(i) & 0xff);
  return out;
}

/**
 * Consume a BODY section designator starting in `head` (e.g. "BODY[]",
 * "BODY[HEADER.FIELDS", with the closing "]" possibly in a later token).
 * Returns the normalized section like "[]" or "[HEADER.FIELDS ...]".
 */
function consumeSection(tok: Tokenizer, head: string): string {
  let section = head;
  if (!section.endsWith("]")) {
    for (;;) {
      const t = tok.peek();
      if (t.kind == TOK_EOF) break;
      if (t.kind == TOK_RPAREN) break;
      tok.next();
      section += (t.kind == TOK_LPAREN ? "(" : t.kind == TOK_RPAREN ? ")" : " " + t.text);
      if (section.endsWith("]")) break;
    }
  }
  // normalize: BODY.PEEK[...] and BODY[...] -> the bracket part
  const idx = section.indexOf("[");
  return idx >= 0 ? section.substring(idx) : section;
}

function skipValue(tok: Tokenizer): void {
  const t = tok.next();
  if (t.kind == TOK_LPAREN) skipGroup(tok);
}

/** ENVELOPE: (date subject from sender reply-to to cc bcc in-reply-to message-id) */
function parseEnvelope(tok: Tokenizer): Json | null {
  const open = tok.next();
  if (open.kind != TOK_LPAREN) return null;
  const env = Json.emptyObj();
  env.set("date", jsonOptString(tok.next()));
  env.set("subject", jsonOptString(tok.next()));
  env.set("from", jsonAddrList(tok));
  env.set("sender", jsonAddrList(tok));
  env.set("replyTo", jsonAddrList(tok));
  env.set("to", jsonAddrList(tok));
  env.set("cc", jsonAddrList(tok));
  env.set("bcc", jsonAddrList(tok));
  env.set("inReplyTo", jsonOptString(tok.next()));
  env.set("messageId", jsonOptString(tok.next()));
  // Defensive: skip to the closing paren (servers may extend ENVELOPE).
  let guard = 0;
  while (!tok.atEnd() && guard++ < 64) {
    const t = tok.next();
    if (t.kind == TOK_RPAREN) break;
  }
  return env;
}

function jsonOptString(t: Token): Json {
  const s = optString(t);
  return s == null ? Json.nil() : Json.ofStr(s);
}

function jsonAddrList(tok: Tokenizer): Json {
  const out = Json.emptyArr();
  const p = tok.peek();
  if (isNil(p)) {
    tok.next();
    return out;
  }
  if (p.kind != TOK_LPAREN) return out;
  tok.next();
  for (;;) {
    const t = tok.next();
    if (t.kind == TOK_RPAREN || t.kind == TOK_EOF) break;
    if (t.kind != TOK_LPAREN) continue;
    // (name adl mailbox host)
    const name = optString(tok.next());
    tok.next(); // adl (unused)
    const mailbox = optString(tok.next());
    const host = optString(tok.next());
    let rparen = tok.next();
    while (rparen.kind != TOK_RPAREN && rparen.kind != TOK_EOF) rparen = tok.next();
    const addr = Json.emptyObj();
    addr.set("name", name == null ? Json.nil() : Json.ofStr(name));
    const mail = mailbox == null ? "" : mailbox;
    addr.set("address", Json.ofStr(host == null || host.length == 0 ? mail : mail + "@" + host));
    out.push(addr);
  }
  return out;
}
