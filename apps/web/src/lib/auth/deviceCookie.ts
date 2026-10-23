import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import type { CookieWrite } from "@/lib/supabase/auth";

// server-owned per-device identity: the workspace restore key, minted by
// middleware or native bootstrap and read by server code on the same
// request. the client never sends it (the bff stamps X-Nexus-Device); stats
// answers carry the viewer's device ids as opaque labels for filtering.
export const DEVICE_COOKIE_NAME = "nx_device";

export function readDeviceId(store: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return store.get(DEVICE_COOKIE_NAME)?.value ?? null;
}

// one device context is selected before any workspace read; its cookie effect
// survives a later dependency failure.
export function resolveDevice(store: Parameters<typeof readDeviceId>[0]): {
  deviceId: string;
  writes: readonly CookieWrite[];
} {
  const existing = readDeviceId(store);
  if (existing !== null) return { deviceId: existing, writes: [] };
  const deviceId = createRandomId();
  return { deviceId, writes: [{ name: DEVICE_COOKIE_NAME, value: deviceId, options: {
    httpOnly: true, sameSite: "lax", secure: getEnv().appPublicOrigin.startsWith("https:"),
    path: "/", maxAge: 60 * 60 * 24 * 365 * 10,
  } }] };
}
