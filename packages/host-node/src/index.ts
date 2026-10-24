// sure-mail Node host: reference reactor + port implementations for
// core.wasm (docs/abi.md §4-5).

export { MailCore, type CoreExports, type MailCoreOptions, type OpError, type OpStatus, type DriveOptions } from "./core.ts";
export { executeEffect, type Effect, type ExecutorContext, type FeedFn } from "./executor.ts";
export { decodeBytes } from "./decode.ts";
export { dataPaths, storePath, type Paths } from "./paths.ts";
export { NetPorts, type NetEventSink, type NetOptions } from "./ports/net.ts";
export { StorePorts, type StoreResult } from "./ports/store.ts";
export { lookupRecord, type DnsResult } from "./ports/dns.ts";
export { fetchText, type HttpOptions, type HttpResult } from "./ports/http.ts";
export { startRelay, type RelayHandle, type RelayOptions } from "./relay.ts";
export { startStaticServer, type StaticServerOptions, type StaticServerHandle } from "./serve.ts";
