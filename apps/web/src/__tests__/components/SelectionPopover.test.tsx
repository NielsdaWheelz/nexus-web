import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import SelectionPopover from "@/components/SelectionPopover";

function createContainerRef(
  rect: DOMRect = new DOMRect(0, 0, 1280, 900)
): RefObject<HTMLElement | null> {
  const container = document.createElement("div");
  container.getBoundingClientRect = vi.fn(() => rect);
  document.body.appendChild(container);
  return { current: container };
}

function setViewport(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
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
      if (this.getAttribute("aria-label") === "Highlight actions") {
        return rect;
      }
      return new DOMRect(0, 0, 0, 0);
    });
}

function readDialogPosition(dialog: HTMLElement): { top: number; left: number } {
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
  }
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
  }
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
    setViewport(1280, 900);
    document.documentElement.style.setProperty("--mobile-bottom-nav-height", "64px");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--mobile-bottom-nav-height");
    vi.stubGlobal("innerWidth", originalInnerWidth);
    vi.stubGlobal("innerHeight", originalInnerHeight);
    window.dispatchEvent(new Event("resize"));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows an icon-only Ask action when onAsk is provided", () => {
    const onCreateHighlight = vi.fn();
    const onAsk = vi.fn();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onAsk={onAsk}
        onDismiss={vi.fn()}
      />
    );

    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toBeInTheDocument();
    expect(button).not.toHaveTextContent("Ask");

    fireEvent.click(button);

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith("yellow");
    expect(onCreateHighlight).not.toHaveBeenCalled();
  });

  it("passes the currently selected color to the Ask icon button", () => {
    const onCreateHighlight = vi.fn();
    const onAsk = vi.fn();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onAsk={onAsk}
        onDismiss={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("blue");
    expect(onAsk).toHaveBeenCalledWith("blue");
  });

  it("hides Ask when no ask callback is provided", () => {
    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Ask" })).not.toBeInTheDocument();
  });

  it("does not expose chat destination choices from the selection popover", () => {
    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onAsk={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
    expect(screen.queryByText("Ask in new chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask in this document")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask in library...")).not.toBeInTheDocument();
  });

  it("dismisses on pointerdown outside the popup", async () => {
    const onDismiss = vi.fn();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("prevents pointerdown default inside the popup so text selection stays intact", () => {
    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const button = screen.getByRole("button", { name: "Green" });
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

    render(
      <SelectionPopover
        selectionRect={new DOMRect(96, 180, 120, 44)}
        selectionLineRects={[new DOMRect(96, 180, 120, 18), new DOMRect(102, 206, 102, 18)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Highlight actions" });
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("below");
    });
    const { top } = readDialogPosition(dialog);
    expect(top).toBeGreaterThanOrEqual(224);
    expectPositionWithinViewport(dialog, popoverRect, { width: 390, height: 780 });
  });

  it("falls back above the first selected line on mobile when below does not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 300));
    const popoverRect = { width: 120, height: 48 };

    setViewport(390, 300);
    mockVisualViewport({ width: 390, height: 300 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 244, 80, 32)}
        selectionLineRects={[new DOMRect(120, 244, 80, 16), new DOMRect(120, 260, 80, 16)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Highlight actions" });
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("above");
    });
    const { top } = readDialogPosition(dialog);
    expect(top + popoverRect.height).toBeLessThanOrEqual(244);
    expectPositionWithinViewport(dialog, popoverRect, { width: 390, height: 300 });
  });

  it("falls back to the right on mobile when above and below do not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 140));
    const popoverRect = { width: 100, height: 80 };

    setViewport(390, 140);
    mockVisualViewport({ width: 390, height: 140 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 60, 40, 20)}
        selectionLineRects={[new DOMRect(120, 60, 40, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Highlight actions" });
    await waitFor(() => {
      expect(dialog.dataset.placement).toBe("right");
    });
    const { left } = readDialogPosition(dialog);
    expect(left).toBeGreaterThanOrEqual(160);
    expectPositionWithinViewport(dialog, popoverRect, { width: 390, height: 140 });
  });

  it("clamps mobile placement to the visual viewport bounds", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 844));
    const popoverRect = { width: 160, height: 48 };

    setViewport(390, 844);
    mockVisualViewport({ offsetLeft: 24, offsetTop: 120, width: 220, height: 260 });
    mockPopoverRect(new DOMRect(0, 0, popoverRect.width, popoverRect.height));

    render(
      <SelectionPopover
        selectionRect={new DOMRect(210, 180, 110, 20)}
        selectionLineRects={[new DOMRect(210, 180, 110, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Highlight actions" });
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

    render(
      <SelectionPopover
        selectionRect={new DOMRect(40, 20, 40, 20)}
        selectionLineRects={[new DOMRect(40, 20, 40, 20)]}
        containerRef={containerRef}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Highlight actions" });
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
