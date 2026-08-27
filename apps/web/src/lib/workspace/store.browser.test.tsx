import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWorkspaceSessionBff } from "@/__tests__/helpers/workspaceSessionBff";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneVisit,
  createWorkspaceStateFromPrimaryPanes,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
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
type PendingActivateAdjacentPane = (input: {
  readonly direction: "Previous" | "Next";
}) =>
  | { readonly kind: "Activated"; readonly paneId: string }
  | { readonly kind: "Unchanged" };

let currentStore: WorkspaceStore | null = null;
let childMounts = 0;

function EphemeralPaneChild() {
  currentStore = useWorkspaceStore();
  useEffect(() => {
    childMounts += 1;
  }, []);
  return <input aria-label="Ephemeral pane draft" defaultValue="" />;
}

function primaryPane(input: {
  readonly id: string;
  readonly href: string;
  readonly visibility: WorkspacePrimaryPaneState["visibility"];
}): WorkspacePrimaryPaneState {
  return {
    id: input.id,
    currentVisit: createPaneVisit(input.href),
    primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
    visibility: input.visibility,
    history: createEmptyPaneHistory(),
    attachedSecondaryPaneId: null,
  };
}

function renderWorkspace(initialState: WorkspaceState) {
  window.history.replaceState(
    {},
    "",
    initialState.primaryPanesById[initialState.activePrimaryPaneId].currentVisit
      .href,
  );
  return render(
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <WorkspaceStoreProvider
          initialState={initialState}
          workspacePrimaryMetrics={workspacePrimaryMetrics}
        >
          <EphemeralPaneChild />
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>
    </FeedbackProvider>,
  );
}

function renderActivePane() {
  renderWorkspace(
    createDefaultWorkspaceState("/libraries", workspacePrimaryMetrics),
  );
}

function pendingActivateAdjacentPane(
  store: WorkspaceStore,
): PendingActivateAdjacentPane | undefined {
  // justify-type-assertion: BASE sensitivity overlays this proof onto the
  // revision before the public command exists, where absence must stay a
  // behavioral undefined result instead of becoming a setup exception.
  return (
    store as WorkspaceStore & {
      readonly activateAdjacentPane?: PendingActivateAdjacentPane;
    }
  ).activateAdjacentPane;
}

beforeEach(() => {
  currentStore = null;
  childMounts = 0;
  window.localStorage.clear();
  installWorkspaceSessionBff();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workspace active-pane identity", () => {
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

describe("Workspace adjacent-pane activation", () => {
  it("linearizes exact and adjacent activation, follows stable visible order, and clamps both boundaries", () => {
    const firstPane = primaryPane({
      id: "pane-first",
      href: "/libraries",
      visibility: "visible",
    });
    const minimizedPane = primaryPane({
      id: "pane-minimized",
      href: "/notes",
      visibility: "minimized",
    });
    const thirdPane = primaryPane({
      id: "pane-third",
      href: "/conversations",
      visibility: "visible",
    });
    const fourthPane = primaryPane({
      id: "pane-fourth",
      href: "/lectern",
      visibility: "visible",
    });
    renderWorkspace(
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: [firstPane, minimizedPane, thirdPane, fourthPane],
      }),
    );

    const store = currentStore;
    if (!store) throw new Error("Workspace store did not mount");
    const activateAdjacent = pendingActivateAdjacentPane(store);
    let nextResults: readonly unknown[] = [];
    let nextProjectedPaths: readonly (string | undefined)[] = [];
    act(() => {
      const firstResult = activateAdjacent?.({ direction: "Next" });
      const firstProjectedPath = activateAdjacent
        ? window.location.pathname
        : undefined;
      const secondResult = activateAdjacent?.({ direction: "Next" });
      const secondProjectedPath = activateAdjacent
        ? window.location.pathname
        : undefined;
      nextResults = [firstResult, secondResult];
      nextProjectedPaths = [firstProjectedPath, secondProjectedPath];
    });

    expect(
      nextResults,
      "Two rapid Next commands did not skip the minimized pane and reduce sequentially",
    ).toEqual([
      { kind: "Activated", paneId: thirdPane.id },
      { kind: "Activated", paneId: fourthPane.id },
    ]);
    expect(
      nextProjectedPaths,
      "Rapid Next commands did not synchronously project each activated pane URL",
    ).toEqual([
      thirdPane.currentVisit.href,
      fourthPane.currentVisit.href,
    ]);
    expect(currentStore?.state.activePrimaryPaneId).toBe(fourthPane.id);

    let nextBoundaryResult: unknown;
    act(() => {
      nextBoundaryResult = activateAdjacent?.({ direction: "Next" });
    });
    expect(
      nextBoundaryResult,
      "Next at the final visible pane did not clamp",
    ).toEqual({ kind: "Unchanged" });
    expect(currentStore?.state.activePrimaryPaneId).toBe(fourthPane.id);

    let previousResults: readonly unknown[] = [];
    let previousProjectedPaths: readonly (string | undefined)[] = [];
    act(() => {
      const firstResult = activateAdjacent?.({ direction: "Previous" });
      const firstProjectedPath = activateAdjacent
        ? window.location.pathname
        : undefined;
      const secondResult = activateAdjacent?.({ direction: "Previous" });
      const secondProjectedPath = activateAdjacent
        ? window.location.pathname
        : undefined;
      previousResults = [firstResult, secondResult];
      previousProjectedPaths = [firstProjectedPath, secondProjectedPath];
    });
    expect(previousResults).toEqual([
      { kind: "Activated", paneId: thirdPane.id },
      { kind: "Activated", paneId: firstPane.id },
    ]);
    expect(
      previousProjectedPaths,
      "Rapid Previous commands did not synchronously project each activated pane URL",
    ).toEqual([
      thirdPane.currentVisit.href,
      firstPane.currentVisit.href,
    ]);
    expect(currentStore?.state.activePrimaryPaneId).toBe(firstPane.id);

    let previousBoundaryResult: unknown;
    act(() => {
      previousBoundaryResult = activateAdjacent?.({ direction: "Previous" });
    });
    expect(
      previousBoundaryResult,
      "Previous at the first visible pane did not clamp",
    ).toEqual({ kind: "Unchanged" });
    expect(currentStore?.state.activePrimaryPaneId).toBe(firstPane.id);

    let exactThenAdjacentResult: unknown;
    let exactThenAdjacentProjectedPaths: readonly (string | undefined)[] = [];
    act(() => {
      store.activatePane(thirdPane.id);
      const exactProjectedPath = window.location.pathname;
      exactThenAdjacentResult = activateAdjacent?.({ direction: "Next" });
      const adjacentProjectedPath = activateAdjacent
        ? window.location.pathname
        : undefined;
      exactThenAdjacentProjectedPaths = [
        exactProjectedPath,
        adjacentProjectedPath,
      ];
    });
    expect(
      exactThenAdjacentProjectedPaths,
      "Exact then adjacent activation did not synchronously project each URL in one React batch",
    ).toEqual([thirdPane.currentVisit.href, fourthPane.currentVisit.href]);
    expect(
      exactThenAdjacentResult,
      "Adjacent activation did not reduce from the exact activation committed earlier in the same React batch",
    ).toEqual({ kind: "Activated", paneId: fourthPane.id });
    expect(currentStore?.state.activePrimaryPaneId).toBe(fourthPane.id);
  });

  it("leaves a one-pane workspace unchanged", () => {
    const onlyPane = primaryPane({
      id: "pane-only",
      href: "/libraries",
      visibility: "visible",
    });
    renderWorkspace(
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: onlyPane.id,
        primaryPanes: [onlyPane],
      }),
    );

    const store = currentStore;
    if (!store) throw new Error("Workspace store did not mount");
    const activateAdjacent = pendingActivateAdjacentPane(store);
    let result: unknown;
    act(() => {
      result = activateAdjacent?.({ direction: "Next" });
    });

    expect(result, "A one-pane workspace accepted an adjacent command").toEqual({
      kind: "Unchanged",
    });
    expect(currentStore?.state.activePrimaryPaneId).toBe(onlyPane.id);
  });
});
