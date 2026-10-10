"use client";

import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  SubjectDossier,
  type DossierCitationActivate,
} from "@/components/dossier/DossierSurface";
import { companionAction } from "@/components/resource-inspector/companionAction";
import {
  planInspectorSurfaces,
  type InspectorDomainBodies,
} from "@/components/resource-inspector/inspectorSurfaces";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { dispatchReaderSourceActivation } from "@/lib/resourceGraph/citations";
import { hasSamePaneResource } from "@/lib/panes/paneRouteModel";
import {
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneCompanionAction,
} from "@/lib/panes/panePublications";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { activateResource } from "@/lib/resources/activation";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";

export interface UseResourceInspectorParams {
  /** The subject's capability scheme, which is also its dossier scheme. */
  scheme: ResourceScheme;
  /** The dossier subject handle, or null while no subject exists (a new chat). */
  handle: string | null;
  /** The route-owned bodies the subject's policy requires, and only those. */
  bodies: InspectorDomainBodies;
  /** The pane's transient find results; never a durable tab or the default. */
  searchResults?: ReactNode;
  /** The pane's own citation routing; by default citations open as panes. */
  onCitationActivate?: DossierCitationActivate;
}

export interface ResourceInspectorComposition {
  /** The one action eligible for primary chrome, or null without an inspector. */
  companionAction: PaneCompanionAction | null;
}

/**
 * The one resource-pane inspector composition: the pane's bodies plus the
 * subject's Dossier tab, published once per change, and the companion action
 * that opens the remembered tab while it is published, else the default. The
 * Dossier body is one element per subject: its commands read the latest pane
 * through a ref, so pane re-renders never remount it.
 */
export function useResourceInspector({
  scheme,
  handle,
  bodies,
  searchResults,
  onCitationActivate,
}: UseResourceInspectorParams): ResourceInspectorComposition {
  const paneRuntime = usePaneRuntime();
  const policy = RESOURCE_CAPABILITIES[scheme].inspectorPolicy;
  const { contents, members, linkedItems, forks } = bodies;
  if (
    members != null &&
    RESOURCE_CAPABILITIES[scheme].sharing !== "LibraryMembership"
  ) {
    throw new Error(
      `Resource Inspector Members requires LibraryMembership sharing: ${scheme}`,
    );
  }

  const latest = useRef({ onCitationActivate, paneRuntime });
  latest.current = { onCitationActivate, paneRuntime };
  const activateCitation = useCallback<DossierCitationActivate>(
    (activation, target, disposition) => {
      const { onCitationActivate, paneRuntime: runtime } = latest.current;
      if (onCitationActivate)
        return onCitationActivate(activation, target, disposition);
      if (target) dispatchReaderSourceActivation(target);
      if (!runtime) return;
      // Following into the pane's own resource only reveals the target there.
      const here =
        runtime.resourceRef === activation.resource_ref ||
        (activation.href !== null &&
          hasSamePaneResource(runtime.href, activation.href));
      if (disposition.kind === "Follow" && here) return;
      activateResource(activation, {
        labelHint: target?.label,
        activateTarget: runtime.activateTarget,
        disposition,
      });
    },
    [],
  );
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
            onCitationActivate: activateCitation,
            onViewMediaEvidence: viewMediaEvidence,
          })
        : null,
    [activateCitation, handle, policy, scheme, viewMediaEvidence],
  );
  const publication = useMemo(() => {
    if (!policy || !dossierBody) return null;
    const plan = planInspectorSurfaces({
      policy,
      bodies: { contents, members, linkedItems, forks },
      dossierBody,
      searchResultsBody: searchResults,
    });
    return normalizePaneSecondaryPublication({
      groupId: "resource-inspector",
      surfaces: plan.surfaces,
      defaultSurfaceId: plan.defaultSurfaceId,
      ...(plan.transientSurfaces.length > 0
        ? { transientSurfaces: plan.transientSurfaces }
        : {}),
    });
  }, [
    contents,
    dossierBody,
    forks,
    linkedItems,
    members,
    policy,
    searchResults,
  ]);
  const requestSurface = usePaneSecondary(publication);

  // Never rewrite the remembered tab: the host shows the default while it is
  // unpublished, so a later publication brings it back.
  const secondaryPane = paneRuntime?.secondaryPane ?? null;
  const remembered = secondaryPane?.activeSurfaceId ?? null;
  const openTarget =
    publication &&
    remembered &&
    secondaryPublicationIncludesSurface(publication, remembered)
      ? remembered
      : (publication?.defaultSurfaceId ?? null);
  const openTargetRef = useRef(openTarget);
  openTargetRef.current = openTarget;
  const onOpen = useCallback(
    (trigger: HTMLButtonElement | null) => {
      if (openTargetRef.current)
        requestSurface(openTargetRef.current, { returnFocusTo: trigger });
    },
    [requestSurface],
  );
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const onClose = useCallback(
    () => closeSecondaryPane?.(),
    [closeSecondaryPane],
  );

  const paneId = paneRuntime?.paneId ?? null;
  const expanded =
    secondaryPane?.groupId === "resource-inspector" &&
    secondaryPane.visibility === "visible" &&
    paneRuntime?.transientSecondarySurface === null;
  const companion = useMemo(
    () =>
      publication !== null && paneId !== null
        ? companionAction({
            expanded,
            regionId: paneSecondaryRegionId(paneId, "resource-inspector"),
            onOpen,
            onClose,
          })
        : null,
    [expanded, onClose, onOpen, paneId, publication],
  );
  return { companionAction: companion };
}
