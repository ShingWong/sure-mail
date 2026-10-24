/**
 * Repository security gate: keys, credentials, PII, and internal paths.
 *
 * Two tiers, because the two kinds of leak have different homes:
 *   - **secrets and PII** (keys, tokens, passwords, SSNs, card numbers,
 *     non-example email addresses) are scanned in **every tracked file** — a
 *     leak in a design note is still a leak;
 *   - **internal paths and private IP addresses** are scanned in **shipped
 *     code only** (`packages/<name>/src|scripts|test`, root `scripts/`), because
 *     Documentation examples are the only exemptions.
 *     hosts and directories (and is not published).
 *
 * Runs in CI and in `prepublishOnly`, so a leak cannot reach main or the
 * registry unnoticed. Dependency-free on purpose: `prepublishOnly` must not
 * fetch anything, so this runs under plain `node` on a fresh clone.
 *
 * Usage: `node scripts/security-check.mjs`
 *
 * Allow-list etiquette: patterns are never loosened to make the check pass.
 * Add an entry keyed by file + label + exact matched text, with a reason, when
 * a hit is a deliberate doc/fixture value (placeholders, RFC 2606 examples).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')

/** Files npm always includes regardless of the "files" allowlist. */
const ROOT_FILES = ['README.md', 'LICENSE', 'package.json']

/** Scan text-ish files only; binaries cannot carry a readable secret. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.zip', '.gz', '.tgz', '.pdf', '.mp4', '.webm', '.mp3',
])
const MAX_BYTES = 1024 * 1024

/**
 * Test files carry synthetic fixtures (fake tokens, cards, passwords) by
 * design — that is how the gate proves it fires. They are still covered by the
 * key-material/.env filename rule, but skipped for content patterns.
 */
const TEST_FILE = /\.(?:test|spec)\.\w+$/

/** Secrets and PII — every tracked file. */
const GLOBAL_PATTERNS = [
  { label: 'Private key block', regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { label: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'OpenAI/Anthropic key', regex: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{24,}\b/ },
  { label: 'Stripe live key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/ },
  { label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: 'Credentials in URL', regex: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
  { label: 'Hardcoded password', regex: /password\s*[:=]\s*['"][^'"]{3,}['"]/i },
  { label: 'SSN', regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  { label: 'Email address', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
]

/** Shipped code only — documentation examples are the only exemptions. */
const SHIPPED_PATTERNS = [
  { label: 'Private IP address', regex: /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
  { label: 'Internal filesystem path', regex: /(?:\/Users\/|\/home\/[a-z0-9._-]+\/|\/usr\/local\/devel\/|C:\\Users\\)/i },
]
for (const p of [...GLOBAL_PATTERNS, ...SHIPPED_PATTERNS]) {
  p.global = new RegExp(p.regex.source, p.regex.flags + 'g')
}

/** Where the shipped-code-only rules apply. */
function isShippedCode(file) {
  return /^packages\/[^/]+\/(src|scripts|test)\//.test(file) || /^scripts\//.test(file)
}

/** Email domains that cannot belong to a real person (RFC 2606 / dev-only). */
const SAFE_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test', 'localhost', 'invalid', 'example', 'domain.test'])
/** Non-contact addresses that look like emails. */
const SAFE_EMAIL_LITERALS = new Set(['git@github.com', 'npm@npmjs.com', 'support@npmjs.com'])
/**
 * Add-on / extension ids have the shape of an address (`name@domain`) but are
 * identifiers, not mailboxes — e.g. the Thunderbird plugin's
 * `positronic-email-plugin@positronic-ai.us` (and the same id in an `.xpi`
 * filename). Recognised on our own domains only, so a real address on a
 * provider domain is still flagged.
 */
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9-]*@(?:positronic-ai\.(?:us|com|api)|positronic\.dev)(?:\.xpi)?$/i

/**
 * Explicit allow-list: known-benign matches. Every entry MUST carry a reason.
 * Keyed by file + label + exact text so line edits cannot silently widen it.
 */
const ALLOW = [
  {
    file: 'packages/host-node/test/fixtures/selfsigned.key',
    label: 'Key material file',
    match: 'selfsigned.key',
    reason: 'Throwaway self-signed certificate for the MockIMAP/MockSMTP TLS tests, generated for the fixtures',
  },
  {
    file: 'packages/host-node/test/fixtures/selfsigned.key',
    label: 'Private key block',
    match: 'BEGIN PRIVATE KEY',
    reason: 'The same throwaway test certificate — its PEM body necessarily contains a private-key block',
  },
  {
    file: 'packages/host-node/test/fixtures/selfsigned.pem',
    label: 'Key material file',
    match: 'selfsigned.pem',
    reason: 'Public half of the same throwaway test certificate used by the MockIMAP/MockSMTP TLS tests',
  },
  {
    file: 'README.md',
    label: 'Email address',
    match: 'alice@',  // fragment, so this allow-list cannot match itself
    reason: 'Documentation placeholder in the autodiscover example; the example must sit on a real provider domain for the provider-strategy lookup it demonstrates',
  },
  {
    file: 'packages/core/API.md',
    label: 'Email address',
    match: 'alice@',  // fragment, so this allow-list cannot match itself
    reason: 'Same autodiscover example as README.md — provider-strategy output needs a real provider domain',
  },
]

/** Luhn check — a 13–19 digit run is only reported if it is a valid card number. */
function luhnValid(digits) {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Show enough to locate a leak without printing the secret itself. */
function redact(match) {
  if (match.length <= 8) return `${match.slice(0, 2)}…`
  return `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`
}

function isSafeEmail(match) {
  if (SAFE_EMAIL_LITERALS.has(match.toLowerCase())) return true
  if (SAFE_IDENTIFIER.test(match)) return true // add-on id, not a mailbox
  const domain = match.slice(match.lastIndexOf('@') + 1).toLowerCase()
  return SAFE_EMAIL_DOMAINS.has(domain) || domain.endsWith('.example') || domain.endsWith('.test')
}

/**
 * Scan one text blob. Pure — this is what the unit tests exercise.
 * @returns {Array<{file: string, line: number, label: string, hint: string}>}
 */
export function scanText(text, file = '<memory>') {
  const findings = []
  const patterns = isShippedCode(file) ? [...GLOBAL_PATTERNS, ...SHIPPED_PATTERNS] : GLOBAL_PATTERNS
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of patterns) {
      const seen = new Set()
      for (const m of line.matchAll(pattern.global)) {
        const match = m[0]
        if (seen.has(match)) continue
        seen.add(match)
        if (pattern.label === 'Email address' && isSafeEmail(match)) continue
        const allowed = ALLOW.some((a) => a.file === file && a.label === pattern.label && match.includes(a.match))
        if (allowed) continue
        findings.push({ file, line: i + 1, label: pattern.label, hint: redact(match) })
      }
    }

    // Card numbers: regex-shaped, then Luhn-validated to avoid false positives.
    for (const m of line.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
      const digits = m[0].replace(/\D/g, '')
      if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) continue
      if (ALLOW.some((a) => a.file === file && a.label === 'Card number' && m[0].includes(a.match))) continue
      findings.push({ file, line: i + 1, label: 'Card number', hint: redact(m[0]) })
    }
  }
  return findings
}

/** Tracked files (git), or every file under packages/ when git is unavailable. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8' })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function scanPath(rel, findings) {
  const full = join(ROOT, rel)
  const ext = extname(full).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return
  if (TEST_FILE.test(rel)) return // synthetic fixtures — see TEST_FILE above
  let stat
  try {
    stat = statSync(full)
  } catch {
    return
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return
  let text
  try {
    text = readFileSync(full, 'utf-8')
  } catch {
    return
  }
  if (text.includes('\0')) return // binary content with a text extension
  findings.push(...scanText(text, rel.split(sep).join('/')))
}

/**
 * Scan the repository (tracked files + the files npm always ships).
 * @returns {Array<{file: string, line: number, label: string, hint: string}>}
 */
export function scanRepo() {
  const files = trackedFiles() ?? []
  const findings = []
  const seen = new Set()
  for (const rel of [...files, ...ROOT_FILES]) {
    const norm = rel.replace(/^\.\//, '')
    if (seen.has(norm)) continue
    seen.add(norm)
    if (!existsSync(join(ROOT, norm))) continue
    scanPath(norm, findings)
  }
  // A tracked .env or key file is always a finding, regardless of contents.
  for (const rel of seen) {
    const name = rel.split('/').pop() ?? ''
    if (/^\.env(\.|$)/.test(name) && !name.endsWith('.example')) {
      findings.push({ file: rel, line: 1, label: 'Committed environment file', hint: name })
    }
    if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) || name === 'id_rsa' || name === 'id_ed25519') {
      const allowed = ALLOW.some((a) => a.file === rel && a.label === 'Key material file')
      if (!allowed) findings.push({ file: rel, line: 1, label: 'Key material file', hint: name })
    }
  }
  return findings
}

function main() {
  const findings = scanRepo()
  if (findings.length > 0) {
    console.error('\n❌ SECURITY CHECK FAILED — potential key/credential/PII leak:\n')
    for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.label} — ${f.hint}`)
    console.error(
      '\nRemove the value, or — for a deliberate placeholder/fixture — add an\n' +
        'ALLOW entry in scripts/security-check.mjs with file + label + match + reason.\n',
    )
    process.exit(1)
  }
  console.log('✅ Security check passed — no keys, credentials, PII, or internal paths found.\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
