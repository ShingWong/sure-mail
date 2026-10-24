// Load the REAL compiled core.wasm (and probes.wasm) through asc's raw
// JS bindings with a mock `sm.host` import object. Every core test goes
// through this — no TypeScript sources are ever imported by tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiate as instantiateCore } from "../../dist/core.js";
import { instantiate as instantiateProbes } from "../../dist/probes.js";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

function latin1(bytes) {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function makeHost(overrides, state) {
  return {
    now_ms: () => (overrides.now !== undefined ? overrides.now : 1700000000123),
    random_bytes: (dst, n) => {
      const arr = new Uint8Array(state.exports.memory.buffer, dst, n);
      for (let i = 0; i < n; i++) {
        arr[i] = overrides.random ? overrides.random(i) : (i * 7 + 1) & 0xff;
      }
    },
    decode_text: (ptr, len, charset) => {
      const bytes = new Uint8Array(state.exports.memory.buffer, ptr, len);
      if (overrides.decodeText) return overrides.decodeText(charset, bytes);
      try {
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return latin1(bytes); // same fallback contract as the node host adapter
      }
    },
  };
}

async function load(overrides, mod, instantiate) {
  const state = { exports: null };
  const wasm = await WebAssembly.compile(readFileSync(join(distDir, mod)));
  const exports = await instantiate(wasm, { "sm.host": makeHost(overrides, state), env: {} });
  state.exports = exports;
  return exports;
}

/** Instantiate dist/core.wasm with the mock host. */
export function loadCore(overrides = {}) {
  return load(overrides, "core.wasm", instantiateCore);
}

/** Instantiate dist/probes.wasm with the mock host. */
export function loadProbes(overrides = {}) {
  return load(overrides, "probes.wasm", instantiateProbes);
}

/** Read the import section of a compiled module (conformance checks). */
export async function moduleImports(wasmFile) {
  const wasm = await WebAssembly.compile(readFileSync(join(distDir, wasmFile)));
  return WebAssembly.Module.imports(wasm);
}
