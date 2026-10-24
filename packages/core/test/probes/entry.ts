// Diagnostic exports for core tests (compiled to dist/probes.wasm).
// Each probe exercises a real core module through the real wasm binary;
// test/*.test.mjs compares results against Node oracles. Not shipped.

import { parseJson } from "../../src/json/parse.ts";
import { stringifyJson } from "../../src/json/stringify.ts";
import { b64Encode, b64Decode } from "../../src/encoding/base64.ts";
import { decode_text, now_ms, random_bytes } from "../../src/runtime/ports.ts";
import { ResponseReader, unlatain } from "../../src/imap/reader.ts";
import { parseResponse, ImapEvent, EV_OTHER } from "../../src/imap/response.ts";
import { Json } from "../../src/json/value.ts";
import { parseMessage, headerBodySplit, splitMultipart } from "../../src/mime/parse.ts";
import { Headers, parseAddresses } from "../../src/mime/headers.ts";
import { qpDecodeBytes } from "../../src/mime/qp.ts";
import { parseImapDate } from "../../src/util/datetime.ts";
import { lookupProvider } from "../../src/autodiscover/providers.ts";
import {
  acceptTransport,
  dedupe,
  makeCandidate,
  mapAuthMethod,
} from "../../src/autodiscover/candidates.ts";
import { parseIspdbXml, serversToJson } from "../../src/autodiscover/xml.ts";
import { candidatesFromIspdb, substituteUsername } from "../../src/autodiscover/ispdb.ts";
import { deriveMxCandidates } from "../../src/autodiscover/mx.ts";
import { buildMessage, replySubject, forwardSubject, quoteBody, envelopeRecipients } from "../../src/mime/build.ts";
import {
  qpEncodeText,
  encodeHeaderWord,
  rfc2231Param,
  formatRfc5322,
  formatAddressList,
  base64Wrapped,
} from "../../src/mime/encode.ts";
import { SmtpReply, SmtpReplyReader } from "../../src/smtp/reply.ts";
import { dotStuff } from "../../src/smtp/session.ts";

function hexOf(bytes: Uint8Array): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += hex.charAt(bytes[i] >> 4);
    out += hex.charAt(bytes[i] & 15);
  }
  return out;
}

/** parseJson + stringifyJson; "INVALID" when the input is not valid JSON. */
export function probeJson(s: string): string {
  const v = parseJson(s);
  if (v == null) return "INVALID";
  return stringifyJson(v);
}

/** Extract one object field as canonical JSON; MISSING/INVALID markers. */
export function probeJsonField(s: string, key: string): string {
  const v = parseJson(s);
  if (v == null) return "INVALID";
  const f = v.get(key);
  if (f == null) return "MISSING";
  return stringifyJson(f);
}

/** Accessor probes: scalar field extraction with fallbacks. */
export function probeJsonString(s: string, key: string, fallback: string): string {
  const v = parseJson(s);
  if (v == null) return "INVALID";
  return v.getString(key, fallback);
}

export function probeJsonInt(s: string, key: string, fallback: i32): i32 {
  const v = parseJson(s);
  if (v == null) return fallback;
  return v.getInt(key, fallback);
}

/** base64-encode the UTF-8 bytes of the input string. */
export function probeB64Encode(s: string): string {
  const bytes = Uint8Array.wrap(String.UTF8.encode(s));
  return b64Encode(bytes);
}

/** base64-decode to hex; "INVALID" on malformed input. */
export function probeB64Decode(s: string): string {
  const out = b64Decode(s);
  if (out == null) return "INVALID";
  return hexOf(out);
}

/** host decode_text port: base64 bytes + charset -> string. */
export function probeDecodeText(b64: string, charset: string): string {
  const bytes = b64Decode(b64);
  if (bytes == null) return "INVALID-B64";
  return decode_text(bytes.dataStart, bytes.length, charset);
}

/** host now_ms port. */
export function probeNow(): f64 {
  return now_ms();
}

/** host random_bytes port as hex. */
export function probeRandom(n: i32): string {
  if (n <= 0) return "";
  const b = new Uint8Array(n);
  random_bytes(b.dataStart, <u32>n);
  return hexOf(b);
}

// ---- IMAP parser probes -------------------------------------------------

function eventJson(ev: ImapEvent): Json {
  const j = Json.emptyObj();
  j.setInt("kind", <i64>ev.kind);
  j.setStr("tag", ev.tag);
  j.setStr("status", ev.status);
  j.setStr("code", ev.code);
  j.setStr("text", ev.text);
  j.setNum("num", ev.num);
  const caps = Json.emptyArr();
  for (let i = 0; i < ev.capabilities.length; i++) caps.push(Json.ofStr(ev.capabilities[i]));
  j.set("capabilities", caps);
  j.setStr("mailbox", ev.mailbox);
  j.setStr("delimiter", ev.delimiter);
  const flags = Json.emptyArr();
  for (let i = 0; i < ev.flags.length; i++) flags.push(Json.ofStr(ev.flags[i]));
  j.set("flags", flags);
  j.setInt("uid", ev.uid);
  j.setStr("internalDate", ev.internalDate);
  j.setInt("size", ev.size);
  j.set("envelope", ev.envelope != null ? ev.envelope! : Json.nil());
  if (ev.raw != null) j.setStr("rawB64", b64Encode(ev.raw!));
  return j;
}

function runTranscript(bytes: Uint8Array, chunkSize: i32): string {
  const reader = new ResponseReader();
  const out = Json.emptyArr();
  let offset = 0;
  const size = chunkSize > 0 ? chunkSize : bytes.length;
  while (offset < bytes.length) {
    let take = size;
    if (offset + take > bytes.length) take = bytes.length - offset;
    reader.feed(bytes.subarray(offset, offset + take));
    offset += take;
    for (;;) {
      const resp = reader.next();
      if (resp == null) break;
      out.push(eventJson(parseResponse(resp)));
    }
  }
  // flush any pending complete response after the last feed
  for (;;) {
    const resp = reader.next();
    if (resp == null) break;
    out.push(eventJson(parseResponse(resp)));
  }
  return stringifyJson(out);
}

/** Parse a transcript fed in one shot. */
export function probeParseTranscript(b64: string): string {
  const bytes = b64Decode(b64);
  if (bytes == null) return "INVALID";
  return runTranscript(bytes, 0);
}

/** Parse a transcript fed in fixed-size chunks (boundary fuzz). */
export function probeParseChunked(b64: string, chunkSize: i32): string {
  const bytes = b64Decode(b64);
  if (bytes == null) return "INVALID";
  return runTranscript(bytes, chunkSize);
}

// ---- MIME probes --------------------------------------------------------

/** Parse a raw message: text/html/attachments/structure/thread/headers. */
export function probeMime(raw: string): string {
  const msg = parseMessage(raw);
  const out = Json.emptyObj();
  out.setStr("subject", msg.headers.getOr("subject", ""));
  out.set("from", parseAddresses(msg.headers.getOr("from", "")));
  out.set("to", parseAddresses(msg.headers.getOr("to", "")));
  out.set("cc", parseAddresses(msg.headers.getOr("cc", "")));
  out.setStr("bodyText", msg.bodyText);
  out.setStr("bodyHtml", msg.bodyHtml);
  out.set("attachments", msg.attachments);
  out.set("structure", msg.structure);
  out.setStr("threadKey", msg.threadKey);
  out.set("headers", msg.headersJson);
  return stringifyJson(out);
}

/** Unfold + fetch one header value (encoded-words decoded). */
export function probeHeader(block: string, name: string): string {
  const h = Headers.parse(block);
  const v = h.get(name);
  return v == null ? "NULL" : v;
}

/** Header address list -> [{name,address}]. */
export function probeAddresses(value: string): string {
  return stringifyJson(parseAddresses(value));
}

/** Quoted-printable decode to hex. */
export function probeQpDecode(s: string): string {
  return hexOf(qpDecodeBytes(s));
}

/** INTERNALDATE -> epoch ms (NaN serializes as null). */
export function probeDate(s: string): f64 {
  return parseImapDate(s);
}

/** header/body split check. */
export function probeHeaderBodySplit(raw: string): string {
  const hb = headerBodySplit(raw);
  const out = Json.emptyObj();
  out.setStr("headers", hb.headers);
  out.setStr("body", hb.body);
  return stringifyJson(out);
}

/** multipart boundary split: number of parts + joined sizes. */
export function probeSplitMultipart(body: string, boundary: string): string {
  const parts = splitMultipart(body, boundary);
  if (parts == null) return "NULL";
  const out = Json.emptyArr();
  for (let i = 0; i < parts.length; i++) out.push(Json.ofInt(parts[i].length));
  return stringifyJson(out);
}

// ---- autodiscover probes (M2) ---------------------------------------------

/** Provider-table lookup: {candidates, rejected}. */
export function probeProvider(domain: string, address: string): string {
  const r = lookupProvider(domain, address);
  const out = Json.emptyObj();
  out.set("candidates", r.candidates);
  out.setInt("rejected", <i64>r.rejected);
  return stringifyJson(out);
}

/** D5 filter on one IMAP+SMTP offer pair: candidate JSON or "NULL". */
export function probeD5Pair(
  imapHost: string,
  imapPort: i32,
  imapSocket: string,
  smtpHost: string,
  smtpPort: i32,
  smtpSocket: string,
  authValue: string,
  address: string,
  source: string,
): string {
  const c = makeCandidate(address, imapHost, imapPort, imapSocket, smtpHost, smtpPort, smtpSocket, authValue, "", source);
  return c == null ? "NULL" : stringifyJson(c);
}

/** ISPDB/table auth-method mapping ("plain" | "login" | "" = rejected). */
export function probeAuthMap(value: string): string {
  return mapAuthMethod(value);
}

/** D13 transport filter: "tls" | "starttls" | "" (rejected). */
export function probeAcceptTransport(socketType: string, port: i32, imap: bool): string {
  return acceptTransport(socketType, port, imap);
}

/** Dedupe an endpoint-pair list, preserving first/best-rank occurrence. */
export function probeDedupe(listJson: string): string {
  const v = parseJson(listJson);
  if (v == null) return "INVALID";
  return stringifyJson(dedupe(v));
}

/** Parse ISPDB XML -> {servers, candidates, rejected} (full strategy 2). */
export function probeIspdbXml(xml: string, address: string, domain: string): string {
  const servers = parseIspdbXml(xml);
  const r = candidatesFromIspdb(servers, address, domain);
  const out = Json.emptyObj();
  out.set("servers", serversToJson(servers));
  out.set("candidates", r.candidates);
  out.setInt("rejected", <i64>r.rejected);
  return stringifyJson(out);
}

/** MX derivation (strategy 3): records JSON -> {candidates, mxCount, nullMx}. */
export function probeMxDerive(domain: string, address: string, recordsJson: string): string {
  let records: Json | null = null;
  if (recordsJson.length > 0) records = parseJson(recordsJson);
  const r = deriveMxCandidates(address, domain, records);
  const out = Json.emptyObj();
  out.set("candidates", r.candidates);
  out.setInt("mxCount", <i64>r.mxCount);
  out.setBool("nullMx", r.nullMx);
  return stringifyJson(out);
}

/** ISPDB username template substitution. */
export function probeUsernameSubst(template: string, address: string, domain: string): string {
  return substituteUsername(template, address, domain);
}

// ---- MIME build probes (M3) ------------------------------------------------

/**
 * Build a raw message from JSON; returns the raw text or "ERR: <why>".
 * Date/Message-ID are pinned via the args so tests are deterministic.
 */
export function probeMimeBuild(messageJson: string): string {
  const msg = parseJson(messageJson);
  if (msg == null) return "ERR: invalid JSON";
  const plan = buildMessage(msg);
  if (!plan.ok) return "ERR: " + plan.error;
  return plan.raw;
}

/** QP-encode text (input is real UTF-8 text). */
export function probeQpEncode(s: string): string {
  return qpEncodeText(s);
}

/** RFC 2047 header word encoding. */
export function probeEncodeHeaderWord(s: string): string {
  return encodeHeaderWord(s);
}

/** RFC 2231 parameter fragment. */
export function probeRfc2231(name: string, value: string): string {
  return rfc2231Param(name, value);
}

/** RFC 5322 Date header from epoch ms. */
export function probeFormatDate(ms: f64): string {
  return formatRfc5322(ms);
}

/** Address list formatting. */
export function probeFormatAddresses(listJson: string): string {
  const v = parseJson(listJson);
  if (v == null) return "INVALID";
  return formatAddressList(v);
}

/** base64 with 76-column CRLF wrapping. */
export function probeBase64Wrapped(b64: string): string {
  const bytes = b64Decode(b64);
  if (bytes == null) return "INVALID";
  return base64Wrapped(bytes);
}

/** Re:/Fwd: subject helpers (idempotency tests). */
export function probeReplySubject(subject: string): string {
  return replySubject(subject);
}

export function probeForwardSubject(subject: string): string {
  return forwardSubject(subject);
}

/** ">"-quote a reply body. */
export function probeQuoteBody(text: string): string {
  return quoteBody(text);
}

/** Envelope recipients from a message JSON (to+cc+bcc deduped). */
export function probeEnvelopeRecipients(messageJson: string): string {
  const v = parseJson(messageJson);
  if (v == null) return "INVALID";
  return stringifyJson(Json.ofStr(envelopeRecipients(v).join(",")));
}

// ---- SMTP probes (M3) ------------------------------------------------------

function replyJson(r: SmtpReply): Json {
  const j = Json.emptyObj();
  j.setInt("code", <i64>r.code);
  j.setStr("text", r.text);
  j.setStr("enhanced", r.enhanced);
  return j;
}

/** Parse an SMTP transcript (fed in `chunkSize` chunks) -> replies JSON. */
export function probeSmtpTranscript(b64: string, chunkSize: i32): string {
  const bytes = b64Decode(b64);
  if (bytes == null) return "INVALID";
  const reader = new SmtpReplyReader();
  const out = Json.emptyArr();
  let offset = 0;
  const size = chunkSize > 0 ? chunkSize : bytes.length;
  while (offset < bytes.length) {
    let take = size;
    if (offset + take > bytes.length) take = bytes.length - offset;
    reader.feed(bytes.subarray(offset, offset + take));
    offset += take;
    for (;;) {
      const r = reader.next();
      if (r == null) break;
      out.push(replyJson(r));
    }
  }
  for (;;) {
    const r = reader.next();
    if (r == null) break;
    out.push(replyJson(r));
  }
  return stringifyJson(out);
}

/** Dot-stuffing + CRLF normalization for the DATA phase. */
export function probeDotStuff(raw: string): string {
  return dotStuff(raw);
}
