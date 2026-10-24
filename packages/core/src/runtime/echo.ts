// Test-only op kind `echo`: proves the effects/feeds loop end to end with
// no network (M0 acceptance). Queues a `log`
// effect at start, completes when the host feeds `echo.data` back.

import { Json } from "../json/value.ts";
import { Op, OpFactory, OpHandler, Runtime } from "./ops.ts";

export class EchoHandler implements OpHandler {
  msg: string;

  constructor(msg: string) {
    this.msg = msg;
  }

  onFeed(op: Op, kind: string, data: Json): i32 {
    if (kind != "echo.data") return 0; // unrelated feed: acknowledge, keep waiting
    const out = Json.emptyObj();
    out.setStr("echo", data.getString("echo", ""));
    out.setStr("msg", this.msg);
    op.complete(out);
    return 0;
  }

  onCancel(_op: Op): void {}
}

export class EchoFactory implements OpFactory {
  runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  create(args: Json, op: Op): OpHandler | null {
    const msg = args.getString("msg", "echo");
    const eff = Json.emptyObj();
    eff.setStr("kind", "log");
    eff.setStr("level", "info");
    eff.setStr("msg", msg);
    this.runtime.emitEffect(op, eff);
    return new EchoHandler(msg);
  }
}
