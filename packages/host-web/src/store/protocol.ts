// store RPC protocol: the messages that cross between the main thread and
// the store worker (a Web Worker in the browser, a worker_threads thread in
// the Node test harness). One request in, one `result` back, correlated by
// `id` — the same JSON-in/JSON-out discipline the core ABI uses for
// store.exec effects (docs/abi.md §2).

export interface StoreResult {
  rows: Record<string, unknown>[];
  changes: number;
  insertId: number;
}

export interface StoreError {
  code: number;
  where: string;
  detail: string;
}

export interface StoreInit {
  t: "init";
}

export interface StoreExec {
  t: "exec";
  id: number;
  store: string;
  sql: string;
  params: unknown[];
}

export interface StoreClose {
  t: "close";
}

export type StoreRequest = StoreInit | StoreExec | StoreClose;

export interface StoreReady {
  t: "ready";
  /** true = OPFS-backed, false = in-memory (Node test harness / no OPFS). */
  persistent: boolean;
}

export interface StoreResultMsg {
  t: "result";
  id: number;
  result?: StoreResult;
  error?: StoreError;
}

export interface StoreFatal {
  t: "fatal";
  error: StoreError;
}

export type StoreReply = StoreReady | StoreResultMsg | StoreFatal;

export interface StoreClientEndpoint {
  post(msg: StoreRequest): void;
  onReply(cb: (msg: StoreReply) => void): void;
  /** Tear the endpoint down (terminate the worker, drop the port). */
  close?(): void;
}

export interface StoreWorkerEndpoint {
  post(msg: StoreReply): void;
  onRequest(cb: (msg: StoreRequest) => void): void;
}
