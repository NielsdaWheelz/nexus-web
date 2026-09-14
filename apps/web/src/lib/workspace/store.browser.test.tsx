import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>;

let currentStore: WorkspaceStore | null = null;
let childMounts = 0;

function EphemeralPaneChild() {
  currentStore = useWorkspaceStore();
  useEffect(() => {
    childMounts += 1;
  }, []);
  return <input aria-label="Ephemeral pane draft" defaultValue="" />;
}

function renderActivePane() {
  const href = "/libraries";
  window.history.replaceState({}, "", href);
  render(
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <WorkspaceStoreProvider
          initialState={createDefaultWorkspaceState(
            href,
            workspacePrimaryMetrics,
          )}
          workspacePrimaryMetrics={workspacePrimaryMetrics}
        >
          <EphemeralPaneChild />
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>
    </FeedbackProvider>,
  );
}

describe("Workspace active-pane identity", () => {
  beforeEach(() => {
    currentStore = null;
    childMounts = 0;
    window.localStorage.clear();
  });

  it("preserves a focused ephemeral child when the active pane is reactivated", async () => {
    renderActivePane();
    const input = screen.getByRole("textbox", {
      name: "Ephemeral pane draft",
    });
    await userEvent.click(input);
    await userEvent.type(input, "unsaved thought");
    expect(input).toHaveFocus();

    const store = currentStore;
    if (!store) throw new Error("Workspace store did not mount");
    const activePaneId = store.state.activePrimaryPaneId;

    act(() => {
      store.activatePane(store.state.activePrimaryPaneId);
    });

    expect(
      screen.getByRole("textbox", { name: "Ephemeral pane draft" }),
    ).toBe(input);
    expect(input).toHaveValue("unsaved thought");
    expect(input).toHaveFocus();
    expect(
      childMounts,
      "Reactivating the active pane remounted its ephemeral child",
    ).toBe(1);
    expect(
      currentStore?.state.activePrimaryPaneId,
      "Reactivating the active pane changed its durable identity",
    ).toBe(activePaneId);
  });
});
