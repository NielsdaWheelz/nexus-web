"use client";

import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

export function getDefaultPaneWidthPx(
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): number {
  return Math.ceil(workspacePrimaryMetrics.primaryDefaultWidthPx);
}

export function clampPaneWidth(
  value: number,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): number {
  if (!Number.isFinite(value)) {
    return getDefaultPaneWidthPx(workspacePrimaryMetrics);
  }
  return Math.max(
    Math.ceil(workspacePrimaryMetrics.primaryMinWidthPx),
    Math.round(value),
  );
}

export function resolvePaneTransitionWidth(
  previousWidthPx: number,
  preserveWidth: boolean,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): number {
  if (preserveWidth) {
    return clampPaneWidth(previousWidthPx, workspacePrimaryMetrics);
  }
  return getDefaultPaneWidthPx(workspacePrimaryMetrics);
}
