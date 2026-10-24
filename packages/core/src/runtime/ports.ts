// Host port declarations — the ONLY imports core.wasm is allowed to have
// (docs/abi.md §1). Everything else the core needs crosses the
// effects-out/feeds-in boundary. A test enforces this import section.

/** Milliseconds since the Unix epoch, from the host clock. */
// @ts-ignore: decorator
@external("sm.host", "now_ms")
export declare function now_ms(): f64;

/** Fill `dst` with cryptographically random bytes from the host. */
// @ts-ignore: decorator
@external("sm.host", "random_bytes")
export declare function random_bytes(dstPtr: usize, n: u32): void;

/**
 * Decode `len` bytes at `dataPtr` from the named charset to a string,
 * via the host's TextDecoder (UTF-8, Latin-1, windows-1252, ...).
 * The host always returns a string; unknown charsets fall back to
 * single-byte decoding in the host adapter.
 */
// @ts-ignore: decorator
@external("sm.host", "decode_text")
export declare function decode_text(dataPtr: usize, dataLen: u32, charset: string): string;
