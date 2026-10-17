"use client";

import { createElement, useCallback, useMemo, useRef } from "react";
import { SubjectDossier } from "@/components/dossier/DossierSurface";
import {
  planInspectorSurfaces,
  type InspectorDomainBodies,
} from "@/components/resource-inspector/inspectorSurfaces";
import { usePaneCompanion, type PaneCompanion } from "@/lib/panes/paneChrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";

export interface UseResourceInspectorParams {
  /** The subject's capability scheme, which is also its dossier scheme. */
  scheme: ResourceScheme;
  /** The dossier subject handle, or null while no subject exists (a new chat). */
  handle: string | null;
  /** The route-owned bodies the subject's policy requires, and only those. */
  bodies: InspectorDomainBodies;
}

/**
 * The one resource-pane inspector composition: the pane's bodies plus the
 * subject's Dossier tab, published as the pane's Companion once per change;
 * the shell derives the Inspector action from it. The Dossier body is one
 * element per subject: its commands read the latest pane through a ref, so
 * pane re-renders never remount it.
 */
export function useResourceInspector({
  scheme,
  handle,
  bodies,
}: UseResourceInspectorParams): void {
  const paneRuntime = usePaneRuntime();
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

  const latest = useRef({ paneRuntime });
  latest.current = { paneRuntime };
  const viewMediaEvidence = useCallback(
    () =>
      latest.current.paneRuntime?.requestSecondarySurface("resource-connections"),
    [],
  );

  const dossierBody = useMemo(
    () =>
      policy && handle !== null
        ? createElement(SubjectDossier, {
            key: `${scheme}:${handle}`,
            scheme,
            handle,
            onViewMediaEvidence: viewMediaEvidence,
          })
        : null,
    [handle, policy, scheme, viewMediaEvidence],
  );
  const companion = useMemo<PaneCompanion | null>(() => {
    if (!policy || !dossierBody) return null;
    const plan = planInspectorSurfaces({
      policy,
      bodies: { contents, members, linkedItems, forks },
      dossierBody,
    });
    return { groupId: "resource-inspector", ...plan };
  }, [contents, dossierBody, forks, linkedItems, members, policy]);
  usePaneCompanion(companion);
}
