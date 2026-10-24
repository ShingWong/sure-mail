// Host-side op compositions shared by every sure-mail host.
//
// A flow runs the single-purpose core ops in order (M3 flow ownership: the
// ops stay single-purpose per the ABI, the composition lives above them) and
// is driver-shaped, so any host with the op ABI runs the same code instead of
// re-implementing it and drifting (D15).
export * from "./send.ts";
