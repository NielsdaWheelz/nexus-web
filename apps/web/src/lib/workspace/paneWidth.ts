"use client";

import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
} from "@/lib/workspace/workspaceHref";
import { resolvePaneRouteWidthContract } from "@/lib/panes/paneRouteModel";

export function getDefaultPaneWidthPx(href: string): number {
  const width = resolvePaneRouteWidthContract(href).defaultWidthPx;
  return clampPaneWidth(width, href);
}

export function clampPaneWidth(value: number, href?: string): number {
  const contract = resolvePaneRouteWidthContract(
    href ?? WORKSPACE_DEFAULT_FALLBACK_HREF
  );
  if (!Number.isFinite(value)) {
    return contract.defaultWidthPx;
  }
  return Math.min(
    contract.maxWidthPx,
    Math.max(contract.minWidthPx, Math.round(value))
  );
}

export function resolvePaneTransitionWidth(
  previousHref: string,
  nextHref: string,
  previousWidthPx: number,
  preserveWidth: boolean
): number {
  const previousContract = resolvePaneRouteWidthContract(previousHref);
  const nextContract = resolvePaneRouteWidthContract(nextHref);
  if (preserveWidth || previousContract.layoutKind === nextContract.layoutKind) {
    return clampPaneWidth(previousWidthPx, nextHref);
  }
  return getDefaultPaneWidthPx(nextHref);
}
