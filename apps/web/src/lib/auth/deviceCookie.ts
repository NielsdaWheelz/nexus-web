import { createRandomId } from "@/lib/createRandomId";
import { isDeployed } from "@/lib/env";

// Server-owned per-device identity. The workspace-session restore key lives here —
// an httpOnly cookie minted in middleware — NOT in localStorage, so the server can
// read it at request time and restore the right panes on the first paint. The
// client never reads or sends it; the BFF injects it into workspace-session writes.
export const DEVICE_COOKIE_NAME = "nx_device";

// ~10 years: a device id is stable for the life of the browser profile.
const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

export function readDeviceId(store: {
  get(name: string): { value: string } | undefined;
}): string | null {
  return store.get(DEVICE_COOKIE_NAME)?.value ?? null;
}

export function mintDeviceId(): {
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: "/";
    maxAge: number;
  };
} {
  return {
    value: createRandomId(),
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure: isDeployed(),
      path: "/",
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
    },
  };
}
