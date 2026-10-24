# wasi-socket-server (experiment)

A feasibility probe for running the network layer as a minimal WASI
socket server that proves one artifact can listen, dial out and resolve names
with the **runtime** supplying the network.

Plain Rust `std`, no dependencies. Build and run:

```bash
cargo build --release --target wasm32-wasip2

wasmtime run -S cli=y -S tcp=y -S allow-ip-name-lookup=y -S inherit-network=y \
  target/wasm32-wasip2/release/wasi-socket-server.wasm listen 127.0.0.1:9100

# from another shell
node -e 'const n=require("net");const c=n.connect(9100,"127.0.0.1",()=>c.write("hi\n"));c.on("data",d=>{console.log(d.toString());c.end()})'
```

Proven on Linux and Windows (same `.wasm`) under the wasmtime CLI, and on
**Android** (emulator, API 36, x86_64) under **embedded wasmtime** — see
`android/`.

## Published artifact

The component is downloadable from the public status page — the same bytes this
directory builds, published once the licence was settled (MIT, D20):

```
https://positronic-ai.us/downloads/wasi-socket-server-0.1.0.wasm
sha256  9d16123dffb30c5ac73d52272df0baa0c9da7662ab026ba1690854b6f35e7c37
size    146,077 bytes   (built for wasm32-wasip2 with rustc 1.99.1)
```

Reproduce it:

```bash
cargo clean && cargo build --release --target wasm32-wasip2
sha256sum target/wasm32-wasip2/release/wasi-socket-server.wasm   # must match
```

A clean build was verified to produce that hash exactly, and the published copy
was smoke-tested before upload: `listen 127.0.0.1:9101` in one process, `connect`
in another, echoed reply received. Re-publishing means bumping the version in
`Cargo.toml` and adding a new filename on the site — the old one stays, because a
download URL that changes shape breaks anyone who pinned it.
