import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import FloatingActionSurface from "./FloatingActionSurface";

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
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      offsetLeft,
      offsetTop,
      width,
      height,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

function mockSurfaceRect(rect: DOMRect) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.floatingActionSurface === "true") {
        return rect;
      }
      return new DOMRect(0, 0, 0, 0);
    });
}

function surface() {
  return screen.getByRole("group", { name: "Floating actions" });
}

function surfacePosition() {
  const el = surface();
  return {
    top: Number.parseFloat(el.style.top),
    left: Number.parseFloat(el.style.left),
  };
}

describe("FloatingActionSurface", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    setViewport(1280, 900);
    document.documentElement.style.setProperty("--mobile-bottom-obstruction", "64px");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--mobile-bottom-obstruction");
    vi.stubGlobal("innerWidth", originalInnerWidth);
    vi.stubGlobal("innerHeight", originalInnerHeight);
    window.dispatchEvent(new Event("resize"));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flips an anchored surface above when below does not fit", async () => {
    setViewport(320, 240);
    mockSurfaceRect(new DOMRect(0, 0, 100, 40));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(140, 210, 20, 20)}
        placement="below"
        flip
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("above"));
    expect(surfacePosition().top + 40).toBeLessThanOrEqual(210);
  });

  it("places mobile text-selection actions below the last selected line", async () => {
    setViewport(390, 780);
    mockVisualViewport({ width: 390, height: 780 });
    mockSurfaceRect(new DOMRect(0, 0, 128, 40));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(96, 180, 120, 44)}
        strategy="text-selection"
        lineRects={[
          new DOMRect(96, 180, 120, 18),
          new DOMRect(102, 206, 102, 18),
        ]}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    expect(surfacePosition().top).toBeGreaterThanOrEqual(224);
  });

  it("clamps mobile placement to the visual viewport", async () => {
    setViewport(390, 844);
    mockVisualViewport({ offsetLeft: 24, offsetTop: 120, width: 220, height: 260 });
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(210, 180, 110, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(210, 180, 110, 20)]}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    const { top, left } = surfacePosition();
    expect(left).toBeGreaterThanOrEqual(32);
    expect(top).toBeGreaterThanOrEqual(128);
    expect(left + 160).toBeLessThanOrEqual(236);
    expect(top + 48).toBeLessThanOrEqual(312);
  });

  it("dismisses on outside pointerdown, Escape, and scroll when configured", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    mockSurfaceRect(new DOMRect(0, 0, 120, 40));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(120, 120, 80, 24)}
        scrollBehavior="dismiss"
        role="group"
        label="Floating actions"
        onDismiss={onDismiss}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    fireEvent.pointerDown(document.body);
    await user.keyboard("{Escape}");
    fireEvent.scroll(window);

    expect(onDismiss).toHaveBeenNthCalledWith(1, "outside-click");
    expect(onDismiss).toHaveBeenNthCalledWith(2, "escape");
    expect(onDismiss).toHaveBeenNthCalledWith(3, "scroll");
  });

  it("does not dismiss for detached dismissal-ignored children", () => {
    const onDismiss = vi.fn();
    const ignored = document.createElement("button");
    ignored.dataset.dismissIgnore = "true";
    document.body.appendChild(ignored);
    mockSurfaceRect(new DOMRect(0, 0, 120, 40));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(120, 120, 80, 24)}
        role="group"
        label="Floating actions"
        onDismiss={onDismiss}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    fireEvent.pointerDown(ignored);
    expect(onDismiss).not.toHaveBeenCalled();
    ignored.remove();
  });

  it("prevents pointerdown default when preserving a live text selection", () => {
    mockSurfaceRect(new DOMRect(0, 0, 120, 40));
    render(
      <FloatingActionSurface
        open
        anchor={new DOMRect(120, 120, 80, 24)}
        preservePointerSelection
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    const button = screen.getByRole("button", { name: "Actions" });
    const event = createEvent.pointerDown(button);
    fireEvent(button, event);
    expect(event.defaultPrevented).toBe(true);
  });
});
