# sure-mail

A mail client whose entire logic lives in a headless core compiled to WASM —
accounts, IMAP, MIME, SMTP, autodiscover, the bounded local store and local
search — cleanly separated from every host. Hosts only move bytes and draw
pixels.

**Status: preview.** The command line and the browser app work; the packaged
single-file build exists for Linux. Rough edges are expected, and the project
makes no promise of data safety beyond what you can read in the code.

- Website and download: <https://positronic-ai.us/sure-mail/>
- Licence: MIT

## Why

Most mail clients keep protocol handling, storage and UI in one program, so
every new surface reimplements a fraction of the same behaviour and drifts.
sure-mail inverts that: one core owns the mail logic, and a host is a small
adapter that supplies network, storage, DNS and HTTP ports.

```
core.wasm (AssemblyScript)
   │  effects out / feeds in  (docs/abi.md)
   ├── CLI (Node)            packages/cli
   ├── browser app (WASM + OPFS + sqlite-wasm)   packages/ui + packages/host-web
   └── native host (single binary, SEA)          scripts/package.mjs
```

The core never performs I/O. It queues effects; the host executes them and
feeds results back. That boundary is the whole contract, and it is what makes
the same engine run behind a terminal, a browser worker and a packaged binary.

## Try it

```bash
npm install
npm run build          # core.wasm, hosts, UI
npm test               # build + every workspace suite (offline)

npm start -- doctor                       # core loads, imports match the ABI
npm start -- account add me@example.com --host imap.example.com --tls --user me@example.com --password-stdin
npm start -- sync
npm start -- list INBOX --unread
npm start -- read INBOX 1
npm start -- search invoice               # local full-text index

npm run build:web && npm start -- serve --ui    # the browser client on 127.0.0.1:8788
```

Everything above runs offline against mocks unless you give it a real account.
Tests never touch the network.

## One file, no installer

```bash
npm run build:web
npm run package          # → dist/sure-mail   (~122 MB: Node + the app + the UI)
./dist/sure-mail         # starts the host and opens the browser
```

The binary carries the CLI, the UI and `core.wasm`. With no arguments it
extracts the UI to a cache directory, serves it with the headers a
cross-origin-isolated page needs, and opens it. Every verb passes through, so
`./dist/sure-mail doctor` works from the same file.

Packaging is a launcher problem, not a port: there is no native code to compile
per platform.

## Layout

| path | what |
|---|---|
| `packages/core` | the mail engine (AssemblyScript → `core.wasm`) |
| `packages/cli` | the command line, over a Node host |
| `packages/host-node` | net/store/dns/http ports for Node, and the relay |
| `packages/host-web` | the same ports for a browser (relay-backed) |
| `packages/ui` | the browser app: `h()` factories, skins, stores |
| `packages/flows` | op compositions shared by hosts (the send flow) |
| `docs/` | the ABI and the relay wire protocol |
| `experiments/` | feasibility probes (WASI networking, Turso) |

## The rules the code follows

- **No framework in the client.** Plain DOM and element factories; no React, no
  state library, no CSS framework.
- **No runtime dependency** in the shipped client.
- **No mail logic in a host.** If a host starts making protocol decisions, the
  boundary has been crossed.
- **Fail closed.** An engine or capability the tables do not describe is an
  error, never a guessed dialect.

## Contributing

Issues and pull requests are welcome. Please keep changes inside the boundary:
core logic in `packages/core`, host behaviour in the host, no new runtime
dependencies without a reason that survives review.
