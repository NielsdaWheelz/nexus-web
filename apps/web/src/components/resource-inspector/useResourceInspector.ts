"use client";

import { useMemo } from "react";
import {
  planInspectorSurfaces,
  type InspectorDomainBodies,
} from "@/components/resource-inspector/inspectorSurfaces";
import { usePaneCompanion, type PaneCompanion } from "@/lib/panes/paneChrome";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";

export interface UseResourceInspectorParams {
  /** The subject's capability scheme. */
  scheme: ResourceScheme;
  /** The published subject handle, or null while the subject is unavailable. */
  handle: string | null;
  /** The route-owned bodies the subject's policy requires, and only those. */
  bodies: InspectorDomainBodies;
}

/** Compose route-owned bodies into the pane's shared Inspector and Find host. */
export function useResourceInspector({
  scheme,
  handle,
  bodies,
}: UseResourceInspectorParams): void {
  const policy = RESOURCE_CAPABILITIES[scheme].inspector;
  const { contents, members, linkedItems, forks } = bodies;
  if (
    members != null &&
    RESOURCE_CAPABILITIES[scheme].sharing !== "LibraryMembership"
  ) {
    throw new Error(
      `Resource Inspector Members requires LibraryMembership sharing: ${scheme}`,
    );
  }
  const companion = useMemo<PaneCompanion | null>(() => {
    if (!policy || handle === null) return null;
    const plan = planInspectorSurfaces({
      policy,
      bodies: { contents, members, linkedItems, forks },
    });
    return { groupId: "resource-inspector", ...plan };
  }, [contents, forks, handle, linkedItems, members, policy]);
  usePaneCompanion(companion);
}
