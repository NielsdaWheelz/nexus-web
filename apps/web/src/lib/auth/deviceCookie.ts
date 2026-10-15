// server-owned per-device identity: the workspace restore key, minted by
// middleware on the first active page GET and read by server code on the same
// request. the client never sends it (the bff stamps X-Nexus-Device); stats
// answers carry the viewer's device ids as opaque labels for filtering.
export const DEVICE_COOKIE_NAME = "nx_device";

export function readDeviceId(store: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return store.get(DEVICE_COOKIE_NAME)?.value ?? null;
}
