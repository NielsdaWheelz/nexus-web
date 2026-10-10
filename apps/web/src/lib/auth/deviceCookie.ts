// server-owned per-device identity: the workspace restore key, minted by
// middleware on the first active page GET and read by server code on the same
// request. the client never reads or sends it.
export const DEVICE_COOKIE_NAME = "nx_device";

export function readDeviceId(store: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return store.get(DEVICE_COOKIE_NAME)?.value ?? null;
}
