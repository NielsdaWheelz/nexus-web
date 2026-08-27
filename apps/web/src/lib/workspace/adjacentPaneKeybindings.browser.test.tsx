import { render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { installWorkspaceSessionBff } from "@/__tests__/helpers/workspaceSessionBff";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { useAdjacentPaneKeybindings } from "@/lib/workspace/adjacentPaneKeybindings";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createEmptyPaneHistory,
  createPaneVisit,
  createWorkspaceStateFromPrimaryPanes,
  type WorkspacePrimaryPaneState,
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
const lastPane = primaryPane({
  id: "pane-last",
  href: "/conversations",
  visibility: "visible",
});

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

function AdjacentPaneKeybindingsProbe() {
  const { state } = useWorkspaceStore();
  const [activatedPaneIds, setActivatedPaneIds] = useState<readonly string[]>(
    [],
  );
  const recordActivation = useCallback((paneId: string) => {
    setActivatedPaneIds((current) => [...current, paneId]);
  }, []);
  useAdjacentPaneKeybindings({ onActivated: recordActivation });

  return (
    <>
      <input aria-label="Editable pane field" />
      <button type="button">Workspace keyboard target</button>
      <section role="dialog" aria-label="Nexus">
        <button type="button">Nexus keyboard target</button>
      </section>
      <output aria-label="Active pane">{state.activePrimaryPaneId}</output>
      <output aria-label="Activated panes">
        {activatedPaneIds.join(",")}
      </output>
    </>
  );
}

function renderKeybindingsProbe() {
  window.history.replaceState({}, "", firstPane.currentVisit.href);
  return render(
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <PaneReturnMementoProvider>
            <WorkspaceStoreProvider
              initialState={createWorkspaceStateFromPrimaryPanes({
                activePrimaryPaneId: firstPane.id,
                primaryPanes: [firstPane, minimizedPane, lastPane],
              })}
              workspacePrimaryMetrics={workspacePrimaryMetrics}
            >
              <AdjacentPaneKeybindingsProbe />
            </WorkspaceStoreProvider>
          </PaneReturnMementoProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
    ),
  );
}

async function pressPaneArrowKey(input: {
  readonly key: "ArrowLeft" | "ArrowRight";
  readonly modifiers?: "Adjacent" | "Plain";
  readonly preventBeforeHook?: boolean;
}): Promise<boolean> {
  let observedDefaultPrevented: boolean | null = null;
  const modifiers = input.modifiers ?? "Adjacent";
  const isObservedEvent = (event: KeyboardEvent) =>
    event.key === input.key &&
    (modifiers === "Adjacent"
      ? event.metaKey && event.shiftKey
      : !event.metaKey && !event.shiftKey);
  const preventBeforeHook = (event: KeyboardEvent) => {
    if (isObservedEvent(event)) {
      event.preventDefault();
    }
  };
  const observeAfterHook = (event: KeyboardEvent) => {
    if (isObservedEvent(event)) {
      observedDefaultPrevented = event.defaultPrevented;
    }
  };
  if (input.preventBeforeHook) {
    document.addEventListener("keydown", preventBeforeHook, true);
  }
  document.addEventListener("keydown", observeAfterHook);
  try {
    await userEvent.keyboard(
      modifiers === "Adjacent"
        ? `{Meta>}{Shift>}{${input.key}}{/Shift}{/Meta}`
        : `{${input.key}}`,
    );
  } finally {
    if (input.preventBeforeHook) {
      document.removeEventListener("keydown", preventBeforeHook, true);
    }
    document.removeEventListener("keydown", observeAfterHook);
  }
  if (observedDefaultPrevented === null) {
    throw new Error(
      `Browser did not deliver ${modifiers === "Adjacent" ? "Meta+Shift+" : ""}${input.key}`,
    );
  }
  return observedDefaultPrevented;
}

describe("Adjacent pane keybindings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installWorkspaceSessionBff();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips minimized panes, clamps both boundaries, and preserves keyboard arbitration", async () => {
    renderKeybindingsProbe();
    const activePane = screen.getByLabelText("Active pane");
    const activatedPanes = screen.getByLabelText("Activated panes");
    const editableField = screen.getByRole("textbox", {
      name: "Editable pane field",
    });
    const workspaceTarget = screen.getByRole("button", {
      name: "Workspace keyboard target",
    });
    const nexusDialog = screen.getByRole("dialog", { name: "Nexus" });
    const nexusTarget = screen.getByRole("button", {
      name: "Nexus keyboard target",
    });

    await userEvent.click(editableField);
    const editableDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowRight",
    });
    expect(editableDefaultPrevented).toBe(false);
    expect(activePane).toHaveTextContent(firstPane.id);
    expect(activatedPanes).toBeEmptyDOMElement();

    await userEvent.click(workspaceTarget);
    const plainArrowDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowRight",
      modifiers: "Plain",
    });
    expect(plainArrowDefaultPrevented).toBe(false);
    expect(activePane).toHaveTextContent(firstPane.id);
    expect(activatedPanes).toBeEmptyDOMElement();

    const previouslyPreventedDefault = await pressPaneArrowKey({
      key: "ArrowRight",
      preventBeforeHook: true,
    });
    expect(previouslyPreventedDefault).toBe(true);
    expect(activePane).toHaveTextContent(firstPane.id);
    expect(activatedPanes).toBeEmptyDOMElement();

    await userEvent.click(nexusTarget);
    expect(nexusDialog).toBeVisible();
    const nextDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowRight",
    });
    expect(nextDefaultPrevented).toBe(true);
    expect(
      activePane,
      "Nexus-open state incorrectly guarded the workspace Next keybinding",
    ).toHaveTextContent(lastPane.id);
    expect(activatedPanes).toHaveTextContent(lastPane.id);
    expect(nexusDialog).toBeVisible();

    const nextBoundaryDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowRight",
    });
    expect(nextBoundaryDefaultPrevented).toBe(true);
    expect(
      activePane,
      "pane-next wrapped from the final visible pane",
    ).toHaveTextContent(lastPane.id);
    expect(
      activatedPanes.textContent,
      "pane-next emitted an activation at the final visible pane",
    ).toBe(lastPane.id);

    const previousDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowLeft",
    });
    expect(previousDefaultPrevented).toBe(true);
    expect(activePane).toHaveTextContent(firstPane.id);
    expect(activatedPanes.textContent).toBe(
      `${lastPane.id},${firstPane.id}`,
    );

    const previousBoundaryDefaultPrevented = await pressPaneArrowKey({
      key: "ArrowLeft",
    });
    expect(previousBoundaryDefaultPrevented).toBe(true);
    expect(
      activePane,
      "pane-previous wrapped from the first visible pane",
    ).toHaveTextContent(firstPane.id);
    expect(
      activatedPanes.textContent,
      "pane-previous emitted an activation at the first visible pane",
    ).toBe(`${lastPane.id},${firstPane.id}`);
  });
});
