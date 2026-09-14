import type { CSSProperties } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import "@/app/globals.css";
import type { ReaderDocumentOverviewRange } from "@/lib/reader/readerDocumentPosition";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import MobileReaderPositionRibbon from "./MobileReaderPositionRibbon";

// The ribbon is passive paint at the reader column's own bottom. Terminal
// content spends the element-local clearance separately; the ribbon must never
// be lifted by it, and it never reads Player or Nexus state
// (docs/cutovers/mobile-reader-bottom-geometry-hard-cutover.md).

const COLUMN_WIDTH_PX = 320;
const COLUMN_HEIGHT_PX = 400;
const RIBBON_HEIGHT_PX = 2;

type ContentSurfaceStyle = CSSProperties & {
  "--mobile-content-bottom-clearance": string;
};

/**
 * A reader column inside a content surface carrying the element-local clearance
 * the provider publishes on registered surfaces.
 */
function ReaderColumn({
  clearance,
  visibleRange,
}: {
  clearance: string;
  visibleRange: ReaderDocumentOverviewRange;
}) {
  const surfaceStyle: ContentSurfaceStyle = {
    "--mobile-content-bottom-clearance": clearance,
  };
  return (
    <div data-testid="content-surface" style={surfaceStyle}>
      <div
        data-testid="reader-column"
        style={{
          position: "relative",
          width: COLUMN_WIDTH_PX,
          height: COLUMN_HEIGHT_PX,
        }}
      >
        <MobileReaderPositionRibbon visibleRange={visibleRange} />
      </div>
    </div>
  );
}

function localClearance(element: HTMLElement): string {
  return getComputedStyle(element)
    .getPropertyValue("--mobile-content-bottom-clearance")
    .trim();
}

describe("MobileReaderPositionRibbon placement", () => {
  it("paints at the reader column bottom regardless of the local content clearance", async () => {
    await page.viewport(390, 844);
    const visibleRange: ReaderDocumentOverviewRange = { start: 0.25, end: 0.5 };
    const { rerender } = render(
      withRenderEnvironment(
        <ReaderColumn clearance="96px" visibleRange={visibleRange} />,
        { initialViewport: "mobile" },
      ),
    );

    const column = screen.getByTestId("reader-column");
    const ribbon = screen.getByTestId("mobile-reader-position-ribbon");
    expect(localClearance(column)).toBe("96px");
    const liftedRect = ribbon.getBoundingClientRect();
    expect(liftedRect.bottom).toBeCloseTo(
      column.getBoundingClientRect().bottom,
      0,
    );

    // Sensitivity: a clearance-driven ribbon would drop 48px when the local
    // token halves. Passive paint does not move at all.
    rerender(
      withRenderEnvironment(
        <ReaderColumn clearance="48px" visibleRange={visibleRange} />,
        { initialViewport: "mobile" },
      ),
    );
    await waitFor(() => {
      expect(localClearance(column)).toBe("48px");
    });
    const settledRect = ribbon.getBoundingClientRect();
    expect(settledRect.top).toBeCloseTo(liftedRect.top, 0);
    expect(settledRect.bottom).toBeCloseTo(liftedRect.bottom, 0);
    expect(settledRect.bottom).toBeCloseTo(
      column.getBoundingClientRect().bottom,
      0,
    );
  });

  it("paints the exact semantic range as a 2px passive band outside the accessibility tree", async () => {
    await page.viewport(390, 844);
    const visibleRange: ReaderDocumentOverviewRange = { start: 0.25, end: 0.5 };
    render(
      withRenderEnvironment(
        <ReaderColumn clearance="96px" visibleRange={visibleRange} />,
        { initialViewport: "mobile" },
      ),
    );

    const column = screen.getByTestId("reader-column");
    const ribbon = screen.getByTestId("mobile-reader-position-ribbon");
    const band = screen.getByTestId("mobile-reader-position-band");
    const columnRect = column.getBoundingClientRect();
    const ribbonRect = ribbon.getBoundingClientRect();
    const bandRect = band.getBoundingClientRect();

    expect(ribbonRect.height).toBeCloseTo(RIBBON_HEIGHT_PX, 5);
    expect(ribbon).toHaveAttribute("aria-hidden", "true");
    expect(getComputedStyle(ribbon).pointerEvents).toBe("none");
    expect(ribbonRect.left).toBeCloseTo(columnRect.left, 0);
    expect(ribbonRect.right).toBeCloseTo(columnRect.right, 0);

    expect(bandRect.left - columnRect.left).toBeCloseTo(
      visibleRange.start * columnRect.width,
      1,
    );
    expect(bandRect.width).toBeCloseTo(
      (visibleRange.end - visibleRange.start) * columnRect.width,
      1,
    );
    expect(bandRect.height).toBeCloseTo(RIBBON_HEIGHT_PX, 5);
  });

  it("keeps a degenerate end-of-document range visible and inside the column", async () => {
    await page.viewport(390, 844);
    const visibleRange: ReaderDocumentOverviewRange = { start: 1, end: 1 };
    render(
      withRenderEnvironment(
        <ReaderColumn clearance="96px" visibleRange={visibleRange} />,
        { initialViewport: "mobile" },
      ),
    );

    const columnRect = screen
      .getByTestId("reader-column")
      .getBoundingClientRect();
    const bandRect = screen
      .getByTestId("mobile-reader-position-band")
      .getBoundingClientRect();

    expect(bandRect.width).toBeCloseTo(RIBBON_HEIGHT_PX, 5);
    expect(bandRect.left).toBeGreaterThanOrEqual(columnRect.left);
    expect(bandRect.right).toBeLessThanOrEqual(columnRect.right + 0.5);
  });
});
