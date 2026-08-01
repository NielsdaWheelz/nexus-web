import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { buildHighlightActions } from "./highlightActions";
import SelectionActionDock from "./SelectionActionDock";

const noop = () => {};

function completeSelectionActions() {
  return buildHighlightActions({
    target: { kind: "selection", color: "yellow" },
    canQuoteToChat: true,
    canAddNote: true,
    isReflowable: false,
    state: {
      isEditingBounds: false,
      deleting: false,
      changingColor: false,
    },
    handlers: {
      onSelectColor: noop,
      onAddNote: noop,
      onLink: noop,
      onShare: noop,
      onLearn: noop,
      onQuoteToNewChat: noop,
      onQuoteToExistingChat: noop,
      onToggleEditBounds: noop,
      onDelete: noop,
    },
  });
}

function DockFixture({
  width,
  mobile,
  showDock = true,
}: {
  width: number;
  mobile: boolean;
  showDock?: boolean;
}) {
  return (
    <>
      <button type="button">Return to passage</button>
      <div
        data-floating-action-surface="true"
        data-mobile={mobile ? "true" : "false"}
        data-compact-width={width < 240 ? "true" : "false"}
        data-reflow-width="false"
        style={{ width }}
      >
        {showDock ? (
          <SelectionActionDock
            actions={completeSelectionActions()}
            pendingActionId={null}
            externalBusy={false}
          />
        ) : null}
      </div>
    </>
  );
}

function renderDock({ width, mobile }: { width: number; mobile: boolean }) {
  return render(
    withRenderEnvironment(
      <DockFixture width={width} mobile={mobile} />,
      { initialViewport: mobile ? "mobile" : "desktop" },
    ),
  );
}

function actionButtons() {
  return within(
    screen.getByRole("toolbar", { name: "Selection actions" }),
  ).getAllByRole("button");
}

describe("selection action dock in Chromium", () => {
  it("exposes one ordered keyboard toolbar and restores its passage entry point", () => {
    const view = renderDock({ width: 800, mobile: false });
    const returnTarget = screen.getByRole("button", {
      name: "Return to passage",
    });
    returnTarget.focus();

    fireEvent.keyDown(window, { key: "F10", altKey: true });
    expect(screen.getByRole("button", { name: "Colour" })).toHaveFocus();
    fireEvent.keyDown(
      screen.getByRole("toolbar", { name: "Selection actions" }),
      { key: "End" },
    );
    expect(
      screen.getByRole("button", { name: "Existing chat" }),
    ).toHaveFocus();
    expect(actionButtons().map((action) => action.textContent)).toEqual([
      "Colour",
      "Note",
      "Link",
      "Share",
      "Learn",
      "New chat",
      "Existing chat",
    ]);
    expect(actionButtons().filter((action) => action.tabIndex === 0)).toHaveLength(
      1,
    );

    view.rerender(
      withRenderEnvironment(
        <DockFixture width={800} mobile={false} showDock={false} />,
      ),
    );
    expect(returnTarget).toHaveFocus();
  });

  it("keeps the mobile 4 + 3 grid and sub-240px two-column grid non-scrolling", () => {
    const view = renderDock({ width: 320, mobile: true });
    let toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    let rects = actionButtons().map((action) => action.getBoundingClientRect());
    expect(new Set(rects.slice(0, 4).map((rect) => rect.top)).size).toBe(1);
    expect(new Set(rects.slice(4).map((rect) => rect.top)).size).toBe(1);
    expect(rects[4]!.top).toBeGreaterThan(rects[0]!.top);
    expect(rects.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
      true,
    );
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    view.unmount();

    renderDock({ width: 220, mobile: true });
    toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    rects = actionButtons().map((action) => action.getBoundingClientRect());
    expect(rects[0]!.top).toBe(rects[1]!.top);
    expect(rects[2]!.top).toBeGreaterThan(rects[0]!.top);
    expect(rects.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
      true,
    );
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
  });
});
