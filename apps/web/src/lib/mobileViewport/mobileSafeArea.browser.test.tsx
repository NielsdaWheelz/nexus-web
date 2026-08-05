import { useEffect, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { useMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";

/**
 * Risk: a full-window mobile overlay is drawn under the Android bar, under the
 * keyboard, or — since the bottom-geometry cutover — against a registered
 * surface's element-local clearance instead of the window one.
 * `FloatingActionSurface` is the boundary that consumes the published safe area
 * (docs/cutovers/mobile-reader-bottom-geometry-hard-cutover.md).
 * Publication, registration lifecycle, and cleanup belong to
 * MobileViewportProvider.browser.test.tsx.
 */

const CONTENT_BOTTOM_CLEARANCE = "--mobile-content-bottom-clearance";
/** FloatingActionSurface's default `viewportPadding`. */
const VIEWPORT_PADDING_PX = 8;
const OVERLAY_KEYBOARD_INSET_PX = 260;
/** How far above the window bottom the registered pane body ends. */
const PANE_BODY_BOTTOM_GAP_PX = 80;

/**
 * Read the published value straight off the root. A probe element would mutate
 * the DOM inside `waitFor`, whose MutationObserver would re-enter the callback
 * on the probe's own mutation and spin the page.
 */
function readRootLength(property: string): number {
  return Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(property),
  );
}

function readSurfaceClearance(element: HTMLElement): number {
  return Number.parseFloat(
    getComputedStyle(element).getPropertyValue(CONTENT_BOTTOM_CLEARANCE),
  );
}

/**
 * A mobile pane body that ends above the window bottom, plus the keyboard a
 * mobile modal reports — so the window clearance and the surface-local
 * clearance are two different numbers while the floating surface is placed.
 */
function MobilePaneBodyWithKeyboard() {
  const viewport = useMobileViewport();
  const paneBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const paneBody = paneBodyRef.current;
    if (!paneBody) throw new Error("safe-area proof pane body did not mount");
    const releaseSurface = viewport.registerContentSurface(paneBody);
    const releaseKeyboard = viewport.reportMobileOverlayKeyboardInset(
      OVERLAY_KEYBOARD_INSET_PX,
    );
    return () => {
      releaseKeyboard();
      releaseSurface();
    };
  }, [viewport]);
  return (
    <div
      ref={paneBodyRef}
      data-testid="pane-body"
      style={{
        position: "fixed",
        insetInline: 0,
        top: 0,
        bottom: PANE_BODY_BOTTOM_GAP_PX,
      }}
    />
  );
}

describe("mobile safe-area composition", () => {
  afterEach(() => {
    for (const property of [
      "--viewport-safe-top",
      "--viewport-safe-right",
      "--viewport-safe-bottom",
      "--viewport-safe-left",
    ]) {
      document.documentElement.style.removeProperty(property);
    }
  });

  it("keeps floating actions inside canonical mobile side insets", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty("--viewport-safe-top", "0px");
    document.documentElement.style.setProperty("--viewport-safe-right", "13px");
    document.documentElement.style.setProperty("--viewport-safe-bottom", "0px");
    document.documentElement.style.setProperty("--viewport-safe-left", "19px");
    const props = {
      open: true,
      strategy: "text-selection" as const,
      role: "group" as const,
      label: "Floating actions",
      onDismiss: () => undefined,
    };
    const { rerender } = render(
      withRenderEnvironment(
        <FloatingActionSurface {...props} anchor={new DOMRect(0, 180, 20, 20)}>
          <button type="button" style={{ width: 160, height: 48 }}>
            Actions
          </button>
        </FloatingActionSurface>,
        { initialViewport: "mobile" },
      ),
    );
    const surface = await screen.findByRole("group", {
      name: "Floating actions",
    });

    await waitFor(() => {
      expect(surface.getBoundingClientRect().left).toBeGreaterThanOrEqual(27);
    });

    rerender(
      withRenderEnvironment(
        <FloatingActionSurface
          {...props}
          anchor={new DOMRect(370, 180, 20, 20)}
        >
          <button type="button" style={{ width: 160, height: 48 }}>
            Actions
          </button>
        </FloatingActionSurface>,
        { initialViewport: "mobile" },
      ),
    );
    await waitFor(() => {
      expect(surface.getBoundingClientRect().right).toBeLessThanOrEqual(369);
    });
  });

  it("bounds a full-window floating surface by the window content clearance, not by a registered surface's local clearance", async () => {
    await page.viewport(390, 844);
    render(
      withRenderEnvironment(
        <>
          <MobilePaneBodyWithKeyboard />
          <FloatingActionSurface
            open
            anchor={new DOMRect(100, 800, 20, 20)}
            role="group"
            label="Floating actions"
            onDismiss={() => undefined}
          >
            <button type="button" style={{ width: 160, height: 48 }}>
              Actions
            </button>
          </FloatingActionSurface>
        </>,
        { initialViewport: "mobile" },
      ),
    );
    const paneBody = screen.getByTestId("pane-body");
    const surface = await screen.findByRole("group", {
      name: "Floating actions",
    });

    // The window band and the pane body's local band are genuinely different
    // numbers: the pane body already ends above the keyboard.
    await waitFor(() => {
      expect(readRootLength(CONTENT_BOTTOM_CLEARANCE)).toBe(
        OVERLAY_KEYBOARD_INSET_PX,
      );
      expect(readSurfaceClearance(paneBody)).toBe(
        OVERLAY_KEYBOARD_INSET_PX - PANE_BODY_BOTTOM_GAP_PX,
      );
    });

    await waitFor(() => {
      expect(surface.getBoundingClientRect().bottom).toBeCloseTo(
        window.innerHeight - VIEWPORT_PADDING_PX - OVERLAY_KEYBOARD_INSET_PX,
        0,
      );
    });
  });
});
