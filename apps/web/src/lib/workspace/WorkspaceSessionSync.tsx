"use client";

import { useEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useWorkspaceStore } from "./store";
import { useWorkspaceSession } from "./useWorkspaceSession";
import type { PendingWorkspaceSession } from "./sessionStore";

const FEEDBACK_KEY = "workspace-session-save";

export default function WorkspaceSessionSync({ accountId, recovered }: {
  accountId: string; recovered: PendingWorkspaceSession | null;
}) {
  const { state } = useWorkspaceStore();
  const { persistence, retry } = useWorkspaceSession(state, true, accountId, recovered);
  const { publish, resolve } = useFeedback();
  useEffect(() => {
    if (persistence.kind === "LocalFailure" || persistence.kind === "SyncFailure") {
      publish({
        kind: "Persistent", key: FEEDBACK_KEY, announcement: "Polite",
        content: {
          tone: "Warning",
          title: persistence.kind === "LocalFailure"
            ? "Workspace layout has not been saved on this device."
            : "Workspace layout is saved on this device; sync is pending.",
        },
        actions: [{ label: "Retry saving layout", onClick: retry }],
      });
    } else {
      resolve(FEEDBACK_KEY);
    }
  }, [persistence, publish, resolve, retry]);
  useEffect(() => () => resolve(FEEDBACK_KEY), [resolve]);
  return null;
}
