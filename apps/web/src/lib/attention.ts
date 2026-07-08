import { apiFetch } from "@/lib/api/client";
import type { ReadStatus } from "@/lib/collections/types";

/**
 * Read the opaque device id for the attention ledger. The server-owned
 * `nx_device` cookie is canonical; a localStorage-persisted UUID is the fallback
 * before the cookie is set. Both are opaque; the server does not validate them.
 */
export function readDeviceId(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith("nx_device="));
  if (match) return decodeURIComponent(match.slice("nx_device=".length));

  const KEY = "nx_device_fallback";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export type ConsumptionOverrideStatus = Extract<ReadStatus, "unread" | "finished">;

export async function postConsumptionOverride(
  mediaId: string,
  status: ConsumptionOverrideStatus,
): Promise<void> {
  await apiFetch(`/api/media/${mediaId}/consumption-override`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}
