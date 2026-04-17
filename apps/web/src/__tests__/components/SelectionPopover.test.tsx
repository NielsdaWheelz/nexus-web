import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("shows ask-in-chat action when onQuoteToChat is provided", async () => {
    const onCreateHighlight = vi.fn();
    const onQuoteToChat = vi.fn();
    const user = userEvent.setup();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToChat={onQuoteToChat}
        onDismiss={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Ask in chat" }));

    expect(onQuoteToChat).toHaveBeenCalledTimes(1);
    expect(onQuoteToChat).toHaveBeenCalledWith("yellow");
    expect(onCreateHighlight).not.toHaveBeenCalled();
  });

  it("passes the currently selected color to ask-in-chat", async () => {
    const onCreateHighlight = vi.fn();
    const onQuoteToChat = vi.fn();
    const user = userEvent.setup();

    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={onCreateHighlight}
        onQuoteToChat={onQuoteToChat}
        onDismiss={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Blue" }));
    await user.click(screen.getByRole("button", { name: "Ask in chat" }));

    expect(onCreateHighlight).toHaveBeenCalledWith("blue");
    expect(onQuoteToChat).toHaveBeenCalledWith("blue");
  });

  it("hides ask-in-chat when no quote callback is provided", () => {
    render(
      <SelectionPopover
        selectionRect={new DOMRect(120, 120, 80, 24)}
        containerRef={createContainerRef()}
        onCreateHighlight={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Ask in chat" })).not.toBeInTheDocument();
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

  it("prefers placing the popup below the last selected line on mobile", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 780));

    setViewport(390, 780);
    mockVisualViewport({ width: 390, height: 780 });
    mockPopoverRect(new DOMRect(0, 0, 128, 40));

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
      expect(dialog.style.top).toBe("232px");
      expect(dialog.style.left).toBe("89px");
      expect(dialog.dataset.placement).toBe("below");
    });
  });

  it("falls back above the first selected line on mobile when below does not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 300));

    setViewport(390, 300);
    mockVisualViewport({ width: 390, height: 300 });
    mockPopoverRect(new DOMRect(0, 0, 120, 48));

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
      expect(dialog.style.top).toBe("188px");
      expect(dialog.style.left).toBe("100px");
      expect(dialog.dataset.placement).toBe("above");
    });
  });

  it("falls back to the right on mobile when above and below do not fit", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 140));

    setViewport(390, 140);
    mockVisualViewport({ width: 390, height: 140 });
    mockPopoverRect(new DOMRect(0, 0, 100, 80));

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
      expect(dialog.style.top).toBe("8px");
      expect(dialog.style.left).toBe("168px");
      expect(dialog.dataset.placement).toBe("right");
    });
  });

  it("clamps mobile placement to the visual viewport bounds", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 844));

    setViewport(390, 844);
    mockVisualViewport({ offsetLeft: 24, offsetTop: 120, width: 220, height: 260 });
    mockPopoverRect(new DOMRect(0, 0, 160, 48));

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
      expect(dialog.style.top).toBe("208px");
      expect(dialog.style.left).toBe("76px");
      expect(dialog.dataset.placement).toBe("below");
    });
  });

  it("pins to the nearest viewport edge on mobile when no side placement fits", async () => {
    const containerRef = createContainerRef(new DOMRect(0, 0, 390, 220));

    setViewport(390, 220);
    mockVisualViewport({ width: 160, height: 120 });
    mockPopoverRect(new DOMRect(0, 0, 140, 32));

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
      expect(dialog.style.top).toBe("16px");
      expect(dialog.style.left).toBe("8px");
      expect(dialog.dataset.placement).toBe("edge");
    });
  });
});
