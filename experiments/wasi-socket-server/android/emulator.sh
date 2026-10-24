#!/usr/bin/env bash
# One artifact, three hosts: build the wasmtime embedder for Android, push it
# plus the WASI 0.2 socket-server component to the emulator, and run the exact
# same echo server that Linux and Windows run under the wasmtime CLI.
#
#   android/emulator.sh build        cross-compile wasi-runner for the device ABI
#   android/emulator.sh push         adb push runner + component to /data/local/tmp
#   android/emulator.sh echo         guest -> guest listen/accept/echo, print evidence
#   android/emulator.sh host-echo    adb forward + echo from the dev box (host -> guest)
#   android/emulator.sh connect      guest dials out (proves connect + DNS)
#   android/emulator.sh all          build, push, echo, host-echo
#
# Environment: ANDROID_HOME (default ~/Android/Sdk), ANDROID_NDK_VERSION
# (default 27.2.12479018).
#
# Notes learned the hard way:
#   * `pkill -f wasi-runner` on the device kills the adb shell running it too
#     (the pattern matches the shell's own command line) — always use `pkill -x`.
#   * A `nohup ... &` child keeps the adb pty open, so `adb shell` never
#     returns; run the long-lived listener as a background *host* process.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"             # experiments/wasi-socket-server
runner_dir="$here/runner"
wasm="$root/target/wasm32-wasip2/release/wasi-socket-server.wasm"
export PATH="$HOME/.cargo/bin:$PATH"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
NDK_VERSION="${ANDROID_NDK_VERSION:-27.2.12479018}"
TOOLCHAIN="$SDK/ndk/$NDK_VERSION/toolchains/llvm/prebuilt/linux-x86_64"
ADB="$SDK/platform-tools/adb"
REMOTE=/data/local/tmp
PORT="${WASI_PORT:-9100}"

# The emulator AVD is x86_64; a physical device is usually arm64-v8a.
abi="$("$ADB" shell getprop ro.product.cpu.abi | tr -d '\r')"
case "$abi" in
  x86_64)    target=x86_64-linux-android;  cprefix=x86_64-linux-android26- ;;
  arm64-v8a) target=aarch64-linux-android; cprefix=aarch64-linux-android26- ;;
  *) echo "unsupported device ABI: $abi" >&2; exit 1 ;;
esac
key="${target//-/_}"

build() {
  echo "# target=$target (device ABI $abi), NDK $NDK_VERSION"
  export "CARGO_TARGET_${key^^}_LINKER=$TOOLCHAIN/bin/${cprefix}clang"
  export "CC_$key=$TOOLCHAIN/bin/${cprefix}clang"
  export "CXX_$key=$TOOLCHAIN/bin/${cprefix}clang++"
  export "AR_$key=$TOOLCHAIN/bin/llvm-ar"
  ( cd "$runner_dir" && cargo build --release --target "$target" )
  ls -l "$runner_dir/target/$target/release/wasi-runner"
}

push() {
  "$ADB" push "$runner_dir/target/$target/release/wasi-runner" "$REMOTE/wasi-runner"
  "$ADB" push "$wasm" "$REMOTE/wasi-socket-server.wasm"
  "$ADB" shell "chmod 755 $REMOTE/wasi-runner"
}

# Start the listener as a background host process; its stdout is the evidence.
listen_start() {
  "$ADB" shell "pkill -x wasi-runner" 2>/dev/null || true
  sleep 1
  "$ADB" shell "cd $REMOTE && exec ./wasi-runner ./wasi-socket-server.wasm listen 127.0.0.1:$PORT" \
    > /tmp/wasi-runner-listen.log 2>&1 &
  listener_pid=$!
  sleep 5
  "$ADB" shell "ps -A -o PID,NAME,ARGS | grep wasi | grep -v grep" || true
}

listen_stop() {
  "$ADB" shell "pkill -x wasi-runner" 2>/dev/null || true
  wait "$listener_pid" 2>/dev/null || true
  echo "--- listener stdout ---"
  cat /tmp/wasi-runner-listen.log
}

echo_guest() {
  echo "# guest -> guest: dial 127.0.0.1 from the same guest"
  listen_start
  "$ADB" shell "cd $REMOTE && ./wasi-runner ./wasi-socket-server.wasm connect 127.0.0.1:$PORT hello-from-android"
  listen_stop
}

host_echo() {
  echo "# host -> guest: adb forward $PORT, then echo from the dev box"
  listen_start
  "$ADB" forward "tcp:$PORT" "tcp:$PORT" >/dev/null
  node -e "const n=require('net');const c=n.connect($PORT,'127.0.0.1',()=>c.write('hello from the dev box\n'));c.on('data',d=>{console.log('dev box got:',JSON.stringify(d.toString()));c.end()})"
  "$ADB" forward --remove "tcp:$PORT" >/dev/null || true
  listen_stop
}

dial_out() {
  echo "# guest -> internet: proves outbound connect (+ DNS by name)"
  "$ADB" shell "cd $REMOTE && ./wasi-runner ./wasi-socket-server.wasm connect ${1:-mail.mx1.us:143}"
}

case "${1:-all}" in
  build) build ;;
  push) push ;;
  echo) echo_guest ;;
  host-echo) host_echo ;;
  connect) dial_out "${2:-mail.mx1.us:143}" ;;
  all) build; push; echo_guest; host_echo ;;
  *) echo "usage: $0 {build|push|echo|host-echo|connect|all}" >&2; exit 2 ;;
esac
