import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode, RefObject } from "react";
import { userEvent } from "vitest/browser";
import "@/app/globals.css";
import SelectionPopover from "@/components/SelectionPopover";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { fetchShareSnapshot } from "@/lib/sharing/api";
import {
  useMobileViewport,
  type MobileViewportCapability,
} from "@/lib/mobileViewport/MobileViewportProvider";

vi.mock("@/lib/sharing/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sharing/api")>(
      "@/lib/sharing/api",
    );
  return {
    ...actual,
    fetchShareSnapshot: vi.fn(),
  };
});

const fetchShareSnapshotMock = vi.mocked(fetchShareSnapshot);

let mobileViewport = false;
let mobileViewportCapability: MobileViewportCapability | null = null;
const viewportListeners = new Set<EventListenerOrEventListenerObject>();

function MobileViewportCapabilityProbe() {
  mobileViewportCapability = useMobileViewport();
  return null;
}

function renderSelectionPopover(node: ReactNode) {
  return render(
    withRenderEnvironment(
      <ShareControllerProvider>
        <MobileViewportCapabilityProbe />
        {node}
      </ShareControllerProvider>,
      { initialViewport: mobileViewport ? "mobile" : "desktop" },
    ),
  );
}

function createContainerRef(
  rect: DOMRect = new DOMRect(0, 0, 1280, 900),
): RefObject<HTMLElement | null> {
  const container = document.createElement("div");
  container.getBoundingClientRect = vi.fn(() => rect);
  return { current: container };
}

function setViewport(width: number, height: number) {
  mobileViewport = width <= 768;
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  const event = new Event("change");
  for (const listener of viewportListeners) {
    if (typeof listener === "function") listener(event);
    else listener.handleEvent(event);
  }
  window.dispatchEvent(new Event("resize"));
}

function mockVisualViewport({
  offsetLeft = 0,
  offsetTop = 0,
  width = window.innerWidth,
  height = window.innerHeight,
}: {
  offsetLeft?: number;
  offsetTop?: number;
  width?: number;
  height?: number;
} = {}) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();

  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      offsetLeft,
      offsetTop,
      width,
      height,
      addEventListener,
      removeEventListener,
    },
  });
}

function mockPopoverRect(rect: DOMRect) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.floatingActionSurface === "true") {
        return rect;
      }
      return new DOMRect(0, 0, 0, 0);
    });
}

function selectionSurface(): HTMLElement {
  const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
  // The geometry contract lives on the role-free positioning parent.
  // eslint-disable-next-line testing-library/no-node-access
  const surface = toolbar.closest<HTMLElement>(
    '[data-floating-action-surface="true"]',
  );
  if (!surface)
    throw new Error("Selection toolbar is missing its floating surface");
  return surface;
}

function readDialogPosition(dialog: HTMLElement): {
  top: number;
  left: number;
} {
  return {
    top: Number.parseFloat(dialog.style.top),
    left: Number.parseFloat(dialog.style.left),
  };
}

function expectPositionWithinViewport(
  dialog: HTMLElement,
  popoverRect: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    offsetLeft?: number;
    offsetTop?: number;
  },
) {
  const { top, left } = readDialogPosition(dialog);
  const minLeft = (viewport.offsetLeft ?? 0) + 8;
  const minTop = (viewport.offsetTop ?? 0) + 8;
  const maxRight = (viewport.offsetLeft ?? 0) + viewport.width - 8;
  const maxBottom = (viewport.offsetTop ?? 0) + viewport.height - 8;

  expect(left).toBeGreaterThanOrEqual(minLeft);
  expect(top).toBeGreaterThanOrEqual(minTop);
  expect(left + popoverRect.width).toBeLessThanOrEqual(maxRight + 0.5);
  expect(top + popoverRect.height).toBeLessThanOrEqual(maxBottom + 0.5);
}

function expectPositionToTouchViewportEdge(
  dialog: HTMLElement,
  popoverRect: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    offsetLeft?: number;
    offsetTop?: number;
  },
) {
  const { top, left } = readDialogPosition(dialog);
  const minLeft = (viewport.offsetLeft ?? 0) + 8;
  const minTop = (viewport.offsetTop ?? 0) + 8;
  const maxRight = (viewport.offsetLeft ?? 0) + viewport.width - 8;
  const maxBottom = (viewport.offsetTop ?? 0) + viewport.height - 8;

  const touchesEdge =
    Math.abs(left - minLeft) <= 0.5 ||
    Math.abs(top - minTop) <= 0.5 ||
    Math.abs(left + popoverRect.width - maxRight) <= 0.5 ||
    Math.abs(top + popoverRect.height - maxBottom) <= 0.5;

  expect(touchesEdge).toBe(true);
}

describe("SelectionPopover", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    mobileViewport = false;
    viewportListeners.clear();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          get matches() {
            return mobileViewport;
          },
          media: query,
          onchange: null,
          addEventListener: (
            _event: string,
            listener: EventListenerOrEventListenerObject,
          ) => viewportListeners.add(listener),
          removeEventListener: (
            _event: string,
            listener: EventListenerOrEventListenerObject,
          ) => viewportListeners.delete(listener),
          addListener: (listener: EventListenerOrEventListenerObject) =>
            viewportListeners.add(listener),
          removeListener: (listener: EventListenerOrEventListenerObject) =>
            viewportListeners.delete(listener),
          dispatchEvent: () => true,
        }) as unknown as MediaQueryList,
    );
    setViewport(1280, 900);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
    fetchShareSnapshotMock.mockReset();
    fetchShareSnapshotMock.mockImplementation(
      () => new Promise(() => undefined),
    );
  });

  afterEach(() => {
    mobileViewportCapability = null;
    document.documentElement.style.removeProperty(
      "--mobile-content-bottom-clearance",
    );
    vi.stubGlobal("innerWidth", originalInnerWidth);
    vi.stubGlobal("innerHeight", originalInnerHeight);
    window.dispatchEvent(new Event("resize"));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
  });

  it("materializes the Highlight before handing Learn to the pane owner", async () => {
    const highlight = { id: "h-learn" };
    const onCreateHighlight = vi.fn(async () => highlight);
    const onLearn = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onLearn={onLearn}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Learn" }));

    await waitFor(() => {
      expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
      expect(onLearn).toHaveBeenCalledWith(highlight);
    });
  });

  it("shows the seven action names visibly in canonical order", () => {
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={vi.fn()}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Colour",
      "Note",
      "Link",
      "Share",
      "Learn",
      "New chat",
      "Existing chat",
    ]);
  });

  it("announces reader-owned creation once without replacing its actions", () => {
    const onAddNote = vi.fn();
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={onAddNote}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
        isCreating
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const actions = within(toolbar).getAllByRole("button");
    expect(toolbar).toHaveAttribute("aria-busy", "true");
    expect(actions).toHaveLength(7);
    expect(actions.every((action) => action.getAttribute("aria-disabled") === "true"))
      .toBe(true);
    expect(actions.every((action) => !action.hasAttribute("aria-busy"))).toBe(
      true,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe("Selection action in progress");

    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    expect(onAddNote).not.toHaveBeenCalled();
  });

  it("keeps the actual desktop paper surface around the one-row dock", async () => {
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(320, 240, 120, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={vi.fn()}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    const actions = within(toolbar).getAllByRole("button");
    await waitFor(() => {
      const surfaceRect = selectionSurface().getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const actionRects = actions.map((action) =>
        action.getBoundingClientRect(),
      );

      expect(surfaceRect.left).toBeLessThanOrEqual(toolbarRect.left);
      expect(surfaceRect.right).toBeGreaterThanOrEqual(toolbarRect.right);
      expect(surfaceRect.width).toBeGreaterThan(400);
      expect(new Set(actionRects.map((rect) => rect.top)).size).toBe(1);
      expect(
        Math.min(...actionRects.map((rect) => rect.height)),
      ).toBeGreaterThanOrEqual(44);
    });
  });

  it("contains the full compact palette inside a 160x284 visual viewport", async () => {
    setViewport(160, 284);
    mockVisualViewport({ width: 160, height: 284 });
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(48, 104, 64, 24)}
        containerRef={createContainerRef(new DOMRect(0, 0, 160, 284))}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={vi.fn()}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(64);
    });

    const surface = selectionSurface();
    const toolbar = screen.getByRole("toolbar", {
      name: "Selection actions",
    });
    await waitFor(() => expect(surface.style.visibility).not.toBe("hidden"));

    const surfaceRect = surface.getBoundingClientRect();
    expect(surfaceRect.left).toBeGreaterThanOrEqual(8);
    expect(surfaceRect.right).toBeLessThanOrEqual(152);
    expect(surfaceRect.top).toBeGreaterThanOrEqual(8);
    expect(surfaceRect.bottom).toBeLessThanOrEqual(212);
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    expect(toolbar.scrollHeight).toBeGreaterThan(toolbar.clientHeight);
    expect(getComputedStyle(toolbar).overflowY).toBe("auto");
  });

  it("uses the two-column compact projection for a 220px visual viewport classified as desktop", async () => {
    setViewport(1280, 900);
    mockVisualViewport({ width: 220, height: 500 });
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(48, 104, 64, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={vi.fn()}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const surface = selectionSurface();
    const toolbar = screen.getByRole("toolbar", {
      name: "Selection actions",
    });
    await waitFor(() =>
      expect(surface).toHaveAttribute("data-compact-width", "true"),
    );

    expect(surface).toHaveAttribute("data-mobile", "false");
    const surfaceRect = surface.getBoundingClientRect();
    expect(surfaceRect.left).toBeGreaterThanOrEqual(8);
    expect(surfaceRect.right).toBeLessThanOrEqual(212);
    const actions = within(toolbar).getAllByRole("button");
    await waitFor(() => {
      const rects = actions.map((action) => action.getBoundingClientRect());
      expect(rects[0]?.top).toBe(rects[1]?.top);
      expect(rects[2]?.top).toBeGreaterThan(rects[0]?.top ?? 0);
      expect(rects.every((rect) => rect.width >= 48 && rect.height >= 48)).toBe(
        true,
      );
    });
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
  });

  it("reflows the real desktop dock inside a 200%-equivalent visual viewport", async () => {
    setViewport(1280, 800);
    mockVisualViewport({ width: 400, height: 400 });
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 180, 120, 24)}
        containerRef={createContainerRef(new DOMRect(0, 0, 400, 800))}
        onCreateHighlight={vi.fn()}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={vi.fn()}
        onAddNote={vi.fn()}
        onLink={vi.fn()}
        onLearn={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const surface = selectionSurface();
    const toolbar = screen.getByRole("toolbar", {
      name: "Selection actions",
    });
    await waitFor(() => expect(surface.style.visibility).not.toBe("hidden"));

    const surfaceRect = surface.getBoundingClientRect();
    const actions = within(toolbar).getAllByRole("button");
    const actionRects = actions.map((action) =>
      action.getBoundingClientRect(),
    );
    expect(actions.map((action) => action.textContent)).toEqual([
      "Colour",
      "Note",
      "Link",
      "Share",
      "Learn",
      "New chat",
      "Existing chat",
    ]);
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    expect(surfaceRect.left).toBeGreaterThanOrEqual(8);
    expect(surfaceRect.right).toBeLessThanOrEqual(392);
    expect(
      actionRects.every(
        (rect) =>
          rect.left >= surfaceRect.left && rect.right <= surfaceRect.right,
      ),
    ).toBe(true);
    expect(new Set(actionRects.map((rect) => rect.top)).size).toBe(2);
    expect(new Set(actionRects.slice(0, 4).map((rect) => rect.top)).size).toBe(1);
    expect(new Set(actionRects.slice(4).map((rect) => rect.top)).size).toBe(1);
    expect(actionRects[4]?.top).toBeGreaterThan(actionRects[0]?.top ?? 0);
  });

  it("admits at most one same-turn highlight-first action", async () => {
    let resolveHighlight: ((highlight: { id: string }) => void) | undefined;
    const onCreateHighlight = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveHighlight = resolve;
        }),
    );
    const onQuoteToNewChat = vi.fn();
    const onLearn = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={vi.fn()}
        onLearn={onLearn}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const toolbar = screen.getByRole("toolbar", { name: "Selection actions" });
    expect(toolbar).toHaveAttribute("aria-busy", "true");
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe("New chat in progress");
    fireEvent.click(screen.getByRole("button", { name: "Learn" }));

    expect(onCreateHighlight).toHaveBeenCalledTimes(1);
    resolveHighlight?.({ id: "h1" });
    await waitFor(() => expect(onQuoteToNewChat).toHaveBeenCalledTimes(1));
    expect(onLearn).not.toHaveBeenCalled();
  });

  it("releases the action lock after a null creation result so selection can retry", async () => {
    const highlight = { id: "h-retry" };
    const onCreateHighlight = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(highlight);
    const onLearn = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onLearn={onLearn}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Learn" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Learn" })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Learn" }));

    await waitFor(() => expect(onLearn).toHaveBeenCalledWith(highlight));
    expect(onCreateHighlight).toHaveBeenCalledTimes(2);
  });

  it("creates a highlight in the picked color, separate from chat actions", async () => {
    const highlight = { id: "h1" };
    const onCreateHighlight = vi.fn(async () => highlight);
    const onQuoteToNewChat = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Colour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Blue" }));
    expect(onCreateHighlight).toHaveBeenCalledWith("blue");
    expect(onQuoteToNewChat).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "New chat" }),
      ).not.toHaveAttribute("aria-disabled"),
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
    await waitFor(() => {
      expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
    });
  });

  it("creates the highlight then passes that same highlight to the quote verb", async () => {
    const highlight = { id: "h1" };
    const onCreateHighlight = vi.fn(async () => highlight);
    const onQuoteToNewChat = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
    await waitFor(() => {
      expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
    });
    expect(onQuoteToNewChat.mock.calls[0][0]).toBe(highlight);
  });

  it("does not run the quote verb when highlight creation returns null", async () => {
    const onCreateHighlight = vi.fn(async () => null);
    const onQuoteToNewChat = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => {
      expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onQuoteToNewChat).not.toHaveBeenCalled();
  });

  it("creates before opening Share and targets the exact created Highlight", async () => {
    let resolveHighlight: ((highlight: { id: string }) => void) | undefined;
    const onCreateHighlight = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveHighlight = resolve;
        }),
    );

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
    expect(fetchShareSnapshotMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull();

    resolveHighlight?.({ id: "11111111-1111-4111-8111-111111111111" });

    await waitFor(() => {
      expect(fetchShareSnapshotMock).toHaveBeenCalledWith(
        "highlight:11111111-1111-4111-8111-111111111111",
        expect.any(AbortSignal),
      );
      expect(screen.getByRole("dialog", { name: "Share" })).toBeVisible();
    });
  });

  it("does not open Share when Highlight creation is cancelled", async () => {
    const onCreateHighlight = vi.fn(async () => null);

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share" })).not.toHaveAttribute(
        "aria-busy",
      ),
    );

    expect(fetchShareSnapshotMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull();
  });

  it("creates before opening Existing chat and passes the exact Highlight", async () => {
    let resolveHighlight: ((highlight: { id: string }) => void) | undefined;
    const onCreateHighlight = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveHighlight = resolve;
        }),
    );
    const onQuoteToNewChat = vi.fn();
    const onQuoteToExistingChat = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={onQuoteToExistingChat}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Existing chat" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("yellow");
    expect(onQuoteToExistingChat).not.toHaveBeenCalled();
    resolveHighlight?.({ id: "h-existing" });

    await waitFor(() =>
      expect(onQuoteToExistingChat).toHaveBeenCalledWith({ id: "h-existing" }),
    );
    expect(onQuoteToNewChat).not.toHaveBeenCalled();
  });

  it("does not open Existing chat when Highlight creation is cancelled", async () => {
    const onQuoteToExistingChat = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn(async () => null)}
        onQuoteToNewChat={vi.fn()}
        onQuoteToExistingChat={onQuoteToExistingChat}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Existing chat" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Existing chat" }),
      ).not.toHaveAttribute("aria-busy"),
    );

    expect(onQuoteToExistingChat).not.toHaveBeenCalled();
  });

  it("hides chat destination actions when callbacks are not provided", () => {
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "New chat" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Existing chat" }),
    ).not.toBeInTheDocument();
  });

  it("shows the add-note action only when onAddNote is provided", () => {
    const { unmount } = renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onAddNote={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Note" })).toBeInTheDocument();
    unmount();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Note" }),
    ).not.toBeInTheDocument();
  });

  it("invokes onAddNote synchronously without creating a highlight itself", () => {
    const onCreateHighlight = vi.fn(async () => ({ id: "h1" }));
    const onAddNote = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onAddNote={onAddNote}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Note" }));

    expect(onAddNote).toHaveBeenCalledTimes(1);
    expect(onCreateHighlight).not.toHaveBeenCalled();
  });

  it("dismisses on pointerdown outside the popup", async () => {
    const onDismiss = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the colour disclosure before dismissing the palette", async () => {
    const onDismiss = vi.fn();

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Colour" }));
    expect(
      await screen.findByRole("button", { name: "Blue" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Blue" })).toBeNull();
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledWith("escape");
  });

  it("exposes a labelled colour dialog and moves keyboard focus to the selected swatch", async () => {
    const user = userEvent.setup();
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const colour = screen.getByRole("button", { name: "Colour" });
    expect(colour).toHaveAttribute("aria-haspopup", "dialog");
    colour.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Highlight colours" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Yellow (selected)" }),
      ).toHaveFocus();
    });

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Highlight colours" }),
    ).toBeNull();
    expect(colour).toHaveFocus();
  });

  it("preserves the native selection and prior focus for pointer-opened colours", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<div tabIndex={-1}>Magnificent selected passage</div>);
    const passage = screen.getByText("Magnificent selected passage");
    const range = document.createRange();
    range.selectNodeContents(passage);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    passage.focus();

    const view = renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Colour" }));

    expect(window.getSelection()?.toString()).toBe(
      "Magnificent selected passage",
    );
    expect(passage).toHaveFocus();
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Highlight colours" }),
      ).toBeVisible(),
    );
    const selectedSwatch = screen.getByRole("button", {
      name: "Yellow (selected)",
    });
    expect(selectedSwatch).not.toHaveFocus();

    selectedSwatch.focus();
    expect(selectedSwatch).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Highlight colours" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Colour" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledWith("escape");
    view.unmount();
    expect(passage).toHaveFocus();
  });

  it("prevents pointerdown default inside the popup so text selection stays intact", () => {
    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Colour" });
    const event = createEvent.pointerDown(button);
    fireEvent(button, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("prefers placing the popup below the last selected line on mobile", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 780));
    const popoverRect = { width: 128, height: 40 };

    setViewport(390, 780);
    mockVisualViewport({ width: 390, height: 780 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(96, 180, 120, 44)}
        selectionLineRects={[
          new DOMRect(96, 180, 120, 18),
          new DOMRect(102, 206, 102, 18),
        ]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dialog = selectionSurface();
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("below");
    });
    const { top } = readDialogPosition(dialog);
    expect(top).toBeGreaterThanOrEqual(224);
    expectPositionWithinViewport(dialog, popoverRect, {
      width: 390,
      height: 780,
    });
  });

  it("falls back above the first selected line on mobile when below does not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 300));
    const popoverRect = { width: 120, height: 48 };

    setViewport(390, 300);
    mockVisualViewport({ width: 390, height: 300 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 244, 80, 32)}
        selectionLineRects={[
          new DOMRect(120, 244, 80, 16),
          new DOMRect(120, 260, 80, 16),
        ]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dialog = selectionSurface();
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("above");
    });
    const { top } = readDialogPosition(dialog);
    expect(top + popoverRect.height).toBeLessThanOrEqual(244);
    expectPositionWithinViewport(dialog, popoverRect, {
      width: 390,
      height: 300,
    });
  });

  it("falls back to the right on mobile when above and below do not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 140));
    const popoverRect = { width: 100, height: 80 };

    setViewport(390, 140);
    mockVisualViewport({ width: 390, height: 140 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(120, 60, 40, 20)}
        selectionLineRects={[new DOMRect(120, 60, 40, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dialog = selectionSurface();
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("right");
    });
    const { left } = readDialogPosition(dialog);
    expect(left).toBeGreaterThanOrEqual(160);
    expectPositionWithinViewport(dialog, popoverRect, {
      width: 390,
      height: 140,
    });
  });

  it("clamps mobile placement to the visual viewport bounds", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 844));
    const popoverRect = { width: 160, height: 48 };

    setViewport(390, 844);
    mockVisualViewport({
      offsetLeft: 24,
      offsetTop: 120,
      width: 220,
      height: 260,
    });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(210, 180, 110, 20)}
        selectionLineRects={[new DOMRect(210, 180, 110, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dialog = selectionSurface();
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("below");
    });
    expectPositionWithinViewport(dialog, popoverRect, {
      offsetLeft: 24,
      offsetTop: 120,
      width: 220,
      height: 260,
    });
  });

  it("pins to the nearest viewport edge on mobile when no side placement fits", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 220));
    const popoverRect = { width: 140, height: 32 };

    setViewport(390, 220);
    mockVisualViewport({ width: 160, height: 120 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    renderSelectionPopover(
      <SelectionPopover
        selectionRect={new DOMRect(40, 20, 40, 20)}
        selectionLineRects={[new DOMRect(40, 20, 40, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(64);
    });

    const dialog = selectionSurface();
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("edge");
    });
    expectPositionWithinViewport(dialog, popoverRect, {
      width: 160,
      height: 120,
    });
    expectPositionToTouchViewportEdge(dialog, popoverRect, {
      width: 160,
      height: 120,
    });
  });
});
