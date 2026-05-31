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
}

export interface EffectivePaneSizing {
  primaryWidthPx: number;
  primaryMinWidthPx: number;
  primaryMaxWidthPx: number;
  renderedPrimarySlotWidthPx: number;
  renderedPrimarySlotMinWidthPx: number;
  renderedPrimarySlotMaxWidthPx: number;
  fixedChromeWidthPx: number;
  storedWidthCorrectionPx: number | null;
}

export const DEFAULT_PANE_RUNTIME_LAYOUT: PaneRuntimeLayout = {
  primaryWidth: { kind: "workspace" },
};

export function normalizePaneRuntimeLayout(
  layout: PaneRuntimeLayout
): PaneRuntimeLayout {
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
  };
}

export function isEmptyPaneRuntimeLayout(layout: PaneRuntimeLayout): boolean {
  return layout.primaryWidth.kind === "workspace";
}

export function resolveEffectivePaneSizing(input: {
  storedWidthPx: number;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  routeWidth: PaneWidthContract;
  runtimeLayout: PaneRuntimeLayout;
  fixedChromeWidthPx: number;
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
  const fixedChromeWidthPx =
    input.isMobile || !Number.isFinite(input.fixedChromeWidthPx)
      ? 0
      : Math.max(0, Math.ceil(input.fixedChromeWidthPx));

  return {
    primaryWidthPx,
    primaryMinWidthPx,
    primaryMaxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMinWidthPx: primaryMinWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMaxWidthPx: primaryMaxWidthPx + fixedChromeWidthPx,
    fixedChromeWidthPx,
    storedWidthCorrectionPx:
      !input.isMobile && storedWidthPx < primaryMinWidthPx
        ? primaryMinWidthPx
        : null,
  };
}
