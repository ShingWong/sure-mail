// Browser entry: build the host, boot the shell, expose a handle for tests.
import { createMailHost } from "@shing.wong/sure-mail-host-web";
import { DEFAULT_SKIN_ID } from "../skin/index.ts";
import { MailApp, type AccountInput } from "../shell/app.ts";
import type { ThemeChoice } from "../shell/chrome.ts";

declare global {
  interface Window {
    sureMail?: MailApp;
  }
}

const params = new URLSearchParams(location.search);

function prefill(): Partial<AccountInput> {
  const out: Partial<AccountInput> = {};
  const address = params.get("address");
  const host = params.get("host");
  const port = params.get("port");
  const user = params.get("user");
  const password = params.get("password");
  const tls = params.get("tls");
  const smtpHost = params.get("smtp_host");
  const smtpPort = params.get("smtp_port");
  if (address) out.address = address;
  if (host) out.host = host;
  if (port) out.port = Number(port);
  if (user) out.user = user;
  if (password) out.password = password;
  if (tls !== null) out.tls = tls === "1" || tls === "true";
  if (smtpHost) out.smtpHost = smtpHost;
  if (smtpPort) out.smtpPort = Number(smtpPort);
  return out;
}

function savedSkin(): string | null {
  try {
    return localStorage.getItem("sure-mail.skin");
  } catch {
    return null;
  }
}

function savedTheme(): ThemeChoice | null {
  try {
    const value = localStorage.getItem("sure-mail.theme");
    return value === "light" || value === "dark" || value === "auto" ? value : null;
  } catch {
    return null;
  }
}

function themeParam(): ThemeChoice | null {
  const value = params.get("theme");
  return value === "light" || value === "dark" || value === "auto" ? value : null;
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app root");
  const relayUrl = params.get("relay") ?? undefined;
  const host = await createMailHost({
    wasm: fetch(new URL("core.wasm", import.meta.url)),
    ...(relayUrl ? { relayUrl } : {}),
    log: (level, msg) => {
      if (level !== "debug") console.info(`[${level}] ${msg}`);
    },
  });
  // Boot core state the way the CLI does; the registry read happens in start().
  host.init({});
  const app = new MailApp(host, root, {
    skinId: params.get("skin") ?? savedSkin() ?? DEFAULT_SKIN_ID,
    theme: themeParam() ?? savedTheme() ?? "auto",
    prefill: prefill(),
  });
  await app.start();
  window.sureMail = app;
  document.documentElement.dataset.booted = "true";
  // Drop the boot content now that the shell owns the page. Kept on failure so
  // the page still says what it is and where the install notes are.
  document.getElementById("boot")?.remove();
}

main().catch((err) => {
  console.error(err);
  const root = document.getElementById("app");
  if (root) {
    const pre = document.createElement("pre");
    pre.className = "sure-mail-app__empty";
    pre.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    root.replaceChildren(pre);
  }
});
