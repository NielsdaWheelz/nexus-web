import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import {
  normalizePaneRuntimeLayout,
  resolveEffectivePaneSizing,
  type WorkspacePrimaryMetrics,
} from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

describe("pane sizing", () => {
  it("clamps desktop primary width to the workspace floor", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 500,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeLayout: {
        primaryWidth: { kind: "workspace" },
      },
      fixedChromeWidthPx: 0,
      isMobile: false,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 684,
      primaryMinWidthPx: 684,
      primaryMaxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      renderedPrimarySlotWidthPx: 684,
      renderedPrimarySlotMinWidthPx: 684,
      renderedPrimarySlotMaxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      fixedChromeWidthPx: 0,
      storedWidthCorrectionPx: 684,
    });
  });

  it("adds fixed primary chrome to rendered bounds without changing primary width", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 700,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeLayout: {
        primaryWidth: { kind: "workspace" },
      },
      fixedChromeWidthPx: 28,
      isMobile: false,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 700,
      primaryMinWidthPx: 684,
      renderedPrimarySlotWidthPx: 728,
      renderedPrimarySlotMinWidthPx: 712,
      renderedPrimarySlotMaxWidthPx: 2428,
      fixedChromeWidthPx: 28,
      storedWidthCorrectionPx: null,
    });
  });

  it("expands the primary maximum to an allowed intrinsic floor", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 999,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeLayout: {
        primaryWidth: { kind: "intrinsic", widthPx: 2600 },
      },
      fixedChromeWidthPx: 28,
      isMobile: false,
    });

    expect(sizing.primaryMinWidthPx).toBe(2600);
    expect(sizing.primaryWidthPx).toBe(2600);
    expect(sizing.primaryMaxWidthPx).toBe(2600);
    expect(sizing.renderedPrimarySlotWidthPx).toBe(2628);
    expect(sizing.storedWidthCorrectionPx).toBe(2600);
  });

  it("ignores runtime layout on mobile and emits no correction", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 500,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeLayout: {
        primaryWidth: { kind: "intrinsic", widthPx: 900 },
      },
      fixedChromeWidthPx: 28,
      isMobile: true,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 684,
      primaryMinWidthPx: 684,
      renderedPrimarySlotWidthPx: 684,
      fixedChromeWidthPx: 0,
      storedWidthCorrectionPx: null,
    });
  });

  it("normalizes finite non-negative runtime layout values", () => {
    expect(
      normalizePaneRuntimeLayout({
        primaryWidth: { kind: "intrinsic", widthPx: 500.2 },
      }),
    ).toEqual({
      primaryWidth: { kind: "intrinsic", widthPx: 501 },
    });
  });

  it("rejects invalid runtime layout values", () => {
    expect(() =>
      normalizePaneRuntimeLayout({
        primaryWidth: { kind: "intrinsic", widthPx: 0 },
      }),
    ).toThrow("positive");
  });
});
