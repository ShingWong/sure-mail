// mime.build op (M3): pure — {message} -> {rawB64}, no effects. The
// factory validates the spec, runs the builder, and completes the op
// inline (the runtime allows completion during create for pure ops).

import { Json } from "../json/value.ts";
import { b64Encode } from "../encoding/base64.ts";
import { unlatain } from "../imap/reader.ts";
import { Op, OpFactory, OpHandler, Runtime } from "../runtime/ops.ts";
import { buildMessage } from "./build.ts";

class NoopHandler implements OpHandler {
  onFeed(_op: Op, _kind: string, _data: Json): i32 {
    return 0;
  }
  onCancel(_op: Op): void {}
}

export class MimeBuildFactory implements OpFactory {
  // Pure op: registered on the runtime like every other factory, but it
  // never emits effects — the runtime reference is kept for symmetry.
  runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  create(args: Json, op: Op): OpHandler | null {
    const message = args.get("message");
    if (message == null) return null;
    const plan = buildMessage(message);
    if (!plan.ok) return null;
    const out = Json.emptyObj();
    out.setStr("rawB64", b64Encode(unlatain(plan.raw)));
    out.setInt("size", <i64>plan.raw.length);
    // echo the generated Message-ID back for callers that need it
    let messageId = "";
    const header = "\r\nMessage-ID: ";
    const mi = plan.raw.indexOf(header);
    if (mi >= 0) {
      const start = mi + header.length;
      const end = plan.raw.indexOf("\r\n", start);
      messageId = plan.raw.substring(start, end < 0 ? plan.raw.length : end).trim();
    }
    out.setStr("messageId", messageId);
    if (plan.boundaryMixed.length > 0) out.setStr("boundaryMixed", plan.boundaryMixed);
    if (plan.boundaryAlt.length > 0) out.setStr("boundaryAlt", plan.boundaryAlt);
    op.complete(out);
    return new NoopHandler();
  }
}
