// MIME encoding primitives for outbound messages (M3): quoted-printable
// (RFC 2045), RFC 2047 encoded-words (B encoding), RFC 2231 parameter
// values, RFC 5322 Date formatting, Message-ID generation, and address
// header formatting. All pure — no I/O, no host ports except the caller
// supplying time/random bytes for identifiers.

import { b64Encode } from "../encoding/base64.ts";
import { now_ms, random_bytes } from "../runtime/ports.ts";
import { Json } from "../json/value.ts";

// -- UTF-8 ------------------------------------------------------------------

/** UTF-8 bytes of a string (bodies/headers are built from real text). */
export function utf8(s: string): Uint8Array {
  return Uint8Array.wrap(String.UTF8.encode(s));
}

// -- quoted-printable (RFC 2045) --------------------------------------------

function hex2(b: i32): string {
  const hex = "0123456789ABCDEF";
  return hex.charAt(b >> 4) + hex.charAt(b & 15);
}

/**
 * QP-encode text: input is a real string (may contain non-ASCII); it is
 * UTF-8 encoded first, then per RFC 2045 — bytes 33-60/62-126 literal,
 * tab/space literal except at line end, everything else =XX, soft line
 * breaks at <= 76 columns. Input lines are split on CRLF/LF/CR.
 */
export function qpEncodeText(text: string): string {
  const bytes = utf8(text);
  // split into lines on any CR/LF combination
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b == 13 || b == 10) {
      lines.push(bytesToAscii(bytes, start, i));
      if (b == 13 && i + 1 < bytes.length && bytes[i + 1] == 10) i++;
      start = i + 1;
    }
    i++;
  }
  lines.push(bytesToAscii(bytes, start, bytes.length));

  const out: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let col = 0;
    let i2 = 0;
    while (i2 < line.length) {
      const c = line.charCodeAt(i2);
      const last = i2 == line.length - 1;
      let token: string;
      if (c == 61) token = "=3D";
      else if (c == 9 && !last) token = "\t";
      else if (c == 32 && !last) token = " ";
      else if (c >= 33 && c <= 126) token = line.charAt(i2);
      else token = "=" + hex2(c);
      // wrap so that the line + the soft-break "=" stays <= 76 columns
      if (col + token.length > 75) {
        out.push("=\r\n");
        col = 0;
      }
      out.push(token);
      col += token.length;
      i2++;
    }
    if (li + 1 < lines.length) {
      out.push("\r\n");
      col = 0;
    }
  }
  return out.join("");
}

/** Byte-per-char ASCII string of [from,to) — input to qpEncodeText lines. */
function bytesToAscii(bytes: Uint8Array, from: i32, to: i32): string {
  const codes: i32[] = new Array<i32>(to > from ? to - from : 0);
  for (let i = from; i < to; i++) codes[i - from] = bytes[i];
  return String.fromCharCodes(codes);
}

// -- base64 bodies (attachments) --------------------------------------------

/** Base64-encode bytes with CRLF line breaks every 76 columns. */
export function base64Wrapped(bytes: Uint8Array): string {
  const raw = b64Encode(bytes);
  if (raw.length <= 76) return raw;
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    let end = i + 76;
    if (end > raw.length) end = raw.length;
    out.push(raw.substring(i, end));
    i = end;
  }
  return out.join("\r\n");
}

// -- RFC 2047 encoded-words --------------------------------------------------

/** True when the string needs an encoded-word (any char outside printable ASCII). */
export function needsEncodedWord(s: string): bool {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126) return true;
  }
  return false;
}

/**
 * RFC 2047 B-encode a header value when it contains non-ASCII (or control)
 * characters; ASCII-safe values pass through. Long values are split into
 * multiple <= 75-char encoded-words at character boundaries (whitespace
 * between adjacent encoded-words is dropped by decoders, per RFC 2047).
 * CR/LF are stripped — header injection cannot ride along.
 */
export function encodeHeaderWord(s: string): string {
  let clean = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c != 13 && c != 10) clean += s.charAt(i);
  }
  if (!needsEncodedWord(clean)) return clean;
  // Greedily build words: "=?UTF-8?B?" (10) + b64 + "?=" (2) <= 75.
  const words: string[] = [];
  let chunk = "";
  let i = 0;
  while (i < clean.length) {
    const candidate = chunk + clean.charAt(i);
    const b64Len = 4 * ((utf8(candidate).length + 2) / 3 | 0);
    if (chunk.length > 0 && 10 + b64Len + 2 > 75) {
      words.push("=?UTF-8?B?" + b64Encode(utf8(chunk)) + "?=");
      chunk = "";
      continue;
    }
    chunk = candidate;
    i++;
  }
  if (chunk.length > 0) words.push("=?UTF-8?B?" + b64Encode(utf8(chunk)) + "?=");
  return words.join("\r\n ");
}

// -- RFC 2231 parameter values -----------------------------------------------

/** RFC 2231 attr-char: ASCII letters/digits and these symbols stay literal. */
function isAttrChar(c: i32): bool {
  if (c >= 48 && c <= 57) return true;
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  return c == 33 || c == 35 || c == 36 || c == 37 || c == 38 || c == 43 ||
    c == 45 || c == 46 || c == 94 || c == 95 || c == 96 || c == 124 || c == 126;
}

/**
 * RFC 2231 value: ASCII-only values stay a quoted string, non-ASCII values
 * become `name*=UTF-8''pct-encoded`. Returns the full `name=...` fragment.
 */
export function rfc2231Param(name: string, value: string): string {
  if (!needsEncodedWord(value)) {
    let escaped = "";
    for (let i = 0; i < value.length; i++) {
      const c = value.charAt(i);
      escaped += (c == "\"" || c == "\\") ? "\\" + c : c;
    }
    return name + "=\"" + escaped + "\"";
  }
  const bytes = utf8(value);
  let pct = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    pct += isAttrChar(b) ? String.fromCharCode(b) : "%" + hex2(b);
  }
  return name + "*=UTF-8''" + pct;
}

// -- RFC 5322 Date -----------------------------------------------------------

const DOW: string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON: string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: i32): string {
  return n < 10 ? "0" + n.toString() : n.toString();
}

/** Civil date from days since epoch (Howard Hinnant's inverse algorithm). */
function civilFromDays(z: i64): i32[] {
  const z2 = z + 719468;
  const era: i64 = (z2 >= 0 ? z2 : z2 - 146096) / 146097;
  const doe: i64 = z2 - era * 146097;
  const yoe: i64 = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const y: i64 = yoe + era * 400;
  const doy: i64 = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const mp: i64 = (5 * doy + 2) / 153;
  const d: i64 = doy - (153 * mp + 2) / 5 + 1;
  const m: i64 = mp < 10 ? mp + 3 : mp - 9;
  const year: i32 = <i32>(m <= 2 ? y + 1 : y);
  return [year, <i32>m, <i32>d];
}

/**
 * RFC 5322 Date header in UTC ("Thu, 16 Oct 2026 12:00:00 +0000"). The core
 * has no timezone database — UTC is always emitted; hosts that care can
 * pass an explicit `date`. NaN input falls back to the host clock.
 */
export function formatRfc5322(ms: f64): string {
  if (isNaN(ms)) ms = now_ms();
  const secs = <i64>Math.floor(ms / 1000.0);
  const days = secs >= 0 ? secs / 86400 : (secs - 86399) / 86400; // floor div
  const rem = secs - days * 86400;
  const civil = civilFromDays(days);
  // 1970-01-01 was a Thursday: weekday index (0=Sun) is (days + 4) % 7,
  // computed positively for pre-epoch inputs too.
  const dowName = DOW[((<i32>days % 7) + 11) % 7];
  const hh = <i32>(rem / 3600);
  const mm = <i32>((rem % 3600) / 60);
  const ss = <i32>(rem % 60);
  return (
    dowName + ", " + pad2(civil[2]) + " " + MON[civil[1] - 1] + " " + civil[0].toString() + " " +
    pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss) + " +0000"
  );
}

// -- Message-ID --------------------------------------------------------------

function hexOf(bytes: Uint8Array): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += hex.charAt(bytes[i] >> 4);
    out += hex.charAt(bytes[i] & 15);
  }
  return out;
}

/**
 * Generate "<time.random@domain>" from the host clock and random port.
 * `domain` should be the sender's address domain (fallback "localhost").
 */
export function generateMessageId(domain: string): string {
  const ms = <i64>now_ms();
  const rand = new Uint8Array(8);
  random_bytes(rand.dataStart, 8);
  let host = domain;
  if (host.length == 0) host = "localhost";
  return "<" + ms.toString() + "." + hexOf(rand) + "@" + host + ">";
}

// -- address headers ---------------------------------------------------------

function needsQuotingName(name: string): bool {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c == 44 || c == 59 || c == 60 || c == 62 || c == 34 || c == 92 ||
      c == 40 || c == 41 || c == 64 || c == 58 || c == 32 || c < 32 || c > 126) {
      return true;
    }
  }
  return false;
}

/** Format one {name, address} as an address-header token. */
export function formatAddress(addr: Json): string {
  const address = addr.getString("address", "");
  const name = addr.getString("name", "");
  if (name.length == 0) return address;
  if (needsEncodedWord(name)) return encodeHeaderWord(name) + " <" + address + ">";
  if (needsQuotingName(name)) {
    let escaped = "";
    for (let i = 0; i < name.length; i++) {
      const c = name.charAt(i);
      escaped += (c == "\"" || c == "\\") ? "\\" + c : c;
    }
    return "\"" + escaped + "\" <" + address + ">";
  }
  return name + " <" + address + ">";
}

/** Format a list of addresses as a header value ("a, b <c@d>"). */
export function formatAddressList(addrs: Json): string {
  if (addrs.kind != 4) return ""; // KIND_ARR
  let out = "";
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs.at(i);
    if (a == null) continue;
    if (out.length > 0) out += ", ";
    out += formatAddress(a);
  }
  return out;
}
