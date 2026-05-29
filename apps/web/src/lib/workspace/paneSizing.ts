"use client";

import type { PaneWidthContract } from "@/lib/panes/paneRouteModel";

export interface PaneRuntimeSizing {
  minWidthPx: number | null;
  extraWidthPx: number;
}

export interface EffectivePaneSizing {
  primaryWidthPx: number;
  primaryMinWidthPx: number;
  primaryMaxWidthPx: number;
  renderedWidthPx: number;
  renderedMinWidthPx: number;
  renderedMaxWidthPx: number;
  extraWidthPx: number;
  storedWidthCorrectionPx: number | null;
}

export const EMPTY_PANE_RUNTIME_SIZING: PaneRuntimeSizing = {
  minWidthPx: null,
  extraWidthPx: 0,
};

export function normalizePaneRuntimeSizing(
  sizing: PaneRuntimeSizing
): PaneRuntimeSizing {
  if (
    (sizing.minWidthPx !== null &&
      (!Number.isFinite(sizing.minWidthPx) || sizing.minWidthPx <= 0)) ||
    !Number.isFinite(sizing.extraWidthPx) ||
    sizing.extraWidthPx < 0
  ) {
    throw new Error(
      "Pane runtime sizing min must be positive and extra must be non-negative."
    );
  }
  const minWidthPx =
    sizing.minWidthPx === null ? null : Math.ceil(sizing.minWidthPx);
  const extraWidthPx = Math.ceil(sizing.extraWidthPx);
  return { minWidthPx, extraWidthPx };
}

export function isEmptyPaneRuntimeSizing(sizing: PaneRuntimeSizing): boolean {
  return sizing.minWidthPx === null && sizing.extraWidthPx === 0;
}

export function resolveEffectivePaneSizing(input: {
  storedWidthPx: number;
  routeWidth: PaneWidthContract;
  runtimeSizing: PaneRuntimeSizing;
  isMobile: boolean;
}): EffectivePaneSizing {
  const runtimeSizing = input.isMobile
    ? EMPTY_PANE_RUNTIME_SIZING
    : normalizePaneRuntimeSizing(input.runtimeSizing);
  const primaryMaxWidthPx = input.routeWidth.maxWidthPx;
  const routeMinWidthPx = input.routeWidth.minWidthPx;
  const primaryMinWidthPx = input.isMobile
    ? routeMinWidthPx
    : Math.min(
        primaryMaxWidthPx,
        Math.max(routeMinWidthPx, runtimeSizing.minWidthPx ?? routeMinWidthPx)
      );
  const primaryWidthPx = Math.min(
    primaryMaxWidthPx,
    Math.max(primaryMinWidthPx, Math.round(input.storedWidthPx))
  );
  const extraWidthPx = input.isMobile ? 0 : runtimeSizing.extraWidthPx;

  return {
    primaryWidthPx,
    primaryMinWidthPx,
    primaryMaxWidthPx,
    renderedWidthPx: primaryWidthPx + extraWidthPx,
    renderedMinWidthPx: primaryMinWidthPx + extraWidthPx,
    renderedMaxWidthPx: primaryMaxWidthPx + extraWidthPx,
    extraWidthPx,
    storedWidthCorrectionPx:
      !input.isMobile && input.storedWidthPx < primaryMinWidthPx
        ? primaryMinWidthPx
        : null,
  };
}
