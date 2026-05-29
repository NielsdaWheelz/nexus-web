"use client";

import type { PaneWidthContract } from "@/lib/panes/paneRouteModel";

export interface WorkspacePrimaryMetrics {
  primaryMinWidthPx: number;
  primaryDefaultWidthPx: number;
}

export type PaneRuntimePrimaryWidth =
  | { kind: "workspace" }
  | { kind: "intrinsic"; widthPx: number };

export interface PaneRuntimeLayout {
  primaryWidth: PaneRuntimePrimaryWidth;
  fixedPrimaryChromeWidthPx: number;
}

export interface EffectivePaneSizing {
  primaryWidthPx: number;
  primaryMinWidthPx: number;
  primaryMaxWidthPx: number;
  renderedPrimarySlotWidthPx: number;
  renderedPrimarySlotMinWidthPx: number;
  renderedPrimarySlotMaxWidthPx: number;
  fixedPrimaryChromeWidthPx: number;
  storedWidthCorrectionPx: number | null;
}

export const DEFAULT_PANE_RUNTIME_LAYOUT: PaneRuntimeLayout = {
  primaryWidth: { kind: "workspace" },
  fixedPrimaryChromeWidthPx: 0,
};

export function normalizePaneRuntimeLayout(
  layout: PaneRuntimeLayout
): PaneRuntimeLayout {
  if (
    !Number.isFinite(layout.fixedPrimaryChromeWidthPx) ||
    layout.fixedPrimaryChromeWidthPx < 0
  ) {
    throw new Error("Pane runtime fixed chrome width must be non-negative.");
  }
  let primaryWidth: PaneRuntimePrimaryWidth;
  switch (layout.primaryWidth.kind) {
    case "workspace":
      primaryWidth = { kind: "workspace" };
      break;
    case "intrinsic":
      if (
        !Number.isFinite(layout.primaryWidth.widthPx) ||
        layout.primaryWidth.widthPx <= 0
      ) {
        throw new Error("Pane runtime intrinsic width must be positive.");
      }
      primaryWidth = {
        kind: "intrinsic",
        widthPx: Math.ceil(layout.primaryWidth.widthPx),
      };
      break;
    default: {
      const exhaustive: never = layout.primaryWidth;
      throw new Error(`Unhandled pane runtime primary width: ${exhaustive}`);
    }
  }
  return {
    primaryWidth,
    fixedPrimaryChromeWidthPx: Math.ceil(layout.fixedPrimaryChromeWidthPx),
  };
}

export function isEmptyPaneRuntimeLayout(layout: PaneRuntimeLayout): boolean {
  return (
    layout.primaryWidth.kind === "workspace" &&
    layout.fixedPrimaryChromeWidthPx === 0
  );
}

export function resolveEffectivePaneSizing(input: {
  storedWidthPx: number;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  routeWidth: PaneWidthContract;
  runtimeLayout: PaneRuntimeLayout;
  isMobile: boolean;
}): EffectivePaneSizing {
  const runtimeLayout = input.isMobile
    ? DEFAULT_PANE_RUNTIME_LAYOUT
    : normalizePaneRuntimeLayout(input.runtimeLayout);
  const workspaceMinWidthPx = Math.ceil(input.workspacePrimaryMetrics.primaryMinWidthPx);
  const intrinsicWidthPx =
    !input.isMobile &&
    input.routeWidth.allowsIntrinsicPrimaryWidth &&
    runtimeLayout.primaryWidth.kind === "intrinsic"
      ? runtimeLayout.primaryWidth.widthPx
      : null;
  const primaryMinWidthPx = intrinsicWidthPx ?? workspaceMinWidthPx;
  const primaryMaxWidthPx = Math.max(
    input.routeWidth.maxWidthPx,
    primaryMinWidthPx,
  );
  const storedWidthPx = Number.isFinite(input.storedWidthPx)
    ? Math.round(input.storedWidthPx)
    : Math.ceil(input.workspacePrimaryMetrics.primaryDefaultWidthPx);
  const primaryWidthPx = Math.min(
    primaryMaxWidthPx,
    Math.max(primaryMinWidthPx, storedWidthPx)
  );
  const fixedPrimaryChromeWidthPx = input.isMobile
    ? 0
    : runtimeLayout.fixedPrimaryChromeWidthPx;

  return {
    primaryWidthPx,
    primaryMinWidthPx,
    primaryMaxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx + fixedPrimaryChromeWidthPx,
    renderedPrimarySlotMinWidthPx: primaryMinWidthPx + fixedPrimaryChromeWidthPx,
    renderedPrimarySlotMaxWidthPx: primaryMaxWidthPx + fixedPrimaryChromeWidthPx,
    fixedPrimaryChromeWidthPx,
    storedWidthCorrectionPx:
      !input.isMobile && storedWidthPx < primaryMinWidthPx
        ? primaryMinWidthPx
        : null,
  };
}
