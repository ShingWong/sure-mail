// Autodiscover candidate construction + the D13 transport filter
// (D5/D13): only TLS offers survive — implicit TLS
// (socketType SSL/TLS) or STARTTLS, with password auth (PLAIN/LOGIN over
// TLS). Plaintext-without-TLS and OAuth offers are discarded here, so no
// strategy can smuggle them into results. Each endpoint carries its own
// `socket_type` ("tls" | "starttls") because providers mix them (e.g.
// Outlook: IMAP 993 implicit TLS + SMTP 587 STARTTLS).

import { Json, KIND_ARR } from "../json/value.ts";
import { TRANSPORT_STARTTLS, TRANSPORT_TLS } from "../runtime/transport.ts";

// Candidate sources, in ranking order (rank is stored on every candidate;
// dedupe keeps the first occurrence, so the lowest rank wins).
export const SOURCE_PROVIDER: string = "provider";
export const SOURCE_ISPDB: string = "ispdb";
export const SOURCE_MX: string = "mx";
export const SOURCE_PROBE: string = "probe";

const RANK_PROVIDER: i32 = 1;
const RANK_ISPDB: i32 = 2;
const RANK_MX: i32 = 3;
const RANK_PROBE: i32 = 4;

function rankFor(source: string): i32 {
  if (source == SOURCE_PROVIDER) return RANK_PROVIDER;
  if (source == SOURCE_ISPDB) return RANK_ISPDB;
  if (source == SOURCE_MX) return RANK_MX;
  return RANK_PROBE;
}

/**
 * Map an auth-method string (ISPDB `<authentication>`/`<authMethod>`,
 * provider-table values) to a v1 password method: "plain" | "login" | ""
 * (rejected). The empty string (element absent) defaults to "plain" —
 * password-cleartext is the ISPDB schema default. OAuth2/XOAUTH2 and
 * client-side encryption have no v1 password equivalent (D5/D13) so they
 * map to "" and the offer is discarded. `password-encrypted` promises a
 * challenge-response mechanism v1 does not implement; those servers also
 * accept LOGIN/PLAIN over TLS, so it maps to the conservative password
 * fallback "login".
 */
export function mapAuthMethod(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.length == 0) return "plain";
  if (v == "password-cleartext" || v == "cleartext" || v == "plain" || v == "password") return "plain";
  if (v == "login" || v == "password-login" || v == "password-encrypted") return "login";
  return ""; // oauth2, xoauth2, client-encrypted, unknown -> rejected in v1
}

/**
 * D13 transport check: map one offer's socketType to a transport, or ""
 * (rejected). SSL/TLS means implicit TLS on any valid port (all built-in
 * strategies emit the canonical 993/465); STARTTLS is accepted on any
 * valid port and maps to the starttls transport (canonical 143/587). A
 * missing socketType is inferred from the canonical port only
 * (993/465 -> tls, 143/587 -> starttls); every other value (plain,
 * unknown) and any out-of-range port is rejected — plaintext stays
 * excluded.
 */
export function acceptTransport(socketType: string, port: i32, imap: bool): string {
  if (port < 1 || port > 65535) return "";
  const s = socketType.trim().toLowerCase();
  if (s == "ssl" || s == "tls") return TRANSPORT_TLS;
  if (s == "starttls") return TRANSPORT_STARTTLS;
  if (s.length > 0) return "";
  if (imap) {
    if (port == 993) return TRANSPORT_TLS;
    return port == 143 ? TRANSPORT_STARTTLS : "";
  }
  if (port == 465) return TRANSPORT_TLS;
  return port == 587 ? TRANSPORT_STARTTLS : "";
}

/** Host names must be plausible: no whitespace or URL/JSON surprises. */
function validHost(host: string): bool {
  if (host.length == 0 || host.length > 253) return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    const ok =
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) || // A-Z
      (c >= 48 && c <= 57) || // 0-9
      c == 46 || // .
      c == 45 || // -
      c == 95; // _
    if (!ok) return false;
  }
  return true;
}

/**
 * Build a candidate from one IMAP+SMTP offer pair, or null when the pair
 * fails the D13 filter (bad host, plaintext/unknown transport, no password
 * auth). Each endpoint records its own `socket_type`. `user` falls back to
 * the full address. `source` fixes the rank.
 */
export function makeCandidate(
  address: string,
  imapHost: string,
  imapPort: i32,
  imapSocket: string,
  smtpHost: string,
  smtpPort: i32,
  smtpSocket: string,
  authValue: string,
  user: string,
  source: string,
): Json | null {
  if (!validHost(imapHost) || !validHost(smtpHost)) return null;
  const imapTransport = acceptTransport(imapSocket, imapPort, true);
  if (imapTransport.length == 0) return null;
  const smtpTransport = acceptTransport(smtpSocket, smtpPort, false);
  if (smtpTransport.length == 0) return null;
  const auth = mapAuthMethod(authValue);
  if (auth.length == 0) return null;
  const imap = Json.emptyObj();
  imap.setStr("host", imapHost);
  imap.setInt("port", <i64>imapPort);
  imap.setStr("socket_type", imapTransport);
  const smtp = Json.emptyObj();
  smtp.setStr("host", smtpHost);
  smtp.setInt("port", <i64>smtpPort);
  smtp.setStr("socket_type", smtpTransport);
  const out = Json.emptyObj();
  out.set("imap", imap);
  out.set("smtp", smtp);
  out.setStr("auth", auth);
  out.setStr("user", user.length > 0 ? user : address);
  out.setStr("source", source);
  out.setInt("rank", <i64>rankFor(source));
  return out;
}

/** Dedupe key: the full IMAP+SMTP endpoint pair (host, port, transport). */
export function candidateKey(c: Json): string {
  const imap = c.get("imap");
  const smtp = c.get("smtp");
  let imapHost = "";
  let imapPort = 0;
  let imapSocket = "";
  let smtpHost = "";
  let smtpPort = 0;
  let smtpSocket = "";
  if (imap != null) {
    imapHost = imap.getString("host", "");
    imapPort = imap.getInt("port", 0);
    imapSocket = imap.getString("socket_type", "");
  }
  if (smtp != null) {
    smtpHost = smtp.getString("host", "");
    smtpPort = smtp.getInt("port", 0);
    smtpSocket = smtp.getString("socket_type", "");
  }
  return (
    imapHost + ":" + imapPort.toString() + "/" + imapSocket + "|" +
    smtpHost + ":" + smtpPort.toString() + "/" + smtpSocket
  );
}

/**
 * Deduplicate by endpoint pair, preserving first (best-rank) occurrence.
 * Strategies run in rank order, so first-wins is also rank-wins.
 */
export function dedupe(candidates: Json): Json {
  const out = Json.emptyArr();
  const seen = new Set<string>();
  if (candidates.kind != KIND_ARR) return out;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates.at(i);
    if (c == null) continue;
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
