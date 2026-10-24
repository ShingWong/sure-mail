// browser store worker entry: wires the DedicatedWorkerGlobalScope to the
// shared worker main. Bundled by scripts/build.mjs to dist-web/store-worker.js
// and spawned by createMailHost() as `new Worker(url, {type:"module"})`.

import { runStoreWorker } from "./worker-main.ts";
import type { StoreWorkerEndpoint, StoreReply, StoreRequest } from "./protocol.ts";

const scope = globalThis as unknown as {
  postMessage(msg: StoreReply): void;
  addEventListener(type: "message", listener: (ev: { data: StoreRequest }) => void): void;
};

const endpoint: StoreWorkerEndpoint = {
  post: (msg) => scope.postMessage(msg),
  onRequest: (cb) => {
    scope.addEventListener("message", (ev) => cb(ev.data));
  },
};

runStoreWorker(endpoint);
