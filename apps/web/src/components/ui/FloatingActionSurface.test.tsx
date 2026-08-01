import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import {
  MobileViewportProvider,
  useMobileViewport,
  type MobileViewportCapability,
} from "@/lib/mobileViewport/MobileViewportProvider";
import FloatingActionSurface from "./FloatingActionSurface";

const RENDER_ENVIRONMENT: RenderEnvironment = {
  androidShell: false,
  platform: "other",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: "2026-07-31T12:00:00.000Z",
  currentLocalDate: "2026-07-31",
  initialViewport: "desktop",
};

let mobileViewport = false;
let mobileViewportCapability: MobileViewportCapability | null = null;

function MobileViewportCapabilityProbe() {
  mobileViewportCapability = useMobileViewport();
  return null;
}

function setViewportGeometry(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  window.dispatchEvent(new Event("resize"));
}

function withRenderEnvironment(ui: ReactElement) {
  return (
    <RenderEnvironmentProvider
      value={{
        ...RENDER_ENVIRONMENT,
        initialViewport: mobileViewport ? "mobile" : "desktop",
      }}
    >
      <MobileViewportProvider>
        <MobileViewportCapabilityProbe />
        {ui}
      </MobileViewportProvider>
    </RenderEnvironmentProvider>
  );
}

function renderSurface(ui: ReactElement) {
  const view = render(withRenderEnvironment(ui));
  return {
    ...view,
    rerender: (nextUi: ReactElement) =>
      view.rerender(withRenderEnvironment(nextUi)),
  };
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
    mobileViewport = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: mobileViewport,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    setViewportGeometry(1280, 900);
    document.documentElement.style.setProperty("--viewport-safe-top", "0px");
    document.documentElement.style.setProperty("--viewport-safe-right", "0px");
    document.documentElement.style.setProperty("--viewport-safe-bottom", "0px");
    document.documentElement.style.setProperty("--viewport-safe-left", "0px");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    mobileViewportCapability = null;
    document.documentElement.style.removeProperty(
      "--mobile-content-bottom-clearance",
    );
    document.documentElement.style.removeProperty("--viewport-safe-top");
    document.documentElement.style.removeProperty("--viewport-safe-right");
    document.documentElement.style.removeProperty("--viewport-safe-bottom");
    document.documentElement.style.removeProperty("--viewport-safe-left");
    vi.stubGlobal("innerWidth", originalInnerWidth);
    vi.stubGlobal("innerHeight", originalInnerHeight);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flips an anchored surface above when below does not fit", async () => {
    setViewportGeometry(320, 240);
    mockSurfaceRect(new DOMRect(0, 0, 100, 40));
    renderSurface(
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

  it("remeasures and reclamps after intrinsic surface content grows", async () => {
    setViewportGeometry(320, 240);
    const anchor = new DOMRect(260, 150, 20, 20);
    const onDismiss = vi.fn();
    const props = {
      open: true,
      anchor,
      placement: "below" as const,
      flip: true,
      role: "group" as const,
      label: "Floating actions",
      onDismiss,
    };
    const { rerender } = renderSurface(
      <FloatingActionSurface {...props}>
        <div style={{ width: 48, height: 24 }}>Actions</div>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    const initialWidth = surface().offsetWidth;

    rerender(
      <FloatingActionSurface {...props}>
        <div style={{ width: 240, height: 120 }}>Expanded actions</div>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("above"));
    const resizedSurface = surface();
    const { top, left } = surfacePosition();
    expect(resizedSurface.offsetWidth).toBeGreaterThan(initialWidth);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top + resizedSurface.offsetHeight).toBeLessThanOrEqual(232);
    expect(left + resizedSurface.offsetWidth).toBeLessThanOrEqual(312);
  });

  it("uses the mobile projection at 844px when viewport state is mobile", async () => {
    mobileViewport = true;
    setViewportGeometry(844, 390);
    mockVisualViewport({ width: 844, height: 390 });
    mockSurfaceRect(new DOMRect(0, 0, 240, 72));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(96, 150, 220, 44)}
        strategy="text-selection"
        lineRects={[
          new DOMRect(96, 150, 220, 18),
          new DOMRect(102, 176, 120, 18),
        ]}
        boundary={new DOMRect(0, 0, 844, 390)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );
    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    expect(surface()).toHaveAttribute("data-mobile", "true");
    expect(surfacePosition().top).toBe(202);
  });

  it("anchors to the last visible selected line inside a nested scroll boundary", async () => {
    mobileViewport = true;
    setViewportGeometry(390, 600);
    mockVisualViewport({ width: 390, height: 600 });
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(80, 120, 200, 240)}
        strategy="text-selection"
        lineRects={[
          new DOMRect(80, 120, 180, 20),
          new DOMRect(80, 340, 120, 20),
        ]}
        boundary={new DOMRect(0, 100, 390, 200)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    expect(surfacePosition().top).toBe(148);
  });

  it("falls back to the clipped anchor when every supplied line is outside the boundary", async () => {
    setViewportGeometry(390, 600);
    mockVisualViewport({ width: 390, height: 600 });
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(80, 140, 200, 100)}
        strategy="text-selection"
        lineRects={[
          new DOMRect(80, 20, 180, 20),
          new DOMRect(80, 350, 120, 20),
        ]}
        boundary={new DOMRect(0, 100, 390, 200)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("above"));
    expect(surfacePosition().top).toBe(84);
  });

  it("uses a free side instead of covering the selected passage", async () => {
    setViewportGeometry(360, 180);
    mockSurfaceRect(new DOMRect(0, 0, 120, 100));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(20, 70, 60, 40)}
        strategy="text-selection"
        lineRects={[new DOMRect(20, 70, 60, 40)]}
        boundary={new DOMRect(0, 0, 360, 180)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("right"));
    expect(surfacePosition()).toEqual({ top: 40, left: 88 });
    expect(getComputedStyle(surface(), "::after").display).toBe("none");
  });

  it("uses the safe edge without a caret only when no free side fits", async () => {
    setViewportGeometry(180, 160);
    mockSurfaceRect(new DOMRect(0, 0, 150, 100));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(70, 60, 40, 40)}
        strategy="text-selection"
        lineRects={[new DOMRect(70, 60, 40, 40)]}
        boundary={new DOMRect(0, 0, 180, 160)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("edge"));
    expect(getComputedStyle(surface(), "::after").display).toBe("none");
  });

  it("clamps desktop selection placement to the zoomed visual viewport", async () => {
    setViewportGeometry(1280, 900);
    mockVisualViewport({
      offsetLeft: 100,
      offsetTop: 80,
      width: 400,
      height: 300,
    });
    mockSurfaceRect(new DOMRect(0, 0, 220, 60));
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(430, 180, 80, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(430, 180, 80, 20)]}
        boundary={new DOMRect(100, 80, 400, 300)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("above"));
    expect(surfacePosition().left).toBe(272);
    expect(surfacePosition().left + 220).toBeLessThanOrEqual(492);
  });

  it("clamps mobile placement to the visual viewport and bottom clearance", async () => {
    mobileViewport = true;
    setViewportGeometry(390, 844);
    mockVisualViewport({
      offsetLeft: 24,
      offsetTop: 120,
      width: 220,
      height: 260,
    });
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    renderSurface(
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
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(64);
    });

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    const { top, left } = surfacePosition();
    expect(left).toBeGreaterThanOrEqual(32);
    expect(top).toBeGreaterThanOrEqual(128);
    expect(left + 160).toBeLessThanOrEqual(236);
    expect(top + 48).toBeLessThanOrEqual(308);
  });

  it("repositions when the canonical mobile bottom clearance changes", async () => {
    mobileViewport = true;
    setViewportGeometry(390, 600);
    mockVisualViewport({ width: 390, height: 600 });
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    document.documentElement.style.setProperty(
      "--mobile-content-bottom-clearance",
      "0px",
    );

    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(100, 480, 100, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(100, 480, 100, 20)]}
        boundary={new DOMRect(0, 0, 390, 600)}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surfacePosition().top).toBe(508));
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(100);
    });

    await waitFor(() => {
      expect(surfacePosition().top).toBe(424);
      expect(surfacePosition().top + 48).toBeLessThanOrEqual(492);
    });
  });

  it("constrains oversized content before measuring it against the visual viewport", async () => {
    mobileViewport = true;
    setViewportGeometry(390, 844);
    mockVisualViewport({
      offsetLeft: 24,
      offsetTop: 120,
      width: 220,
      height: 260,
    });
    renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(80, 180, 40, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(80, 180, 40, 20)]}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <div style={{ width: 800, height: 400 }}>Oversized actions</div>
      </FloatingActionSurface>,
    );
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(64);
    });

    await waitFor(() => expect(surface().style.maxHeight).toBe("180px"));
    const rect = surface().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(32);
    expect(rect.top).toBeGreaterThanOrEqual(128);
    expect(rect.right).toBeLessThanOrEqual(236);
    expect(rect.bottom).toBeLessThanOrEqual(308);
    expect(surface().style.maxWidth).toBe("204px");
    expect(surface().style.maxHeight).toBe("180px");
    const childRect = screen
      .getByText("Oversized actions")
      .getBoundingClientRect();
    expect(childRect.right).toBeLessThanOrEqual(rect.right);
    expect(childRect.bottom).toBeLessThanOrEqual(rect.bottom);
  });

  it("clamps mobile placement to the canonical side safe edges", async () => {
    mobileViewport = true;
    setViewportGeometry(390, 844);
    mockVisualViewport({
      offsetLeft: 24,
      offsetTop: 120,
      width: 220,
      height: 260,
    });
    document.documentElement.style.setProperty("--viewport-safe-left", "19px");
    document.documentElement.style.setProperty("--viewport-safe-right", "13px");
    mockSurfaceRect(new DOMRect(0, 0, 160, 48));
    const props = {
      open: true,
      strategy: "text-selection" as const,
      role: "group" as const,
      label: "Floating actions",
      onDismiss: vi.fn(),
    };
    const { rerender } = renderSurface(
      <FloatingActionSurface {...props} anchor={new DOMRect(0, 180, 20, 20)}>
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surfacePosition().left).toBe(51));

    rerender(
      <FloatingActionSurface {...props} anchor={new DOMRect(300, 180, 20, 20)}>
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surfacePosition().left).toBe(63));
  });

  it("aims a clamped six-pixel caret at above and below selections only", async () => {
    mobileViewport = true;
    setViewportGeometry(320, 568);
    mockVisualViewport({ width: 320, height: 568 });
    mockSurfaceRect(new DOMRect(0, 0, 280, 72));
    const { rerender } = renderSurface(
      <FloatingActionSurface
        open
        anchor={new DOMRect(0, 100, 8, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(0, 100, 8, 20)]}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );
    act(() => {
      mobileViewportCapability!.reportMobileOverlayKeyboardInset(64);
    });

    await waitFor(() => expect(surface().dataset.placement).toBe("below"));
    expect(
      surface().style.getPropertyValue("--floating-action-caret-inline-offset"),
    ).toBe("12px");
    const caretStyle = getComputedStyle(surface(), "::after");
    expect(caretStyle.display).toBe("block");
    expect(caretStyle.width).toBe("6px");
    expect(caretStyle.height).toBe("6px");

    rerender(
      <FloatingActionSurface
        open
        anchor={new DOMRect(300, 460, 8, 20)}
        strategy="text-selection"
        lineRects={[new DOMRect(300, 460, 8, 20)]}
        role="group"
        label="Floating actions"
        onDismiss={vi.fn()}
      >
        <button type="button">Actions</button>
      </FloatingActionSurface>,
    );

    await waitFor(() => expect(surface().dataset.placement).toBe("above"));
    expect(
      surface().style.getPropertyValue("--floating-action-caret-inline-offset"),
    ).toBe("268px");
    expect(getComputedStyle(surface(), "::after").display).toBe("block");
  });

  it("uses fade-only entry motion when reduced motion is requested", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      mockSurfaceRect(new DOMRect(0, 0, 120, 40));
      renderSurface(
        <FloatingActionSurface
          open
          anchor={new DOMRect(120, 120, 80, 24)}
          role="group"
          label="Floating actions"
          onDismiss={vi.fn()}
        >
          <button type="button">Actions</button>
        </FloatingActionSurface>,
      );

      await waitFor(() =>
        expect(surface().style.visibility).not.toBe("hidden"),
      );
      const motionStyle = getComputedStyle(surface());
      expect(motionStyle.animationName).toContain(
        "floatingActionSurfaceFadeOnly",
      );
      expect(motionStyle.transform).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });

  it("uses an opaque system surface and explicit focus outline in forced colors", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    try {
      mockSurfaceRect(new DOMRect(0, 0, 120, 40));
      renderSurface(
        <FloatingActionSurface
          open
          anchor={new DOMRect(120, 120, 80, 24)}
          role="group"
          label="Floating actions"
          onDismiss={vi.fn()}
        >
          <button type="button">Actions</button>
        </FloatingActionSurface>,
      );

      const action = screen.getByRole("button", { name: "Actions" });
      action.focus();
      await waitFor(() =>
        expect(surface().style.visibility).not.toBe("hidden"),
      );
      const surfaceStyle = getComputedStyle(surface());
      const focusStyle = getComputedStyle(action);
      expect(surfaceStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(surfaceStyle.borderStyle).toBe("solid");
      expect(surfaceStyle.boxShadow).toBe("none");
      expect(focusStyle.outlineStyle).toBe("solid");
      expect(focusStyle.outlineWidth).toBe("2px");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "forced-colors", value: "none" }],
      });
    }
  });

  it("dismisses on outside pointerdown, Escape, and scroll when configured", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    mockSurfaceRect(new DOMRect(0, 0, 120, 40));
    renderSurface(
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
    renderSurface(
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
    renderSurface(
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
