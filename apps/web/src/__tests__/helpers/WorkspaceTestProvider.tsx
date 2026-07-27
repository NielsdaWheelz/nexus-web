import type { ReactNode } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

export function WorkspaceTestProvider({ children }: { children: ReactNode }) {
  return (
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <WorkspaceStoreProvider
          workspacePrimaryMetrics={workspacePrimaryMetrics}
          initialState={createDefaultWorkspaceState(
            "/lectern",
            workspacePrimaryMetrics,
          )}
        >
          {children}
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>
    </FeedbackProvider>
  );
}
