// Host port wiring through the real probes.wasm: the sm.host imports
// receive exactly the bytes/strings the core intends (docs/abi.md §1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProbes } from "./helpers/load.mjs";

test("now_ms passes the host clock value through unchanged", async () => {
  const probes = await loadProbes({ now: 1712345678901.5 });
  assert.equal(probes.probeNow(), 1712345678901.5);
});

test("random_bytes fills the core's buffer (length + content)", async () => {
  const probes = await loadProbes();
  const hex = probes.probeRandom(16);
  assert.equal(hex.length, 32, "16 bytes = 32 hex chars");
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(hex, "01080f161d242b323940474e555c636a", "deterministic mock pattern");
});

test("random_bytes with varying host randomness produces distinct fills", async () => {
  // A stateful override proves the core reads whatever the host wrote.
  let n = 0;
  const probes = await loadProbes({ random: () => (n++ * 31 + 5) & 0xff });
  assert.notEqual(probes.probeRandom(8), probes.probeRandom(8));
  const fixed = await loadProbes({ random: (i) => 255 - i });
  assert.equal(fixed.probeRandom(4), "fffefdfc");
});

test("decode_text receives exact bytes and charset, returns the host string", async () => {
  const seen = [];
  const probes = await loadProbes({
    decodeText: (charset, bytes) => {
      seen.push({ charset, bytes: Buffer.from(bytes).toString("hex") });
      return `decoded:${charset}:${bytes.length}`;
    },
  });
  // base64 "aGVsbG8=" = "hello"
  assert.equal(probes.probeDecodeText("aGVsbG8=", "utf-8"), "decoded:utf-8:5");
  assert.deepEqual(seen, [{ charset: "utf-8", bytes: "68656c6c6f" }]);
});

test("decode_text with the TextDecoder path decodes windows-1252", async () => {
  const probes = await loadProbes();
  // 0xE9 = é in windows-1252 / latin-1
  assert.equal(probes.probeDecodeText("6Q==", "windows-1252"), "é");
  // UTF-8 bytes of "héllo"
  assert.equal(probes.probeDecodeText("aMOpbGxv", "utf-8"), "héllo");
});

test("decode_text falls back to single-byte decoding for unknown charsets", async () => {
  const probes = await loadProbes();
  assert.equal(probes.probeDecodeText("6Q==", "no-such-charset"), "é");
});
