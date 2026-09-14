"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import { WorkspaceSessionWriter, type WorkspaceSaveState } from "./sessionSync";
import type { WorkspaceState } from "./schema";
import type { PendingWorkspaceSession } from "./sessionStore";

export function useWorkspaceSession(
  state: WorkspaceState,
  mounted: boolean,
  accountId: string,
  recovered: PendingWorkspaceSession | null,
): { persistence: WorkspaceSaveState; retry: () => void } {
  const [persistence, setPersistence] = useState<WorkspaceSaveState>({ kind: "Saved" });
  const seed = useRef(state);
  const writerRef = useRef<WorkspaceSessionWriter | null>(null);

  useEffect(() => {
    if (!mounted) return;
    const writer = new WorkspaceSessionWriter(accountId, seed.current, (next) => {
      setPersistence(next);
      if ((next.kind === "LocalFailure" || next.kind === "SyncFailure") &&
          !handleUnauthenticatedApiError(next.error)) {
        console.error("workspace_session_save_failed", next.error);
        if (next.kind === "SyncFailure" &&
            (!isApiError(next.error) || isSameSystemApiDefect(next.error))) {
          reportClientDefect(next.error, { scope: "Workspace", componentStack: "" });
        }
      }
    }, recovered);
    writerRef.current = writer;
    writer.flush();
    const flush = () => writer.flush(true);
    const visible = () => {
      if (document.visibilityState === "hidden") writer.flush(true);
      else writer.flush();
    };
    const retry = () => writer.retry();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    return () => {
      writer.close();
      writerRef.current = null;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
    };
  }, [accountId, mounted, recovered]);

  useEffect(() => { writerRef.current?.capture(state); }, [state, mounted, accountId]);
  const retry = useCallback(() => writerRef.current?.retry(), []);
  return { persistence, retry };
}
