"use client";

import { useEffect, useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { WorkspaceSessionStore, type PendingWorkspaceSession } from "./sessionStore";
import { createDefaultWorkspaceState, getWorkspacePrimaryPanes, type WorkspaceState } from "./schema";
import { mergeRestoredWorkspaceWithDeepLink } from "./workspaceRestore";
import type { WorkspacePrimaryMetrics } from "./paneSizing";

// A recovered layout must become visible before its only local copy is
// acknowledged. Other windows have no global ordering, so recovery is a choice,
// and every choice has a terminal disposition: restore, keep, or discard.
export default function WorkspaceRecovery({ accountId, initialState, entryHref, metrics, children }: {
  accountId: string;
  initialState: WorkspaceState;
  entryHref: string | null;
  metrics: WorkspacePrimaryMetrics;
  children: (state: WorkspaceState, recovered: PendingWorkspaceSession | null) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [store] = useState(() => new WorkspaceSessionStore());
  const [recovery, setRecovery] = useState<
    | { kind: "Loading" }
    | { kind: "Failed" }
    | { kind: "Choose"; row: PendingWorkspaceSession; discardFailed: boolean }
    | { kind: "Ready"; row: PendingWorkspaceSession | null; state: WorkspaceState }
  >({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void store.next(accountId).then((row) => {
      if (active) setRecovery(row === null
        ? { kind: "Ready", row: null, state: initialState }
        : { kind: "Choose", row, discardFailed: false });
    }, (error: unknown) => {
      console.error("workspace_recovery_load_failed", error);
      if (active) setRecovery({ kind: "Failed" });
    });
    return () => { active = false; };
  }, [accountId, attempt, initialState, store]);

  switch (recovery.kind) {
    case "Loading":
      return <p role="status">Loading workspace…</p>;
    case "Failed":
      return <section aria-label="Workspace recovery">
        <p>Local workspace recovery could not load.</p>
        <Button onClick={() => { setRecovery({ kind: "Loading" }); setAttempt(attempt + 1); }}>Retry</Button>
        <Button variant="secondary" onClick={() => setRecovery({ kind: "Ready", row: null, state: initialState })}>Open synced workspace</Button>
      </section>;
    case "Choose": {
      const offered = recovery.row;
      return <section aria-label="Workspace recovery">
        <p>This device has an unsynced layout with {getWorkspacePrimaryPanes(offered.state).length} panes.</p>
        {recovery.discardFailed
          ? <p role="alert">This layout could not be discarded on this device.</p> : null}
        <Button onClick={() => setRecovery({
          kind: "Ready", row: offered,
          state: entryHref === null ? offered.state
            : mergeRestoredWorkspaceWithDeepLink(
              offered.state, createDefaultWorkspaceState(entryHref, metrics), metrics,
            ),
        })}>Restore this layout</Button>
        <Button variant="secondary" onClick={() => setRecovery({ kind: "Ready", row: null, state: initialState })}>Keep it for later; open synced workspace</Button>
        <Button variant="danger" onClick={() => {
          void store.remove(offered).then(() => {
            setRecovery({ kind: "Ready", row: null, state: initialState });
          }, (error: unknown) => {
            console.error("workspace_recovery_discard_failed", error);
            setRecovery({ kind: "Choose", row: offered, discardFailed: true });
          });
        }}>Discard this layout permanently</Button>
      </section>;
    }
    case "Ready":
      return children(recovery.state, recovery.row);
  }
}
