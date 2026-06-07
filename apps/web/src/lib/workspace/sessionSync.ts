"use client";

import { apiFetch, apiKeepaliveJson } from "@/lib/api/client";
import type { WorkspaceState } from "@/lib/workspace/schema";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

// Persist this device's workspace (last-write-wins). The device id is a server-owned
// httpOnly cookie injected by the BFF — the client never sends it. There is no read
// path here: restore happens on the server (see bootstrap.server.ts).
export async function putWorkspaceSession(
  state: WorkspaceState,
  keepalive = false
): Promise<void> {
  const body = { state };
  if (keepalive) {
    await apiKeepaliveJson(WORKSPACE_SESSION_PATH, body);
    return;
  }
  await apiFetch(WORKSPACE_SESSION_PATH, { method: "PUT", body: JSON.stringify(body) });
}
