import type { CSSProperties } from "react";
import { render, screen } from "@testing-library/react";
import { cdp } from "vitest/browser";
import { describe, expect, it } from "vitest";
import MobileReaderPositionRibbon from "./MobileReaderPositionRibbon";

type RibbonOptions = {
  direction?: "ltr" | "rtl";
  visibleRange?: { start: number; end: number };
};

function ribbonFixture({
  direction = "ltr",
  visibleRange = { start: 0.25, end: 0.65 },
}: RibbonOptions = {}) {
  return (
    <div
      data-testid="positioning-host"
      dir={direction}
      style={
        {
          position: "relative",
          width: 400,
          height: 300,
          "--viewport-safe-left": "11px",
          "--viewport-safe-right": "17px",
          "--mobile-content-bottom-clearance": "31px",
          "--edge-subtle": "#1f1f23",
          "--accent": "#c4a472",
        } as CSSProperties
      }
    >
      <MobileReaderPositionRibbon visibleRange={visibleRange} />
    </div>
  );
}

function renderRibbon(options: RibbonOptions = {}) {
  return render(ribbonFixture(options));
}

describe("MobileReaderPositionRibbon", () => {
  it("spans the already-safe reader column above composed bottom clearance", () => {
    renderRibbon();

    const hostBounds = screen
      .getByTestId("positioning-host")
      .getBoundingClientRect();
    const ribbon = screen.getByTestId("mobile-reader-position-ribbon");
    const ribbonBounds = ribbon.getBoundingClientRect();
    const bandBounds = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(ribbonBounds.left).toBeCloseTo(hostBounds.left, 1);
    expect(ribbonBounds.right).toBeCloseTo(hostBounds.right, 1);
    expect(hostBounds.bottom - ribbonBounds.bottom).toBeCloseTo(31, 1);
    expect(ribbonBounds.height).toBeCloseTo(2, 1);
    expect(bandBounds.height).toBeCloseTo(2, 1);
    expect(bandBounds.left - ribbonBounds.left).toBeCloseTo(
      ribbonBounds.width * 0.25,
      1,
    );
    expect(bandBounds.width).toBeCloseTo(ribbonBounds.width * 0.4, 1);
    expect(getComputedStyle(ribbon).zIndex).toBe("2");
  });

  it("repaints exact geometry when the supplied semantic range changes", () => {
    const view = renderRibbon({
      visibleRange: { start: 0.1, end: 0.3 },
    });
    const ribbon = screen.getByTestId("mobile-reader-position-ribbon");
    const band = screen.getByTestId("mobile-reader-position-band");
    const ribbonBounds = ribbon.getBoundingClientRect();
    const initialBandBounds = band.getBoundingClientRect();

    expect(initialBandBounds.left - ribbonBounds.left).toBeCloseTo(
      ribbonBounds.width * 0.1,
      1,
    );
    expect(initialBandBounds.width).toBeCloseTo(ribbonBounds.width * 0.2, 1);

    view.rerender(
      ribbonFixture({ visibleRange: { start: 0.55, end: 0.9 } }),
    );

    const updatedRibbonBounds = ribbon.getBoundingClientRect();
    const updatedBandBounds = band.getBoundingClientRect();
    expect(updatedBandBounds.left - updatedRibbonBounds.left).toBeCloseTo(
      updatedRibbonBounds.width * 0.55,
      1,
    );
    expect(updatedBandBounds.width).toBeCloseTo(
      updatedRibbonBounds.width * 0.35,
      1,
    );
    expect(updatedBandBounds.left).not.toBeCloseTo(initialBandBounds.left, 1);
    expect(updatedBandBounds.width).not.toBeCloseTo(initialBandBounds.width, 1);
  });

  it("maps normalized zero to logical inline start", () => {
    renderRibbon({
      direction: "rtl",
      visibleRange: { start: 0, end: 0.3 },
    });

    const ribbonBounds = screen
      .getByTestId("mobile-reader-position-ribbon")
      .getBoundingClientRect();
    const bandBounds = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(ribbonBounds.right - bandBounds.right).toBeCloseTo(0, 1);
    expect(bandBounds.width).toBeCloseTo(ribbonBounds.width * 0.3, 1);
  });

  it("allows an exact short-document range to span the full track", () => {
    renderRibbon({ visibleRange: { start: 0, end: 1 } });

    const ribbonBounds = screen
      .getByTestId("mobile-reader-position-ribbon")
      .getBoundingClientRect();
    const bandBounds = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(bandBounds.left).toBeCloseTo(ribbonBounds.left, 1);
    expect(bandBounds.width).toBeCloseTo(ribbonBounds.width, 1);
  });

  it("contains a collapsed range at the LTR logical end", () => {
    renderRibbon({ visibleRange: { start: 1, end: 1 } });

    const ribbonBounds = screen
      .getByTestId("mobile-reader-position-ribbon")
      .getBoundingClientRect();
    const bandBounds = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(ribbonBounds.right - bandBounds.right).toBeCloseTo(0, 1);
    expect(bandBounds.width).toBeCloseTo(2, 1);
  });

  it("contains a collapsed range at the RTL logical end", () => {
    renderRibbon({
      direction: "rtl",
      visibleRange: { start: 1, end: 1 },
    });

    const ribbonBounds = screen
      .getByTestId("mobile-reader-position-ribbon")
      .getBoundingClientRect();
    const bandBounds = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(bandBounds.left - ribbonBounds.left).toBeCloseTo(0, 1);
    expect(bandBounds.width).toBeCloseTo(2, 1);
  });

  it("is decorative, silent, noninteractive, and unanimated", () => {
    renderRibbon();

    const ribbon = screen.getByTestId("mobile-reader-position-ribbon");
    const band = screen.getByTestId("mobile-reader-position-band");

    expect(ribbon).toHaveAttribute("aria-hidden", "true");
    expect(ribbon).not.toHaveAttribute("role");
    expect(ribbon).not.toHaveAttribute("aria-live");
    expect(ribbon).not.toHaveAttribute("tabindex");
    expect(band).not.toHaveAttribute("role");
    expect(band).not.toHaveAttribute("tabindex");
    expect(getComputedStyle(ribbon).pointerEvents).toBe("none");
    expect(getComputedStyle(band).transitionDuration).toBe("0s");
    expect(getComputedStyle(band).animationName).toBe("none");

    ribbon.focus();
    expect(ribbon).not.toHaveFocus();
  });

  it("uses distinct system colors for the track and band in forced colors", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    try {
      renderRibbon();

      const ribbonStyle = getComputedStyle(
        screen.getByTestId("mobile-reader-position-ribbon"),
      );
      const bandStyle = getComputedStyle(
        screen.getByTestId("mobile-reader-position-band"),
      );

      expect(ribbonStyle.forcedColorAdjust).toBe("none");
      expect(ribbonStyle.backgroundColor).not.toBe(bandStyle.backgroundColor);
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "forced-colors", value: "none" }],
      });
    }
  });
});
