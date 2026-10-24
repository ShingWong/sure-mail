// Strategy 1 — built-in provider table (offline, no effects).
//
// Every entry records the provider's DOCUMENTED server configuration as of
// 2026-10. Under D13 the table now
// carries each endpoint's transport: implicit TLS (socketType SSL) and
// STARTTLS are both viable, so the SMTP-only-STARTTLS providers
// (Outlook/Live 587 STARTTLS, iCloud 587 STARTTLS) yield real candidates
// instead of being reported as rejected. Plaintext and OAuth-only offers
// still fail the filter.
//
// Sources: support.google.com (Gmail 465), help.yahoo.com (Yahoo 465),
// fastmail.help (Fastmail 465), support.gmx.com + hilfe.gmx.net +
// thunderbird/autoconfig#135 validation matrix (GMX/mail.com 465),
// support.microsoft.com (Outlook: IMAP 993 SSL + SMTP 587 STARTTLS;
// password auth over STARTTLS is the pre-OAuth2 fallback the v1 client
// uses), support.apple.com (iCloud: IMAP 993 SSL + SMTP 587 STARTTLS).

import { Json } from "../json/value.ts";
import { makeCandidate, SOURCE_PROVIDER } from "./candidates.ts";

class ProviderConfig {
  domains: string[] = [];
  imapHost: string = "";
  imapPort: i32 = 0;
  imapSocket: string = "ssl";
  smtpHost: string = "";
  smtpPort: i32 = 0;
  smtpSocket: string = "ssl";
  auth: string = "plain";

  constructor(
    domains: string[],
    imapHost: string,
    imapPort: i32,
    smtpHost: string,
    smtpPort: i32,
    imapSocket: string,
    smtpSocket: string,
    auth: string,
  ) {
    this.domains = domains;
    this.imapHost = imapHost;
    this.imapPort = imapPort;
    this.smtpHost = smtpHost;
    this.smtpPort = smtpPort;
    this.imapSocket = imapSocket;
    this.smtpSocket = smtpSocket;
    this.auth = auth;
  }
}

const TABLE: ProviderConfig[] = [
  new ProviderConfig(["gmail.com", "googlemail.com"], "imap.gmail.com", 993, "smtp.gmail.com", 465, "ssl", "ssl", "plain"),
  new ProviderConfig(["yahoo.com"], "imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 465, "ssl", "ssl", "plain"),
  new ProviderConfig(["fastmail.com", "fastmail.fm"], "imap.fastmail.com", 993, "smtp.fastmail.com", 465, "ssl", "ssl", "plain"),
  new ProviderConfig(["gmx.com", "gmx.us"], "imap.gmx.com", 993, "mail.gmx.com", 465, "ssl", "ssl", "plain"),
  new ProviderConfig(["gmx.net", "gmx.de", "gmx.at", "gmx.ch"], "imap.gmx.net", 993, "mail.gmx.net", 465, "ssl", "ssl", "plain"),
  new ProviderConfig(["mail.com", "email.com"], "imap.mail.com", 993, "smtp.mail.com", 465, "ssl", "ssl", "plain"),
  // Mixed transports (D13): implicit-TLS IMAP + STARTTLS SMTP.
  new ProviderConfig(
    ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    "outlook.office365.com", 993, "smtp-mail.outlook.com", 587, "ssl", "starttls", "plain",
  ),
  new ProviderConfig(
    ["icloud.com", "me.com", "mac.com"],
    "imap.mail.me.com", 993, "smtp.mail.me.com", 587, "ssl", "starttls", "plain",
  ),
];

export class ProviderLookup {
  candidates: Json = Json.emptyArr();
  rejected: i32 = 0;
}

function contains(list: string[], v: string): bool {
  for (let i = 0; i < list.length; i++) {
    if (list[i] == v) return true;
  }
  return false;
}

/**
 * Exact-match lookup of the provider table for one email domain (the
 * address itself supplies the default username). `candidates` counts
 * surviving D13 candidates; `rejected` counts matched entries the filter
 * discarded (none of the built-in rows are rejected today).
 */
export function lookupProvider(domain: string, address: string): ProviderLookup {
  const out = new ProviderLookup();
  const d = domain.toLowerCase();
  for (let i = 0; i < TABLE.length; i++) {
    const cfg = TABLE[i];
    if (!contains(cfg.domains, d)) continue;
    const candidate = makeCandidate(
      address,
      cfg.imapHost,
      cfg.imapPort,
      cfg.imapSocket,
      cfg.smtpHost,
      cfg.smtpPort,
      cfg.smtpSocket,
      cfg.auth,
      address,
      SOURCE_PROVIDER,
    );
    if (candidate == null) out.rejected++;
    else out.candidates.push(candidate);
  }
  return out;
}
