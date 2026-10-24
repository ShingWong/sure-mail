// Tests for the repository security gate (scripts/security-check.mjs).
//
// A scanner that never fires is worse than none, so each `detects` case is a
// realistic leak shape; each `allows` case is a look-alike that must NOT fire
// (semver, scoped packages, reserved example domains, CSS lengths) — false
// positives train people to widen the patterns until the gate is useless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, scanRepo } from "../scripts/security-check.mjs";

const detects = [
  ["Private key block", "-----BEGIN RSA PRIVATE KEY-----"],
  ["AWS access key id", 'const k = "AKIAIOSFODNN7EXAMPLE"'],
  ["GitHub token", `token: ghp_${"a".repeat(36)}`],
  ["Slack token", 'slack = "xoxb-1234567890-abcdefghij"'],
  ["Google API key", `key = "AIza${"b".repeat(35)}"`],
  ["OpenAI/Anthropic key", `key = "sk-${"c".repeat(32)}"`],
  ["Stripe live key", `stripe = "sk_live_${"d".repeat(24)}"`],
  ["JWT", 'auth = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"'],
  ["Credentials in URL", 'const db = "postgres://admin:hunter2@db.internal/app"'],
  ["Hardcoded password", 'const cfg = { password: "s3cretPass" }'],
  ["SSN", "patient 123-45-6789"],
  ["Card number", "card 4111 1111 1111 1111"],
  ["Email address", "contact alice@realcorp.example.co"],
];

for (const [label, line] of detects) {
  test(`security gate flags ${label}`, () => {
    const findings = scanText(line, "packages/core/src/example.ts");
    assert.ok(
      findings.some((f) => f.label === label),
      `expected ${label} in ${JSON.stringify(findings)}`,
    );
  });
}

test("security gate: internal paths and private IPs are flagged in shipped code", () => {
  for (const line of ['open("/Users/example/private/notes.md")', "host 10.20.30.40", "path /home/example/private/notes.md"]) {
    assert.ok(scanText(line, "packages/core/src/example.ts").length > 0, `should flag: ${line}`);
  }
});

test("security gate: documentation examples are not shipped code", () => {
  // The shipped-code rules (private IPs, internal paths) apply to packages/ and
  // scripts/; a README may quote an address or a path without implying one.
  const line = "deployed to 10.20.30.40:/opt/mail (example)";
  assert.deepEqual(scanText(line, "README.md"), []);
  assert.ok(scanText(line, "packages/core/src/example.ts").length > 0);
});

const allows = [
  ["semver", "version 10.2.3 and 192.168.1 are fine"],
  ["scoped package", "import x from '@shing.wong/sure-ui'"],
  ["reserved example email", "contact user@example.com"],
  ["git remote", "git clone git@github.com:ShingWong/sure-mail.git"],
  ["non-Luhn long number", "order 1234 5678 9012 3456"],
  ["CSS lengths", "flex: 0 0 1920px; gap: 10px"],
  ["placeholder key", "use YOUR_API_KEY_HERE"],
  ["add-on id (identifier, not a mailbox)", "id: positronic-email-plugin@positronic-ai.us"],
  ["add-on id inside an .xpi filename", "extensions/positronic-email-plugin@positronic-ai.com.xpi"],
];

test("security gate still flags a real address on a provider domain", () => {
  // The add-on-id exemption is scoped to our own domains; a third-party
  // mailbox must still be caught.
  assert.ok(scanText("contact alice@gmail.com", "docs/notes.md").length > 0);
});

for (const [name, line] of allows) {
  test(`security gate ignores ${name}`, () => {
    assert.deepEqual(scanText(line, "packages/core/src/example.ts"), []);
  });
}

test("security gate: never prints the full secret", () => {
  const secret = `ghp_${"z".repeat(36)}`;
  const [finding] = scanText(`token: ${secret}`, "packages/core/src/example.ts");
  assert.ok(finding, "expected the gate to flag the token");
  assert.ok(!finding.hint.includes(secret), `hint leaked the secret: ${finding.hint}`);
});

test("security gate: this repository is clean", () => {
  assert.deepEqual(scanRepo(), []);
});
