// DNS MX heuristic (M2 strategy 3): an MX lookup is first an existence
// signal — the domain demonstrably hosts mail — and second a source of
// common-name guesses derived from the domain itself (imap.<domain>,
// mail.<domain>). Each guess is offered twice under D13: implicit TLS
// (993/465) and STARTTLS (143/587), because a domain that is not in any
// provider table/ISPDB may offer either. A null MX (RFC 7505, exchange
// ".") says the domain explicitly does not accept mail: derive nothing.

import { Json, KIND_ARR } from "../json/value.ts";
import { makeCandidate, SOURCE_MX } from "./candidates.ts";

export class MxResult {
  candidates: Json = Json.emptyArr();
  mxCount: i32 = 0;
  nullMx: bool = false;
}

/**
 * Derive candidates from the MX records of the email's domain. `records`
 * is the dns.result feed's `records` array ({exchange, priority}); null
 * means no records (unsupported/error feeds are handled by the caller and
 * never reach derivation).
 */
export function deriveMxCandidates(address: string, domain: string, records: Json | null): MxResult {
  const out = new MxResult();
  if (records == null) return out;
  if (records.kind != KIND_ARR) return out;
  const arr = records;
  out.mxCount = arr.length;
  for (let i = 0; i < arr.length; i++) {
    const rec = arr.at(i);
    if (rec == null) continue;
    if (rec.getString("exchange", "").trim() == ".") {
      out.nullMx = true; // RFC 7505: domain explicitly does not accept mail
      return out;
    }
  }
  if (arr.length == 0) return out;
  // Common-name guesses on the email domain itself: implicit TLS and
  // STARTTLS variants (D13).
  const named = makeCandidate(address, "imap." + domain, 993, "ssl", "smtp." + domain, 465, "ssl", "plain", address, SOURCE_MX);
  const namedSt = makeCandidate(address, "imap." + domain, 143, "starttls", "smtp." + domain, 587, "starttls", "plain", address, SOURCE_MX);
  const mailHost = makeCandidate(address, "mail." + domain, 993, "ssl", "mail." + domain, 465, "ssl", "plain", address, SOURCE_MX);
  const mailHostSt = makeCandidate(address, "mail." + domain, 143, "starttls", "mail." + domain, 587, "starttls", "plain", address, SOURCE_MX);
  if (named != null) out.candidates.push(named);
  if (namedSt != null) out.candidates.push(namedSt);
  if (mailHost != null) out.candidates.push(mailHost);
  if (mailHostSt != null) out.candidates.push(mailHostSt);
  return out;
}
