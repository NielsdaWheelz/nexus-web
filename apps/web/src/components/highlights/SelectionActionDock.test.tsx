import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { buildHighlightActions } from "./highlightActions";
import SelectionActionDock from "./SelectionActionDock";

function selectionActions({
  onSelect = vi.fn(),
  note = true,
  link = true,
  share = true,
  learn = true,
  chat = true,
  changingColor = false,
}: {
  onSelect?: () => void;
  note?: boolean;
  link?: boolean;
  share?: boolean;
  learn?: boolean;
  chat?: boolean;
  changingColor?: boolean;
} = {}) {
  const chatHandlers = chat
    ? {
        onQuoteToNewChat: onSelect,
        onQuoteToExistingChat: onSelect,
      }
    : {};

  return buildHighlightActions({
    target: { kind: "selection", color: "yellow" },
    canQuoteToChat: chat,
    canAddNote: note,
    isReflowable: false,
    state: {
      isEditingBounds: false,
      deleting: false,
      changingColor,
    },
    handlers: {
      onSelectColor: onSelect,
      onAddNote: note ? onSelect : undefined,
      onLink: link ? onSelect : undefined,
      onShare: share ? onSelect : undefined,
      onLearn: learn ? onSelect : undefined,
      ...chatHandlers,
      onToggleEditBounds: vi.fn(),
      onDelete: vi.fn(),
    },
  });
}

function renderDock({
  width = 800,
  mobile = false,
  capabilities,
  pendingActionId = null,
  externalBusy = false,
}: {
  width?: number;
  mobile?: boolean;
  capabilities?: {
    note: boolean;
    link: boolean;
    share: boolean;
    learn: boolean;
    chat: boolean;
  };
  pendingActionId?:
    "color" | "share" | "learn" | "quote-new" | "quote-existing" | null;
  externalBusy?: boolean;
} = {}) {
  const onSelect = vi.fn();
  const renderNode = (
    nextPendingActionId:
      | "color"
      | "share"
      | "learn"
      | "quote-new"
      | "quote-existing"
      | null,
  ) =>
    withRenderEnvironment(
      <div
        data-floating-action-surface="true"
        data-mobile={mobile ? "true" : "false"}
        data-compact-width={width < 240 ? "true" : "false"}
        style={{ width }}
      >
        <SelectionActionDock
          actions={selectionActions({
            onSelect,
            ...capabilities,
            changingColor: externalBusy,
          })}
          pendingActionId={nextPendingActionId}
          externalBusy={externalBusy}
        />
      </div>,
      { initialViewport: mobile ? "mobile" : "desktop" },
    );
  const view = render(renderNode(pendingActionId));
  return {
    ...view,
    onSelect,
    rerenderDock: (nextPendingActionId: Parameters<typeof renderNode>[0]) =>
      view.rerender(renderNode(nextPendingActionId)),
  };
}

function actionButtons(toolbar: HTMLElement): HTMLElement[] {
  return within(toolbar).getAllByRole("button");
}

describe("SelectionActionDock", () => {
  it("renders the seven visible actions, toolbar semantics, and authored grouping", () => {
    renderDock();

    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
    expect(toolbar).toHaveAttribute("aria-keyshortcuts", "Alt+F10");
    expect(actionButtons(toolbar).map((action) => action.textContent)).toEqual([
      "Colour",
      "Note",
      "Link",
      "Share",
      "Learn",
      "New chat",
      "Existing chat",
    ]);
    // Separators are intentionally aria-hidden; their authored grouping is a
    // visual DOM contract rather than an accessible query target.
    // eslint-disable-next-line testing-library/no-node-access
    const separators = toolbar.querySelectorAll("[data-selection-separator]");
    expect(separators).toHaveLength(2);
    expect(
      actionButtons(toolbar).filter((action) => action.tabIndex === 0),
    ).toHaveLength(1);
  });

  it("offers Alt+F10 and non-wrapping roving focus, then restores prior focus on removal", () => {
    render(<button type="button">Reader passage</button>);
    const passage = screen.getByRole("button", { name: "Reader passage" });
    passage.focus();

    const view = render(
      withRenderEnvironment(
        <SelectionActionDock
          actions={selectionActions()}
          pendingActionId={null}
          externalBusy={false}
        />,
      ),
    );

    fireEvent.keyDown(window, { key: "F10", altKey: true });
    const colour = screen.getByRole("button", { name: "Colour" });
    const note = screen.getByRole("button", { name: "Note" });
    const existing = screen.getByRole("button", { name: "Existing chat" });
    expect(colour).toHaveFocus();

    fireEvent.keyDown(window, { key: "F10", altKey: true });
    expect(colour).toHaveFocus();
    fireEvent.keyDown(colour, { key: "ArrowRight" });
    expect(note).toHaveFocus();
    fireEvent.keyDown(note, { key: "End" });
    expect(existing).toHaveFocus();
    fireEvent.keyDown(existing, { key: "ArrowRight" });
    expect(existing).toHaveFocus();
    fireEvent.keyDown(existing, { key: "Home" });
    expect(colour).toHaveFocus();

    view.unmount();
    expect(passage).toHaveFocus();
  });

  it("keeps a pending action focusable, visibly busy, and inert", () => {
    const { onSelect } = renderDock({ pendingActionId: "quote-existing" });
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const existing = screen.getByRole("button", { name: "Existing chat" });

    expect(existing).toHaveAttribute("aria-disabled", "true");
    expect(existing).toHaveAttribute("aria-busy", "true");
    expect(toolbar).toHaveAttribute("aria-busy", "true");
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe("Existing chat in progress");
    fireEvent.click(existing);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("announces external creation once without inventing a pending action", () => {
    const { onSelect } = renderDock({ externalBusy: true });
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const actions = actionButtons(toolbar);

    expect(toolbar).toHaveAttribute("aria-busy", "true");
    expect(actions).toHaveLength(7);
    expect(
      actions.every(
        (action) => action.getAttribute("aria-disabled") === "true",
      ),
    ).toBe(true);
    expect(actions.every((action) => !action.hasAttribute("aria-busy"))).toBe(
      true,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe("Selection action in progress");

    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps action and toolbar rectangles stable while an action becomes pending", () => {
    const { rerenderDock } = renderDock();
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const snapshot = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const toolbarBefore = snapshot(toolbar);
    const actionsBefore = actionButtons(toolbar).map(snapshot);

    rerenderDock("quote-existing");

    expect(snapshot(toolbar)).toEqual(toolbarBefore);
    expect(actionButtons(toolbar).map(snapshot)).toEqual(actionsBefore);
    const pendingAction = screen.getByRole("button", {
      name: "Existing chat",
    });
    expect(pendingAction).toHaveAttribute("aria-busy", "true");
    expect(within(pendingAction).getByText("Existing chat")).toBeVisible();
    // eslint-disable-next-line testing-library/no-node-access
    const busyIndicator = pendingAction.querySelector<HTMLElement>(
      '[data-selection-busy-indicator="true"]',
    );
    expect(busyIndicator).not.toBeNull();
    expect(busyIndicator!.getBoundingClientRect().right).toBeLessThanOrEqual(
      within(pendingAction).getByText("Existing chat").getBoundingClientRect()
        .left,
    );
  });

  it("closes the nested colour disclosure on Escape and restores its trigger", async () => {
    const user = userEvent.setup();
    renderDock();

    const colour = screen.getByRole("button", { name: "Colour" });
    await user.click(colour);
    const blue = await screen.findByRole("button", { name: "Blue" });
    expect(blue.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(blue.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const pointerDown = createEvent.pointerDown(blue);
    fireEvent(blue, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Blue" })).toBeNull();
    expect(colour).toHaveFocus();
  });

  it("does not reuse keyboard focus intent when Colour is reopened by pointer", async () => {
    const user = userEvent.setup();
    render(<button type="button">Reader passage</button>);
    const passage = screen.getByRole("button", { name: "Reader passage" });
    passage.focus();

    renderDock();
    fireEvent.keyDown(window, { key: "F10", altKey: true });
    const colour = screen.getByRole("button", { name: "Colour" });
    expect(colour).toHaveFocus();

    await user.keyboard("{Enter}");
    const selectedSwatch = await screen.findByRole("button", {
      name: "Yellow (selected)",
    });
    await vi.waitFor(() => expect(selectedSwatch).toHaveFocus());

    colour.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("button", { name: "Yellow (selected)" }),
    ).toBeNull();

    passage.focus();
    fireEvent.click(colour, { detail: 1 });
    const pointerOpenedSwatch = await screen.findByRole("button", {
      name: "Yellow (selected)",
    });
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    expect(passage).toHaveFocus();
    expect(pointerOpenedSwatch).not.toHaveFocus();
  });

  it("preserves semantic swatches and distinct selected/focus signals in forced colors", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    try {
      const user = userEvent.setup();
      renderDock();
      const colour = screen.getByRole("button", { name: "Colour" });
      colour.focus();
      await user.keyboard("{Enter}");
      const yellow = screen.getByRole("button", {
        name: "Yellow (selected)",
      });
      const green = screen.getByRole("button", { name: "Green" });
      const blue = screen.getByRole("button", { name: "Blue" });

      green.focus();

      expect(green).toHaveFocus();
      const yellowStyle = getComputedStyle(yellow);
      const greenStyle = getComputedStyle(green);
      const blueStyle = getComputedStyle(blue);
      expect(yellowStyle.forcedColorAdjust).toBe("none");
      expect(yellowStyle.backgroundColor).not.toBe(blueStyle.backgroundColor);
      expect(yellowStyle.borderStyle).toBe("solid");
      expect(yellowStyle.outlineStyle).toBe("double");
      expect(greenStyle.outlineStyle).toBe("solid");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "forced-colors", value: "none" }],
      });
    }
  });

  it("removes swatch transition and hover transform under reduced motion", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      const user = userEvent.setup();
      renderDock();
      await user.click(screen.getByRole("button", { name: "Colour" }));
      const blue = screen.getByRole("button", { name: "Blue" });
      await user.hover(blue);

      const style = getComputedStyle(blue);
      expect(style.transitionDuration).toBe("0s");
      expect(style.transform).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "no-preference" },
        ],
      });
    }
  });

  it("projects one desktop row and a non-scrolling mobile 4 + 3 grid", () => {
    const { unmount } = renderDock({ width: 800 });
    let toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    let rects = actionButtons(toolbar).map((action) =>
      action.getBoundingClientRect(),
    );
    expect(new Set(rects.map((rect) => rect.top)).size).toBe(1);
    expect(rects.every((rect) => rect.height >= 44)).toBe(true);
    unmount();

    renderDock({ width: 320, mobile: true });
    toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    rects = actionButtons(toolbar).map((action) =>
      action.getBoundingClientRect(),
    );
    expect(new Set(rects.slice(0, 4).map((rect) => rect.top)).size).toBe(1);
    expect(new Set(rects.slice(4).map((rect) => rect.top)).size).toBe(1);
    expect(rects[4]?.top).toBeGreaterThan(rects[0]?.top ?? 0);
    expect(rects.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
      true,
    );
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
  });

  it("balances capability-gated two-, five-, and six-action mobile projections", () => {
    const cases = [
      {
        labels: ["Colour", "Note"],
        rows: [2],
        capabilities: {
          note: true,
          link: false,
          share: false,
          learn: false,
          chat: false,
        },
      },
      {
        labels: ["Colour", "Note", "Link", "Share", "Learn"],
        rows: [3, 2],
        capabilities: {
          note: true,
          link: true,
          share: true,
          learn: true,
          chat: false,
        },
      },
      {
        labels: [
          "Colour",
          "Note",
          "Link",
          "Share",
          "New chat",
          "Existing chat",
        ],
        rows: [3, 3],
        capabilities: {
          note: true,
          link: true,
          share: true,
          learn: false,
          chat: true,
        },
      },
    ];

    for (const { labels, rows, capabilities } of cases) {
      const { unmount } = renderDock({
        width: 320,
        mobile: true,
        capabilities,
      });
      const toolbar = screen.getByRole("toolbar", {
        name: "Selection actions",
      });
      expect(actionButtons(toolbar).map((action) => action.textContent)).toEqual(
        labels,
      );
      const rects = actionButtons(toolbar).map((action) =>
        action.getBoundingClientRect(),
      );
      let offset = 0;
      for (const rowLength of rows) {
        const row = rects.slice(offset, offset + rowLength);
        expect(new Set(row.map((rect) => rect.top)).size).toBe(1);
        expect(row[0]?.left).toBeCloseTo(toolbar.getBoundingClientRect().left);
        expect(row.at(-1)?.right).toBeCloseTo(
          toolbar.getBoundingClientRect().right,
        );
        offset += rowLength;
      }
      expect(new Set(rects.map((rect) => rect.top)).size).toBe(rows.length);
      expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
      unmount();
    }
  });

  it("keeps mobile colour targets at least 48px", async () => {
    const user = userEvent.setup();
    renderDock({ width: 320, mobile: true });

    await user.click(screen.getByRole("button", { name: "Colour" }));
    const blue = await screen.findByRole("button", { name: "Blue" });
    await vi.waitFor(() => {
      expect(blue.getBoundingClientRect().width).toBeGreaterThanOrEqual(48);
      expect(blue.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
      expect(blue.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        screen
          .getByRole("button", { name: "Existing chat" })
          .getBoundingClientRect().bottom,
      );
    });
  });

  it("reflows the mobile dock to two columns below 240px without shrinking targets", () => {
    renderDock({ width: 220, mobile: true });
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const rects = actionButtons(toolbar).map((action) =>
      action.getBoundingClientRect(),
    );

    expect(rects[0]?.top).toBe(rects[1]?.top);
    expect(rects[2]?.top).toBeGreaterThan(rects[0]?.top ?? 0);
    expect(rects.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
      true,
    );
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
  });
});
