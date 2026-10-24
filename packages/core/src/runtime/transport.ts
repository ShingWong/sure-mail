// Transport-mode resolution (D13): an account endpoint is implicit TLS,
// STARTTLS, or — for mocks and the low-level ABI only — plaintext.
//
// The persisted field is `socket_type` ("tls" | "starttls") for the IMAP
// endpoint and `smtp_socket_type` for the SMTP endpoint (schema v4). An
// account without it falls back to the legacy `tls` boolean (true ->
// implicit TLS, false -> plaintext). Plaintext is never produced by a
// product surface (autodiscover filter, CLI); it exists so the host can be
// driven by a scripted mock without a TLS stack.

import { Json } from "../json/value.ts";

export const TRANSPORT_TLS: string = "tls";
export const TRANSPORT_STARTTLS: string = "starttls";
export const TRANSPORT_PLAIN: string = "plain";

/** Resolve one endpoint's transport mode. `smtp` selects the SMTP side. */
export function transportMode(account: Json, smtp: bool): string {
  const key = smtp ? "smtp_socket_type" : "socket_type";
  const socketType = account.getString(key, "").trim().toLowerCase();
  if (socketType == TRANSPORT_STARTTLS) return TRANSPORT_STARTTLS;
  if (socketType == "tls" || socketType == "ssl") return TRANSPORT_TLS;
  // Legacy boolean fallback: the SMTP side prefers the in-memory smtp_tls
  // override, then the shared tls flag (pre-D13 behaviour).
  const legacyTls = smtp ? account.getBool("smtp_tls", account.getBool("tls", true)) : account.getBool("tls", true);
  return legacyTls ? TRANSPORT_TLS : TRANSPORT_PLAIN;
}
