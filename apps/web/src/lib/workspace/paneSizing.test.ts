import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MIN_PANE_WIDTH_PX,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import {
  normalizePaneRuntimeSizing,
  resolveEffectivePaneSizing,
} from "@/lib/workspace/paneSizing";

describe("pane sizing", () => {
  it("clamps desktop primary width to a raised runtime minimum", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 500,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: { minWidthPx: 684, extraWidthPx: 0 },
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
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: { minWidthPx: 684, extraWidthPx: 360 },
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

  it("caps runtime minimum at the route maximum", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 9999,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: { minWidthPx: 9999, extraWidthPx: 36 },
      isMobile: false,
    });

    expect(sizing.primaryMinWidthPx).toBe(MAX_MEDIA_PANE_WIDTH_PX);
    expect(sizing.primaryWidthPx).toBe(MAX_MEDIA_PANE_WIDTH_PX);
    expect(sizing.renderedWidthPx).toBe(MAX_MEDIA_PANE_WIDTH_PX + 36);
  });

  it("ignores runtime sizing on mobile and emits no correction", () => {
    const sizing = resolveEffectivePaneSizing({
      storedWidthPx: 500,
      routeWidth: resolvePaneRouteWidthContract("/media/media-1"),
      runtimeSizing: { minWidthPx: 900, extraWidthPx: 360 },
      isMobile: true,
    });

    expect(sizing).toMatchObject({
      primaryWidthPx: 500,
      primaryMinWidthPx: MIN_PANE_WIDTH_PX,
      renderedWidthPx: 500,
      extraWidthPx: 0,
      storedWidthCorrectionPx: null,
    });
  });

  it("normalizes finite non-negative runtime values", () => {
    expect(
      normalizePaneRuntimeSizing({ minWidthPx: 500.2, extraWidthPx: 35.1 })
    ).toEqual({ minWidthPx: 501, extraWidthPx: 36 });
  });

  it("rejects invalid runtime sizing values", () => {
    expect(() =>
      normalizePaneRuntimeSizing({ minWidthPx: 0, extraWidthPx: 0 })
    ).toThrow("positive");
    expect(() =>
      normalizePaneRuntimeSizing({ minWidthPx: null, extraWidthPx: Number.NaN })
    ).toThrow("non-negative");
  });
});
