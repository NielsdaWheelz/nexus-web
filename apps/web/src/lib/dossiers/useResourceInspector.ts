"use client";

// `useResourceInspector` — the SOLE resource-pane composition boundary (A14).
// A single mounted primary pane calls it; it:
//  - reads the subject's typed `inspectorPolicy` from `resourceCapabilities`;
//  - accepts ONLY the route-owned domain bodies the capability requires;
//  - creates ONE subject-keyed external `DossierControllerStore` (lazy
//    useState + useRef, effect-cleanup disposal — NEVER useMemo-created, never
//    disposed during render, never module-global);
//  - publishes ONE memoized `PaneSecondaryPublication` whose Dossier body is
//    reference-stable per subject (stream tokens mutate the store, not the
//    publication — the primary pane never re-renders per token);
//  - returns the ONE shared Companion disclosure action;
//  - restores a still-valid workspace tab else the first published default;
//  - reconciles an unsupported active surface to the default pre-paint on
//    subject/capability change (no closed/stale-frame flash);
//  - resets revision selection to Current on the Inspector's hidden→visible
//    transition (an observer — NOT a body mount effect).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createElement, type ReactNode } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import {
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import {
  createDossierControllerStore,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";
import DossierSurface, {
  type DossierCitationActivate,
} from "@/components/dossier/DossierSurface";
import { companionAction } from "@/components/resource-inspector/companionAction";
import {
  planInspectorSurfaces,
  type InspectorDomainBodies,
} from "@/components/resource-inspector/inspectorSurfaces";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  activateResource,
  secondaryActivationForResource,
} from "@/lib/resources/activation";
import { hasSamePaneResource } from "@/lib/panes/paneIdentity";

export interface UseResourceInspectorParams {
  /** The subject's capability scheme (RESOURCE_CAPABILITIES key) — also the A9
   * subject_scheme. */
  scheme: ResourceScheme;
  /** The A9 subject handle, or null when no subject exists yet (e.g.
   * /conversations/new): the Inspector is then unpublished. */
  handle: string | null;
  /** Route-owned domain bodies the capability requires (only these). */
  bodies: InspectorDomainBodies;
  /** Citation activation routed through the pane (kept reference-stable here so
   * it never destabilizes the Dossier body identity). */
  onCitationActivate?: DossierCitationActivate;
}

export interface ResourceInspectorComposition {
  /** The Companion header action to fold into the pane's own primary chrome
   * `actions`, or null when the subject has no Inspector. */
  companionAction: PaneHeaderAction | null;
}

interface StoreBox {
  key: string;
  store: DossierControllerStore;
}

export function useResourceInspector({
  scheme,
  handle,
  bodies,
  onCitationActivate,
}: UseResourceInspectorParams): ResourceInspectorComposition {
  const paneRuntime = usePaneRuntime();
  const paneId = paneRuntime?.paneId ?? null;
  const secondaryPane = paneRuntime?.secondaryPane ?? null;
  const secondaryActivation = paneRuntime?.secondaryActivation ?? null;
  const acknowledgeSecondaryActivation =
    paneRuntime?.acknowledgeSecondaryActivation;

  const policy = RESOURCE_CAPABILITIES[scheme].inspectorPolicy;
  const eligible = policy !== null && handle !== null;
  const subjectKey = eligible ? `${scheme}:${handle}` : null;

  // --- Subject-keyed store: lazy create, dispose the PRIOR in an effect ------
  const [storeBox, setStoreBox] = useState<StoreBox | null>(() =>
    subjectKey !== null
      ? { key: subjectKey, store: createDossierControllerStore({ scheme, handle: handle as string }) }
      : null,
  );
  if ((storeBox?.key ?? null) !== subjectKey) {
    // Adjust state during render on subject change (creation is allowed here;
    // disposal of the prior happens in the effect below — never during render).
    setStoreBox(
      subjectKey !== null
        ? { key: subjectKey, store: createDossierControllerStore({ scheme, handle: handle as string }) }
        : null,
    );
  }
  const store = storeBox?.store ?? null;
  // Dispose exactly the prior store on subject change and the current store on
  // true owner unmount. The epoch defers disposal by one microtask so React
  // StrictMode's simulated cleanup/setup pair can reclaim the same store
  // without disposing it; a changed store is always disposed regardless.
  const currentStoreRef = useRef<DossierControllerStore | null>(store);
  currentStoreRef.current = store;
  const lifecycleEpochRef = useRef(0);
  useEffect(() => {
    if (!store) return;
    const ownedStore = store;
    const epoch = lifecycleEpochRef.current + 1;
    lifecycleEpochRef.current = epoch;
    return () => {
      queueMicrotask(() => {
        if (
          currentStoreRef.current !== ownedStore ||
          lifecycleEpochRef.current === epoch
        ) {
          ownedStore.dispose();
        }
      });
    };
  }, [store]);

  // --- Stable citation-activation (protects the Dossier body identity) -------
  const citationCommandsRef = useRef({
    onCitationActivate,
    paneRuntime,
  });
  citationCommandsRef.current = {
    onCitationActivate,
    paneRuntime,
  };
  const stableCitationActivate = useCallback<DossierCitationActivate>(
    (activation, target, event) => {
      const commands = citationCommandsRef.current;
      if (commands.onCitationActivate) {
        commands.onCitationActivate(activation, target, event);
        return;
      }
      if (target) {
        dispatchReaderSourceActivation(target);
      }
      const runtime = commands.paneRuntime;
      if (event?.shiftKey) {
        activateResource(activation, {
          labelHint: target?.label,
          openInNewPane: runtime?.openInNewPane,
          newPane: true,
        });
        return;
      }
      const isSecondaryActivation =
        secondaryActivationForResource(activation) !== null;
      if (
        !isSecondaryActivation &&
        (
          runtime?.resourceRef === activation.resourceRef ||
          (
            runtime &&
            activation.href &&
            hasSamePaneResource(runtime.href, activation.href)
          )
        )
      ) {
        return;
      }
      activateResource(activation, {
        labelHint: target?.label,
        navigate: runtime ? (href) => runtime.router.push(href) : undefined,
        openInNewPane: runtime?.openInNewPane,
      });
    },
    [],
  );
  const viewMediaEvidence = useCallback(() => {
    citationCommandsRef.current.paneRuntime?.requestSecondarySurface(
      "resource-evidence",
    );
  }, []);

  // --- Reference-stable Dossier body (stream tokens do NOT recreate it) ------
  const dossierBody = useMemo<ReactNode>(
    () =>
      store
        ? createElement(DossierSurface, {
            store,
            onViewMediaEvidence: viewMediaEvidence,
            onCitationActivate: stableCitationActivate,
          })
        : null,
    [store, stableCitationActivate, viewMediaEvidence],
  );

  // --- One memoized publication (stable when the pane's bodies are stable) ---
  const contents = bodies.contents;
  const linkedItems = bodies.linkedItems;
  const forks = bodies.forks;
  const publication = useMemo<PaneSecondaryPublication | null>(() => {
    if (!policy || !store || dossierBody == null) return null;
    const plan = planInspectorSurfaces({
      policy,
      bodies: { contents, linkedItems, forks },
      dossierBody,
    });
    return normalizePaneSecondaryPublication({
      groupId: "resource-inspector",
      surfaces: plan.surfaces,
      defaultSurfaceId: plan.defaultSurfaceId,
    });
  }, [policy, store, dossierBody, contents, linkedItems, forks]);
  usePaneSecondary(publication);

  // --- Companion action ------------------------------------------------------
  const regionId =
    paneId !== null ? paneSecondaryRegionId(paneId, "resource-inspector") : "";
  const inspectorVisible =
    secondaryPane?.groupId === "resource-inspector" &&
    secondaryPane?.visibility === "visible";

  // Restore a still-valid workspace tab, else the first published default.
  const storedActive = secondaryPane?.activeSurfaceId ?? null;
  const openTarget =
    publication &&
    storedActive &&
    secondaryPublicationIncludesSurface(publication, storedActive)
      ? storedActive
      : (publication?.defaultSurfaceId ?? null);
  const openTargetRef = useRef(openTarget);
  openTargetRef.current = openTarget;

  const requestSecondarySurface = paneRuntime?.requestSecondarySurface;
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const onOpen = useCallback(
    (trigger: HTMLButtonElement | null) => {
      const target = openTargetRef.current;
      if (target && requestSecondarySurface) {
        requestSecondarySurface(target, { returnFocusTo: trigger });
      }
    },
    [requestSecondarySurface],
  );
  const onClose = useCallback(() => {
    closeSecondaryPane?.();
  }, [closeSecondaryPane]);

  const companion = useMemo<PaneHeaderAction | null>(
    () =>
      eligible && publication !== null && paneId !== null
        ? companionAction({
            expanded: Boolean(inspectorVisible),
            regionId,
            onOpen,
            onClose,
          })
        : null,
    [eligible, publication, paneId, inspectorVisible, regionId, onOpen, onClose],
  );

  // --- Render-time stale-surface reconciliation (pre-paint; no stale frame) --
  const setSecondarySurface = paneRuntime?.setSecondarySurface;
  const defaultSurfaceId = publication?.defaultSurfaceId ?? null;
  useLayoutEffect(() => {
    if (!publication || !inspectorVisible || !storedActive || !setSecondarySurface) {
      return;
    }
    if (
      !secondaryPublicationIncludesSurface(publication, storedActive) &&
      defaultSurfaceId
    ) {
      // The active tab is no longer published (subject/capability changed):
      // correct to the default BEFORE paint so no closed/stale frame shows.
      setSecondarySurface(defaultSurfaceId);
    }
  }, [
    publication,
    inspectorVisible,
    storedActive,
    defaultSurfaceId,
    setSecondarySurface,
  ]);

  // --- Reset revision selection on Inspector hidden→visible (observer) -------
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const visibleNow = Boolean(inspectorVisible);
    if (visibleNow && store && secondaryActivation) {
      if (secondaryActivation.kind === "DossierRevision") {
        store.selectHistorical(secondaryActivation.revisionRef);
      } else {
        store.selectCurrent();
      }
      acknowledgeSecondaryActivation?.();
    } else if (visibleNow && !wasVisibleRef.current) {
      store?.resetRevisionSelection();
    }
    wasVisibleRef.current = visibleNow;
  }, [
    acknowledgeSecondaryActivation,
    inspectorVisible,
    secondaryActivation,
    store,
  ]);

  return { companionAction: companion };
}
