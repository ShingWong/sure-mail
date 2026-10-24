// Stable error codes (docs/abi.md §3). Negative numbers never change
// meaning; errors carry {code, where, detail} across op_status.

export const ERR_INVALID_ARG: i32 = -1;
export const ERR_NOT_FOUND: i32 = -2;
export const ERR_STATE: i32 = -3;
export const ERR_PROTOCOL: i32 = -4;
export const ERR_HOST: i32 = -5;
export const ERR_UNSUPPORTED: i32 = -6;
export const ERR_CANCELLED: i32 = -7;

export function errorCodeName(code: i32): string {
  if (code == ERR_INVALID_ARG) return "invalid-arg";
  if (code == ERR_NOT_FOUND) return "not-found";
  if (code == ERR_STATE) return "state";
  if (code == ERR_PROTOCOL) return "protocol";
  if (code == ERR_HOST) return "host";
  if (code == ERR_UNSUPPORTED) return "unsupported";
  if (code == ERR_CANCELLED) return "cancelled";
  return "unknown";
}
