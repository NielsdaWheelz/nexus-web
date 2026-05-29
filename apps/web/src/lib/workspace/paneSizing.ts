"use client";

import type { PaneWidthContract } from "@/lib/panes/paneRouteModel";

export interface WorkspacePrimaryMetrics {
  primaryMinWidthPx: number;
  primaryDefaultWidthPx: number;
}

export type PaneRuntimePrimaryWidth =
  | { kind: "workspace" }
  | { kind: "intrinsic"; widthPx: number };

export interface PaneRuntimeSizing {
  primaryWidth: PaneRuntimePrimaryWidth;
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

export const DEFAULT_PANE_RUNTIME_SIZING: PaneRuntimeSizing = {
  primaryWidth: { kind: "workspace" },
  extraWidthPx: 0,
};

export function normalizePaneRuntimeSizing(
  sizing: PaneRuntimeSizing
): PaneRuntimeSizing {
  if (!Number.isFinite(sizing.extraWidthPx) || sizing.extraWidthPx < 0) {
    throw new Error("Pane runtime sizing extra width must be non-negative.");
  }
  let primaryWidth: PaneRuntimePrimaryWidth;
  switch (sizing.primaryWidth.kind) {
    case "workspace":
      primaryWidth = { kind: "workspace" };
      break;
    case "intrinsic":
      if (
        !Number.isFinite(sizing.primaryWidth.widthPx) ||
        sizing.primaryWidth.widthPx <= 0
      ) {
        throw new Error("Pane runtime intrinsic width must be positive.");
      }
      primaryWidth = {
        kind: "intrinsic",
        widthPx: Math.ceil(sizing.primaryWidth.widthPx),
      };
      break;
    default: {
      const exhaustive: never = sizing.primaryWidth;
      throw new Error(`Unhandled pane runtime primary width: ${exhaustive}`);
    }
  }
  const extraWidthPx = Math.ceil(sizing.extraWidthPx);
  return { primaryWidth, extraWidthPx };
}

export function isEmptyPaneRuntimeSizing(sizing: PaneRuntimeSizing): boolean {
  return sizing.primaryWidth.kind === "workspace" && sizing.extraWidthPx === 0;
}

export function resolveEffectivePaneSizing(input: {
  storedWidthPx: number;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  routeWidth: PaneWidthContract;
  runtimeSizing: PaneRuntimeSizing;
  isMobile: boolean;
}): EffectivePaneSizing {
  const runtimeSizing = input.isMobile
    ? DEFAULT_PANE_RUNTIME_SIZING
    : normalizePaneRuntimeSizing(input.runtimeSizing);
  const workspaceMinWidthPx = Math.ceil(input.workspacePrimaryMetrics.primaryMinWidthPx);
  const intrinsicWidthPx =
    !input.isMobile &&
    input.routeWidth.allowsIntrinsicPrimaryWidth &&
    runtimeSizing.primaryWidth.kind === "intrinsic"
      ? runtimeSizing.primaryWidth.widthPx
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
      !input.isMobile && storedWidthPx < primaryMinWidthPx
        ? primaryMinWidthPx
        : null,
  };
}
