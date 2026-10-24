// ISPDB strategy mapping: parsed server records -> D13 candidates.
// Pairing is index-wise (first imap with first smtp); the username may
// carry ISPDB templates (%EMAILADDRESS%, %EMAILLOCALPART%, %EMAILDOMAIN%)
// which resolve against the requested address. Both servers must offer a
// v1 password method — an OAuth-only SMTP endpoint makes the profile
// unsendable under D5/D13, so the pair is rejected, not half-presented.
// socketType SSL and STARTTLS are both accepted (STARTTLS documents are
// viable since D13).

import { Json } from "../json/value.ts";
import { makeCandidate, mapAuthMethod, SOURCE_ISPDB } from "./candidates.ts";
import { XmlServer } from "./xml.ts";

export class IspdbResult {
  candidates: Json = Json.emptyArr();
  rejected: i32 = 0;
}

function parsePort(text: string, fallback: i32): i32 {
  const t = text.trim();
  if (t.length == 0 || t.length > 5) return fallback;
  let v = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 48 || c > 57) return fallback;
    v = v * 10 + (c - 48);
  }
  return v > 0 ? v : fallback;
}

function replaceAll(s: string, from: string, to: string): string {
  if (from.length == 0) return s;
  let out = "";
  let i = 0;
  for (;;) {
    const at = s.indexOf(from, i);
    if (at < 0) {
      out += s.slice(i);
      return out;
    }
    out += s.slice(i, at) + to;
    i = at + from.length;
  }
  return out; // unreachable; satisfies the compiler's end-of-function check
}

/** Resolve ISPDB username templates against the requested address. */
export function substituteUsername(template: string, address: string, domain: string): string {
  let local = address;
  const at = address.lastIndexOf("@");
  if (at >= 0) local = address.slice(0, at);
  let u = replaceAll(template, "%EMAILADDRESS%", address);
  u = replaceAll(u, "%EMAILLOCALPART%", local);
  u = replaceAll(u, "%EMAILDOMAIN%", domain);
  u = replaceAll(u, "%emailaddress%", address);
  u = replaceAll(u, "%emaillocalpart%", local);
  u = replaceAll(u, "%emaildomain%", domain);
  return u;
}

/**
 * Map parsed ISPDB servers to candidates (D13-filtered). A server without
 * a hostname or with a non-TLS transport counts as `rejected`.
 */
export function candidatesFromIspdb(servers: XmlServer[], address: string, domain: string): IspdbResult {
  const out = new IspdbResult();
  const imaps: XmlServer[] = [];
  const smtps: XmlServer[] = [];
  for (let i = 0; i < servers.length; i++) {
    if (servers[i].type == "imap") imaps.push(servers[i]);
    else if (servers[i].type == "smtp") smtps.push(servers[i]);
  }
  const pairs = imaps.length < smtps.length ? imaps.length : smtps.length;
  for (let i = 0; i < pairs; i++) {
    const inc = imaps[i];
    const snd = smtps[i];
    // Both sides need a v1 password method (D5); mapAuthMethod("") = the
    // ISPDB default password-cleartext.
    if (mapAuthMethod(inc.auth).length == 0 || mapAuthMethod(snd.auth).length == 0) {
      out.rejected++;
      continue;
    }
    const user = substituteUsername(inc.username.trim(), address, domain).trim();
    const candidate = makeCandidate(
      address,
      inc.hostname.trim(),
      parsePort(inc.port, 993),
      inc.socketType.trim(),
      snd.hostname.trim(),
      parsePort(snd.port, 465),
      snd.socketType.trim(),
      inc.auth,
      user,
      SOURCE_ISPDB,
    );
    if (candidate == null) out.rejected++;
    else out.candidates.push(candidate);
  }
  return out;
}
