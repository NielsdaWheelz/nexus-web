import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import {
  normalizePaneRuntimeSizing,
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
      runtimeSizing: { primaryWidth: { kind: "workspace" }, extraWidthPx: 0 },
      isMobile: false,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 684,
      primaryMinWidthPx: 684,
      primaryMaxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      renderedWidthPx: 684,
      renderedMinWidthPx: 684,
      renderedMaxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      extraWidthPx: 0,
      storedWidthCorrectionPx: 684,
    });
  });

  it("adds extra width to rendered bounds without changing primary width", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 700,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: { primaryWidth: { kind: "workspace" }, extraWidthPx: 360 },
      isMobile: false,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 700,
      primaryMinWidthPx: 684,
      renderedWidthPx: 1060,
      renderedMinWidthPx: 1044,
      renderedMaxWidthPx: 2760,
      extraWidthPx: 360,
      storedWidthCorrectionPx: null,
    });
  });

  it("expands the primary maximum to an allowed intrinsic floor", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 999,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: {
        primaryWidth: { kind: "intrinsic", widthPx: 2600 },
        extraWidthPx: 36,
      },
      isMobile: false,
    });

    expect(sizing.primaryMinWidthPx).toBe(2600);
    expect(sizing.primaryWidthPx).toBe(2600);
    expect(sizing.primaryMaxWidthPx).toBe(2600);
    expect(sizing.renderedWidthPx).toBe(2636);
    expect(sizing.storedWidthCorrectionPx).toBe(2600);
  });

  it("ignores runtime sizing on mobile and emits no correction", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 500,
      workspacePrimaryMetrics,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: {
        primaryWidth: { kind: "intrinsic", widthPx: 900 },
        extraWidthPx: 360,
      },
      isMobile: true,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 684,
      primaryMinWidthPx: 684,
      renderedWidthPx: 684,
      extraWidthPx: 0,
      storedWidthCorrectionPx: null,
    });
  });

  it("normalizes finite non-negative runtime values", () => {
    expect(
      normalizePaneRuntimeSizing({
        primaryWidth: { kind: "intrinsic", widthPx: 500.2 },
        extraWidthPx: 35.1,
      }),
    ).toEqual({
      primaryWidth: { kind: "intrinsic", widthPx: 501 },
      extraWidthPx: 36,
    });
  });

  it("rejects invalid runtime sizing values", () => {
    expect(() =>
      normalizePaneRuntimeSizing({
        primaryWidth: { kind: "intrinsic", widthPx: 0 },
        extraWidthPx: 0,
      }),
    ).toThrow("positive");
    expect(() =>
      normalizePaneRuntimeSizing({
        primaryWidth: { kind: "workspace" },
        extraWidthPx: Number.NaN,
      }),
    ).toThrow("non-negative");
  });
});
