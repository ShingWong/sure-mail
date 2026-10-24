# wasi-socket-server on Android

The Android leg of the WASI socket probe: the **same 146 KB WASI 0.2
component** that runs on Linux and Windows under the `wasmtime` CLI, running
on an Android emulator under **embedded wasmtime**.

Result: **works** — listen/accept/echo (guest→guest *and* host→guest) plus
outbound connect with DNS by name. Evidence below.

## Why embedding wasmtime

The alternative on Android is WasmEdge (ships Android builds). We did not need
it, and did not test it: wasmtime lists `x86_64-linux-android` and
`aarch64-linux-android` as **Tier 2 (CI-tested)** host targets, and the
`wasmtime` + `wasmtime-wasi` crates cross-compile cleanly with the NDK.
Embedding wasmtime means **one runtime on Linux, Windows and Android** — the
same crate version, the same component, the same `WasiCtx` capability switches
that the CLI's `-S cli=y -S tcp=y -S allow-ip-name-lookup=y
-S inherit-network=y` map to.

(WasmEdge's networking is the `wasi_snapshot_preview1` `sock_*` extension,
added in 0.8.2 before `wasi:sockets` was standardized — not the `wasi:sockets`
0.2 interfaces this component imports. It would have meant a second socket
path to keep in step, which is why it stayed the fallback.)

## Layout

```
android/
  runner/            # wasi-runner: a ~40-line wasmtime embedding (Rust)
  emulator.sh        # build / push / echo / host-echo / connect
  evidence/          # transcript + screenshot from the emulator run
```

`runner/src/main.rs` is the whole host: build a `WasiCtx` with TCP, UDP, DNS
and inherited network enabled, `add_to_linker_sync`, instantiate the
`wasi:cli/command` component, call `run`. It is the embedding equivalent of the
wasmtime CLI invocation.

## Build

Once per target (NDK r27c here; the exact version only needs to be >= the
`-linux-android26-` clang triple):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK="$ANDROID_HOME/ndk/27.2.12479018"
export TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"

# linker + the C toolchain (the `cc` crate is pulled in by wasmtime's deps)
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TC/bin/x86_64-linux-android26-clang"
export CC_x86_64_linux_android="$TC/bin/x86_64-linux-android26-clang"
export CXX_x86_64_linux_android="$TC/bin/x86_64-linux-android26-clang++"
export AR_x86_64_linux_android="$TC/bin/llvm-ar"

cd android/runner
cargo build --release --target x86_64-linux-android     # ~2m35s cold, 12 cores
# → target/x86_64-linux-android/release/wasi-runner      (15 MB, stripped, PIE)

# arm64 devices instead:
#   cargo build --release --target aarch64-linux-android
```

Or just `android/emulator.sh build` (it picks the target from
`ro.product.cpu.abi` and sets the four env vars above).

## Run

```bash
node ../../scripts/android-emulator.mjs status      # emulator-5554
android/emulator.sh push
android/emulator.sh echo         # guest -> guest echo
android/emulator.sh host-echo    # adb forward + echo from the dev box
android/emulator.sh connect      # guest -> internet by name (DNS)
```

Under the hood it is one line on the device:

```bash
adb push target/wasm32-wasip2/release/wasi-socket-server.wasm /data/local/tmp/
adb push .../wasi-runner /data/local/tmp/
adb shell "chmod 755 /data/local/tmp/wasi-runner"
adb shell "cd /data/local/tmp && ./wasi-runner ./wasi-socket-server.wasm listen 127.0.0.1:9100"
adb shell "cd /data/local/tmp && ./wasi-runner ./wasi-socket-server.wasm connect 127.0.0.1:9100 hi"
```

## Evidence

Emulator: AVD `sure-mail`, Android 16 / API 36, `x86_64` (`sdk_gphone64_x86_64`).

```
$ adb shell getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi
16
36
x86_64

$ adb shell ps -A -o PID,NAME,ARGS | grep wasi
 4057 wasi-runner  wasi-runner ./wasi-socket-server.wasm listen 127.0.0.1:9100

$ adb shell ./wasi-runner ./wasi-socket-server.wasm connect 127.0.0.1:9100 hello-from-android-guest
connected to 127.0.0.1:9100
reply: hello-from-android-guest

$ node -e 'net.connect(9100,"127.0.0.1") ...'          # dev box, after adb forward
dev box got: "hello from the dev box\n"

# listener stdout (on the emulator)
listening on 127.0.0.1:9100
accepted Some(127.0.0.1:39202)
closed
accepted Some(127.0.0.1:39955)
closed

$ adb shell ./wasi-runner ./wasi-socket-server.wasm connect mail.mx1.us:143
connected to mail.mx1.us:143
reply: * OK [CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ STARTTLS LOGINDISABLED] Dovecot ready.
```

`evidence/android-transcript.txt` is the raw capture;
`evidence/emulator.png` is a screenshot of the emulator rendering it.

## Honest limits

- **The emulator proves the runtime, not the app.** There is no Android *host
  app* yet — this runs `wasi-runner` as a native executable in
  `/data/local/tmp` over `adb`, which is the cheapest honest test. Shipping it
  means wrapping the same ~40 lines behind JNI/a `cdylib` in an APK; nothing
  about the runtime changes, but it is unproven until that exists.
- **JIT, not AOT.** wasmtime compiles the component at load — 0.28 s
  end-to-end on the emulator (0.11 s on the dev box under the CLI) — and needs
  executable memory, which Android allows (the same mechanism ART and V8 use).
  For a real app you would precompile with `wasmtime compile` and ship
  `.cwasm`, which avoids both the compile time and the W^X question; that is
  supported but not exercised here.
- **Nested virtualization.** The dev box is itself a VM, so the emulator is
  slow; timings here are not a benchmark.
- **x86_64 proven end-to-end; aarch64 built, not run.** Real phones are arm64;
  the arm64 binary compiles with the same recipe but there is no arm64 device
  on this rig to run it on.
- **`wasi-tls` is not exercised.** The embedder enables TCP/UDP/DNS only. TLS
  in wasmtime is a separate crate (`wasmtime-wasi-tls`) which is not published
  at 49.0.2 (it first appears at 50.0.0-rc.1), so it is not a one-liner at the
  version used here and client TLS on Android remains untested.
- **No app-level sandbox test.** A plain executable in `/data/local/tmp` runs
  outside the Android app sandbox, so this says nothing about whether an
  installed APK's SELinux/seccomp context permits the same sockets. That is
  the next question if this goes further.

## Gotchas hit (worth not rediscovering)

- `pkill -f wasi-runner` **on the device** also kills the `adb shell` running
  it, because the pattern matches that shell's own command line. Use
  `pkill -x wasi-runner`.
- A `nohup ... &` child keeps the adb pty open, so `adb shell` never returns.
  Run the long-lived listener as a background *host* process instead.
- `adb shell` gives the guest `argv[0]` = the component path only if the
  embedder passes it (the CLI does). Miss it and the guest's `args().skip(1)`
  eats the first real argument.
- The `cc` crate needs `AR_x86_64_linux_android` (and `CC_`/`CXX_`) set, not
  just the cargo linker — wasmtime's dependency tree has C build scripts.
