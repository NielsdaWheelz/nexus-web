"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  paneMountKey,
  resolvePaneRouteShareIdentity,
  type PaneBodyMode,
  type PaneRouteShareIdentity,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import {
  PaneRuntimeProvider,
  type PaneHostCommands,
} from "@/lib/panes/paneRuntime";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import PaneShell from "@/components/workspace/PaneShell";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import SecondaryPaneShell from "@/components/workspace/SecondaryPaneShell";
import WorkspacePaneStrip from "@/components/workspace/WorkspacePaneStrip";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { getBrowserViewportKind } from "@/lib/renderEnvironment/provider";
import { matchesKeyEvent } from "@/lib/keybindings";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import { useKeybindings } from "@/lib/keybindingsProvider";
import type {
  WorkspacePane,
  WorkspaceSecondaryPane,
} from "@/lib/workspace/model";
import {
  DEFAULT_PANE_RUNTIME_LAYOUT,
  normalizePaneRuntimeLayout,
  resolveEffectivePaneSizing,
  type EffectivePaneSizing,
  type PaneRuntimeLayout,
} from "@/lib/workspace/paneSizing";
import {
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
  type PaneTransientSecondarySurfaceId,
  type WorkspaceSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  arePaneFixedChromePublicationsEqual,
  getPublishedTransientSecondarySurface,
  normalizePaneFixedChromePublication,
  secondaryPublicationIncludesSurface,
  secondaryPublicationIncludesTransientSurface,
  type PaneFixedChromePublication,
  type PaneSecondaryPublication,
  type PaneTransientSecondarySurfacePublication,
} from "@/lib/panes/panePublications";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { useAdjacentPaneKeybindings } from "@/lib/workspace/adjacentPaneKeybindings";
import {
  resolveWorkspacePaneLabel,
  useWorkspaceStore,
  type WorkspacePaneLabelDescriptor,
} from "@/lib/workspace/store";
import { usePaneCanvas } from "./usePaneCanvas";
import { PaneRouteErrorBoundary } from "./PaneRouteErrorBoundary";
import PaneRouteBoundary from "./PaneRouteBoundary";
import {
  pruneRouteKeyedRecords,
  routeKeyedRecord,
} from "@/lib/panes/paneRouteKeyedRecords";
import { usePaneSecondaryPublicationRegistry } from "./usePaneSecondaryPublicationRegistry";
import styles from "./WorkspaceHost.module.css";

// ---------------------------------------------------------------------------
// WorkspaceHostPane - host-owned pane render model.
// ---------------------------------------------------------------------------

interface WorkspaceHostPane {
  pane: WorkspacePane;
  paneId: string;
  visitId: string;
  href: string;
  route: ResolvedPaneRouteModel;
  routeKey: string;
  routeShareIdentity: PaneRouteShareIdentity | null;
  label: string;
  labelState: "resolved" | "pending";
  bodyMode: PaneBodyMode;
  sizing: EffectivePaneSizing;
  runtimeSecondaryPane: WorkspaceSecondaryPane | null;
  secondaryPane: WorkspaceSecondaryPane | null;
  secondarySizing: WorkspaceSecondarySizing | null;
  secondaryPublication: PaneSecondaryPublication | null;
  transientSecondarySurface: PaneTransientSecondarySurfacePublication | null;
  transientSecondaryExpanded: boolean;
  transientSecondarySizing: WorkspaceSecondarySizing | null;
  transientSecondaryPaneId: string;
  fixedChromePublication: PaneFixedChromePublication | null;
  isActive: boolean;
  visibility: "visible" | "minimized";
  content: React.ReactNode;
}

interface PendingResponsivePaneSearchDelivery {
  readonly id: number;
  readonly paneId: string;
  readonly routeKey: string;
  readonly targetIsMobile: boolean;
}

interface RuntimePaneLayoutRecord {
  routeKey: string;
  layout: PaneRuntimeLayout;
}

interface PaneFixedChromePublicationRecord {
  routeKey: string;
  publication: PaneFixedChromePublication;
}

interface PaneTransientSecondaryActivationRecord {
  routeKey: string;
  surfaceId: PaneTransientSecondarySurfaceId;
  expanded: boolean;
  widthPx: number;
}

// ---------------------------------------------------------------------------
// ResolvedPaneRouteView — renders the resolved route or an unsupported message.
// ---------------------------------------------------------------------------

function ResolvedPaneRouteView({ route }: { route: ResolvedPaneRouteModel }) {
  if (route.id !== "unsupported") {
    return renderPane(route.id);
  }
  return (
    <div className={styles.unsupported}>
      This route is not yet supported in side-by-side pane mode: `
      {route.pathname}`
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaneRuntimeFrame - owns pane-scoped runtime capabilities for the whole pane
// shell, including chrome and routed body content.
// ---------------------------------------------------------------------------

function PaneRuntimeFrame({
  pane,
  isActive,
  routeKey,
  secondaryPane,
  transientSecondarySurface,
  publishPaneLayout,
  publishPaneSecondary,
  publishPaneFixedChrome,
  requestSecondarySurface,
  closeSecondaryPane,
  requestTransientSecondarySurface,
  closeTransientSecondarySurface,
  previewTransientSecondaryResult,
  children,
}: {
  pane: WorkspacePane;
  isActive: boolean;
  routeKey: string;
  secondaryPane: WorkspaceSecondaryPane | null;
  transientSecondarySurface: {
    readonly id: PaneTransientSecondarySurfaceId;
    readonly expanded: boolean;
  } | null;
  publishPaneLayout: (input: PaneLayoutPublication) => void;
  publishPaneSecondary: (input: {
    paneId: string;
    routeKey: string;
    publication: PaneSecondaryPublication | null;
  }) => void;
  publishPaneFixedChrome: (input: {
    paneId: string;
    routeKey: string;
    publication: PaneFixedChromePublication | null;
  }) => void;
  requestSecondarySurface: (
    primaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
    returnFocusTo?: HTMLElement | null,
  ) => void;
  closeSecondaryPane: (
    secondaryPaneId: string,
    focusAfterClose?: HTMLElement | null,
  ) => void;
  requestTransientSecondarySurface: (
    paneId: string,
    routeKey: string,
    surfaceId: PaneTransientSecondarySurfaceId,
    returnFocusTo?: HTMLElement | null,
  ) => void;
  closeTransientSecondarySurface: (paneId: string, routeKey: string) => void;
  previewTransientSecondaryResult: (paneId: string, routeKey: string) => void;
  children: React.ReactNode;
}) {
  const paneId = pane.id;
  const secondaryPaneId = secondaryPane?.id ?? null;
  const host = useMemo<PaneHostCommands>(
    () => ({
      setPaneLayout: (layout) => publishPaneLayout({ paneId, routeKey, layout }),
      requestSecondarySurface: (surfaceId, options) =>
        requestSecondarySurface(paneId, surfaceId, options?.returnFocusTo),
      closeSecondaryPane: (options) => {
        if (secondaryPaneId) {
          closeSecondaryPane(secondaryPaneId, options?.focusAfterClose);
        }
      },
      requestTransientSecondarySurface: (surfaceId, options) =>
        requestTransientSecondarySurface(
          paneId,
          routeKey,
          surfaceId,
          options?.returnFocusTo,
        ),
      closeTransientSecondarySurface: () =>
        closeTransientSecondarySurface(paneId, routeKey),
      previewTransientSecondaryResult: () =>
        previewTransientSecondaryResult(paneId, routeKey),
    }),
    [
      paneId,
      routeKey,
      secondaryPaneId,
      publishPaneLayout,
      requestSecondarySurface,
      closeSecondaryPane,
      requestTransientSecondarySurface,
      closeTransientSecondarySurface,
      previewTransientSecondaryResult,
    ],
  );
  const handlePaneSecondaryPublication = useCallback(
    (publication: PaneSecondaryPublication | null) => {
      publishPaneSecondary({ paneId, routeKey, publication });
    },
    [paneId, publishPaneSecondary, routeKey],
  );
  const handlePaneFixedChromePublication = useCallback(
    (publication: PaneFixedChromePublication | null) => {
      publishPaneFixedChrome({ paneId, routeKey, publication });
    },
    [paneId, publishPaneFixedChrome, routeKey],
  );

  return (
    <PaneRuntimeProvider
      pane={pane}
      isActive={isActive}
      secondaryPane={secondaryPane}
      transientSecondarySurface={transientSecondarySurface}
      host={host}
    >
      <PaneSecondaryContext.Provider value={handlePaneSecondaryPublication}>
        <PaneFixedChromeContext.Provider
          value={handlePaneFixedChromePublication}
        >
          <PaneRouteBoundary>{children}</PaneRouteBoundary>
        </PaneFixedChromeContext.Provider>
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>
  );
}

// ---------------------------------------------------------------------------
// PaneContent - renders the routed body content for a single pane.
// ---------------------------------------------------------------------------

const PaneContent = memo(function PaneContent({
  visitId,
  route,
}: {
  visitId: string;
  route: ResolvedPaneRouteModel;
}) {
  return (
    <div className={styles.routeShell}>
      <ResolvedPaneRouteView key={paneMountKey(route, visitId)} route={route} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// buildHostPane - builds the pane record consumed by the host layout.
// ---------------------------------------------------------------------------

interface PaneLayoutPublication {
  paneId: string;
  routeKey: string;
  layout: PaneRuntimeLayout | null;
}

function upsertOrDeletePaneLayoutRecord(
  current: ReadonlyMap<string, RuntimePaneLayoutRecord>,
  input: PaneLayoutPublication,
): ReadonlyMap<string, RuntimePaneLayoutRecord> {
  const layout = input.layout;
  const existing = current.get(input.paneId);
  if (layout === null) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  if (
    existing?.routeKey === input.routeKey &&
    existing.layout.primaryWidth.kind === layout.primaryWidth.kind &&
    (layout.primaryWidth.kind === "workspace" ||
      (existing.layout.primaryWidth.kind === "intrinsic" &&
        existing.layout.primaryWidth.widthPx === layout.primaryWidth.widthPx))
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { routeKey: input.routeKey, layout });
  return next;
}

function upsertOrDeletePaneFixedChromePublicationRecord(
  current: ReadonlyMap<string, PaneFixedChromePublicationRecord>,
  input: {
    paneId: string;
    routeKey: string;
    publication: PaneFixedChromePublication | null;
  },
): ReadonlyMap<string, PaneFixedChromePublicationRecord> {
  const existing = current.get(input.paneId);
  if (!input.publication) {
    if (!existing || existing.routeKey !== input.routeKey) return current;
    const next = new Map(current);
    next.delete(input.paneId);
    return next;
  }
  const publication = input.publication;
  if (
    existing?.routeKey === input.routeKey &&
    arePaneFixedChromePublicationsEqual(existing.publication, publication)
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(input.paneId, { routeKey: input.routeKey, publication });
  return next;
}

function buildHostPane(input: {
  pane: WorkspacePane;
  descriptor: WorkspacePaneLabelDescriptor;
  isActive: boolean;
  runtimeLayout: PaneRuntimeLayout;
  runtimeLayoutResolved: boolean;
  secondaryPublication: PaneSecondaryPublication | null;
  transientSecondaryActivation: PaneTransientSecondaryActivationRecord | null;
  fixedChromePublication: PaneFixedChromePublication | null;
  isMobile: boolean;
  columnWidthPx: number;
}): WorkspaceHostPane {
  const { routeKey, route, label, labelState } = input.descriptor;
  const href = input.pane.currentVisit.href;
  const secondaryPane = input.pane.secondary;
  const hasVisibleSecondaryGroupMismatch =
    secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    secondaryPane.groupId !== input.secondaryPublication.groupId;
  const hasVisibleStaleSurface =
    secondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    !hasVisibleSecondaryGroupMismatch &&
    !secondaryPublicationIncludesSurface(
      input.secondaryPublication,
      secondaryPane.activeSurfaceId,
    );
  const durableDefaultSurfaceId =
    input.secondaryPublication?.defaultSurfaceId ?? null;
  const renderSecondaryPane =
    hasVisibleStaleSurface &&
    secondaryPane &&
    durableDefaultSurfaceId !== null
      ? {
          ...secondaryPane,
          activeSurfaceId: durableDefaultSurfaceId,
        }
      : secondaryPane;
  const runtimeSecondaryPane = hasVisibleSecondaryGroupMismatch
    ? null
    : renderSecondaryPane;
  const visibleSecondaryPane =
    renderSecondaryPane?.visibility === "visible" &&
    input.secondaryPublication &&
    !hasVisibleSecondaryGroupMismatch
      ? renderSecondaryPane
      : renderSecondaryPane?.visibility === "collapsed"
        ? renderSecondaryPane
        : null;
  const transientSecondarySurface =
    input.transientSecondaryActivation &&
    input.transientSecondaryActivation.routeKey === routeKey
      ? getPublishedTransientSecondarySurface(
          input.secondaryPublication,
          input.transientSecondaryActivation.surfaceId,
        )
      : null;
  const transientSecondaryExpanded = Boolean(
    transientSecondarySurface && input.transientSecondaryActivation?.expanded,
  );
  const transientSecondarySizing =
    !input.isMobile && transientSecondarySurface && input.secondaryPublication
      ? resolveEffectiveSecondarySizing({
          storedWidthPx:
            visibleSecondaryPane?.widthPx ??
            input.transientSecondaryActivation?.widthPx ??
            getSecondaryWidthPolicy(input.secondaryPublication.groupId)
              .defaultWidthPx,
          policy: getSecondaryWidthPolicy(input.secondaryPublication.groupId),
        })
      : null;

  return {
    pane: input.pane,
    paneId: input.pane.id,
    visitId: input.pane.currentVisit.id,
    href,
    route,
    routeKey,
    routeShareIdentity: resolvePaneRouteShareIdentity(route, label),
    label,
    labelState,
    bodyMode: route.bodyMode,
    runtimeSecondaryPane,
    secondaryPane: transientSecondarySurface ? null : visibleSecondaryPane,
    sizing: resolveEffectivePaneSizing({
      storedWidthPx: input.pane.primaryWidthPx ?? Number.NaN,
      columnWidthPx: input.columnWidthPx,
      routeWidth: route.width,
      runtimeLayout: input.runtimeLayout,
      runtimeLayoutResolved: input.runtimeLayoutResolved,
      fixedChromeWidthPx: input.fixedChromePublication?.widthPx ?? 0,
      isMobile: input.isMobile,
    }),
    secondarySizing:
      !input.isMobile && visibleSecondaryPane && !transientSecondarySurface
        ? resolveEffectiveSecondarySizing({
            storedWidthPx: visibleSecondaryPane.widthPx,
            policy: getSecondaryWidthPolicy(visibleSecondaryPane.groupId),
          })
        : null,
    secondaryPublication: input.secondaryPublication,
    transientSecondarySurface,
    transientSecondaryExpanded,
    transientSecondarySizing,
    transientSecondaryPaneId:
      visibleSecondaryPane?.id ??
      `pane-${input.pane.id}-transient-resource-inspector`,
    fixedChromePublication: input.isMobile
      ? null
      : input.fixedChromePublication,
    isActive: input.isActive,
    visibility: input.pane.visibility,
    content: (
      <PaneContent visitId={input.pane.currentVisit.id} route={route} />
    ),
  };
}

// ---------------------------------------------------------------------------
// WorkspaceHost — the top-level pane orchestrator. Reads workspace state,
// builds pane descriptors, and renders the shell layout with pane strip.
// ---------------------------------------------------------------------------

function WorkspaceHost() {
  const {
    state,
    runtimeLabelByPaneId,
    pendingPaneEntryDeliveryByPaneId,
    activatePane,
    closePane,
    resizePrimaryPane,
    requestSecondarySurface,
    updateSecondaryPane,
    minimizePane,
    restorePane,
    columnWidthPx,
  } = useWorkspaceStore();
  const [runtimeLayoutByPaneId, setRuntimeLayoutByPaneId] = useState<
    ReadonlyMap<string, RuntimePaneLayoutRecord>
  >(() => new Map());
  const {
    records: secondaryPublicationByPaneId,
    publish: publishSecondaryPublicationRecord,
    prune: pruneSecondaryPublicationRecords,
    current: currentSecondaryPublication,
  } = usePaneSecondaryPublicationRegistry();
  const [
    transientSecondaryActivationByPaneId,
    setTransientSecondaryActivationByPaneId,
  ] = useState<Map<string, PaneTransientSecondaryActivationRecord>>(
    () => new Map(),
  );
  const [fixedChromePublicationByPaneId, setFixedChromePublicationByPaneId] =
    useState<ReadonlyMap<string, PaneFixedChromePublicationRecord>>(() => new Map());
  const keybindings = useKeybindings();

  // --- Mobile viewport and pane focus state ---
  const isMobile = useIsMobileViewport();
  const layoutMode = isMobile ? "mobile" : "desktop";
  const paneWrapRefById = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingPaneFocusPaneIdRef = useRef<string | null>(null);
  const activePaneVisitIdRef = useRef<string | null>(null);
  activePaneVisitIdRef.current =
    state.panes.find((pane) => pane.id === state.activePrimaryPaneId)
      ?.currentVisit.id ?? null;
  const pendingPaneEntryDeliveryByPaneIdRef = useRef(
    pendingPaneEntryDeliveryByPaneId,
  );
  pendingPaneEntryDeliveryByPaneIdRef.current =
    pendingPaneEntryDeliveryByPaneId;
  const previousIsMobileRef = useRef(isMobile);
  const nextResponsivePaneSearchDeliveryIdRef = useRef(0);
  const [
    pendingResponsivePaneSearchDelivery,
    setPendingResponsivePaneSearchDelivery,
  ] = useState<PendingResponsivePaneSearchDelivery | null>(null);
  const secondaryReturnFocusByPaneIdRef = useRef<Map<string, HTMLElement | { element: HTMLElement; preventScroll: true }>>(
    new Map(),
  );
  const primaryPanes = state.panes;
  const paneDescriptors = useMemo(
    () =>
      primaryPanes.map((pane) => ({
        pane,
        descriptor: resolveWorkspacePaneLabel(pane, runtimeLabelByPaneId),
      })),
    [primaryPanes, runtimeLabelByPaneId],
  );
  const currentRouteKeyByPaneId = useMemo(
    () =>
      new Map(
        paneDescriptors.map(({ pane, descriptor }) => [
          pane.id,
          descriptor.routeKey,
        ]),
      ),
    [paneDescriptors],
  );
  const currentRouteKeyByPaneIdRef = useRef(currentRouteKeyByPaneId);
  currentRouteKeyByPaneIdRef.current = currentRouteKeyByPaneId;
  const transientSecondaryActivationByPaneIdRef = useRef(
    transientSecondaryActivationByPaneId,
  );
  transientSecondaryActivationByPaneIdRef.current =
    transientSecondaryActivationByPaneId;
  const publishPaneLayout = useCallback(
    (input: PaneLayoutPublication) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      const normalizedInput = {
        ...input,
        layout: input.layout ? normalizePaneRuntimeLayout(input.layout) : null,
      };
      setRuntimeLayoutByPaneId((current) =>
        upsertOrDeletePaneLayoutRecord(current, normalizedInput),
      );
    },
    [],
  );

  const publishPaneSecondary = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneSecondaryPublication | null;
    }) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      // The primary action and its secondary publication commit through
      // different owners (PaneShell and WorkspaceHost). Accept the publication
      // in the command guard synchronously so a newly visible Companion action
      // cannot lose its first valid click before the host render catches up.
      publishSecondaryPublicationRecord(input);
    },
    [publishSecondaryPublicationRecord],
  );

  const publishPaneFixedChrome = useCallback(
    (input: {
      paneId: string;
      routeKey: string;
      publication: PaneFixedChromePublication | null;
    }) => {
      if (
        currentRouteKeyByPaneIdRef.current.get(input.paneId) !== input.routeKey
      ) {
        return;
      }
      const normalizedInput = {
        ...input,
        publication: input.publication
          ? normalizePaneFixedChromePublication(input.publication)
          : null,
      };
      setFixedChromePublicationByPaneId((current) =>
        upsertOrDeletePaneFixedChromePublicationRecord(
          current,
          normalizedInput,
        ),
      );
    },
    [],
  );

  useEffect(() => {
    setRuntimeLayoutByPaneId((current) =>
      pruneRouteKeyedRecords(current, currentRouteKeyByPaneId),
    );
    pruneSecondaryPublicationRecords(currentRouteKeyByPaneId);
    setTransientSecondaryActivationByPaneId((current) => {
      let next: Map<string, PaneTransientSecondaryActivationRecord> | null =
        null;
      for (const [paneId, activation] of current) {
        const routeKey = currentRouteKeyByPaneId.get(paneId);
        const publication = routeKey
          ? (routeKeyedRecord(secondaryPublicationByPaneId, paneId, routeKey)
              ?.publication ?? null)
          : null;
        if (
          routeKey === activation.routeKey &&
          secondaryPublicationIncludesTransientSurface(
            publication,
            activation.surfaceId,
          )
        ) {
          continue;
        }
        next ??= new Map(current);
        next.delete(paneId);
      }
      return next ?? current;
    });
    setFixedChromePublicationByPaneId((current) =>
      pruneRouteKeyedRecords(current, currentRouteKeyByPaneId),
    );
  }, [
    currentRouteKeyByPaneId,
    pruneSecondaryPublicationRecords,
    secondaryPublicationByPaneId,
  ]);

  const panes = useMemo(
    () =>
      paneDescriptors.map(({ pane, descriptor }) => {
        const runtimeLayoutRecord = routeKeyedRecord(
          runtimeLayoutByPaneId,
          pane.id,
          descriptor.routeKey,
        );
        return buildHostPane({
          pane,
          descriptor,
          isActive: pane.id === state.activePrimaryPaneId,
          runtimeLayout:
            runtimeLayoutRecord?.layout ?? DEFAULT_PANE_RUNTIME_LAYOUT,
          runtimeLayoutResolved: runtimeLayoutRecord !== null,
          secondaryPublication:
            routeKeyedRecord(
              secondaryPublicationByPaneId,
              pane.id,
              descriptor.routeKey,
            )?.publication ?? null,
          transientSecondaryActivation:
            transientSecondaryActivationByPaneId.get(pane.id) ?? null,
          fixedChromePublication:
            routeKeyedRecord(
              fixedChromePublicationByPaneId,
              pane.id,
              descriptor.routeKey,
            )?.publication ?? null,
          isMobile,
          columnWidthPx,
        });
      }),
    [
      paneDescriptors,
      state.activePrimaryPaneId,
      runtimeLayoutByPaneId,
      secondaryPublicationByPaneId,
      transientSecondaryActivationByPaneId,
      fixedChromePublicationByPaneId,
      isMobile,
      columnWidthPx,
    ],
  );
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const {
    canvasRef,
    onWheel,
    edges,
    inViewPaneIds,
    handleChromeMouseDown,
    scrollPaneIntoView,
  } = usePaneCanvas({
    mode: layoutMode === "desktop" ? "desktop" : "disabled",
    paneIds: panes.map((pane) => pane.paneId),
  });

  useEffect(() => {
    if (isMobile) {
      return;
    }
    for (const pane of panes) {
      const correctionPx = pane.sizing.storedWidthCorrectionPx;
      // A null width follows the column; only a user width is corrected.
      if (
        pane.visibility === "visible" &&
        pane.pane.primaryWidthPx !== null &&
        correctionPx !== null
      ) {
        resizePrimaryPane(pane.paneId, correctionPx);
      }
    }
  }, [isMobile, panes, resizePrimaryPane]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    for (const pane of panes) {
      const correctionPx =
        pane.secondarySizing?.storedWidthCorrectionPx ?? null;
      if (correctionPx !== null && pane.secondaryPane) {
        updateSecondaryPane(pane.secondaryPane.id, { widthPx: correctionPx });
      }
    }
  }, [isMobile, panes, updateSecondaryPane]);

  useEffect(() => {
    for (const primaryPane of primaryPanes) {
      const secondaryPane = primaryPane.secondary;
      if (!secondaryPane) {
        continue;
      }
      const routeKey = currentRouteKeyByPaneId.get(primaryPane.id);
      const publication = routeKey
        ? (routeKeyedRecord(
            secondaryPublicationByPaneId,
            primaryPane.id,
            routeKey,
          )?.publication ?? null)
        : null;
      if (!publication) {
        continue;
      }
      if (secondaryPane.groupId !== publication.groupId) {
        updateSecondaryPane(secondaryPane.id, null);
      }
    }
  }, [
    currentRouteKeyByPaneId,
    updateSecondaryPane,
    primaryPanes,
    secondaryPublicationByPaneId,
  ]);

  const canUsePublishedSecondarySurface = useCallback(
    (paneId: string, surfaceId: WorkspaceSecondarySurfaceId): boolean => {
      const routeKey = currentRouteKeyByPaneIdRef.current.get(paneId);
      if (!routeKey) {
        return false;
      }
      const publication = currentSecondaryPublication(paneId, routeKey);
      return secondaryPublicationIncludesSurface(publication, surfaceId);
    },
    [currentSecondaryPublication],
  );

  const canUsePublishedTransientSecondarySurface = useCallback(
    (
      paneId: string,
      routeKey: string,
      surfaceId: PaneTransientSecondarySurfaceId,
    ): boolean => {
      if (currentRouteKeyByPaneIdRef.current.get(paneId) !== routeKey) {
        return false;
      }
      return secondaryPublicationIncludesTransientSurface(
        currentSecondaryPublication(paneId, routeKey),
        surfaceId,
      );
    },
    [currentSecondaryPublication],
  );

  const handleRequestTransientSecondarySurface = useCallback(
    (
      paneId: string,
      routeKey: string,
      surfaceId: PaneTransientSecondarySurfaceId,
      returnFocusTo?: HTMLElement | null,
    ) => {
      if (
        !canUsePublishedTransientSecondarySurface(paneId, routeKey, surfaceId)
      ) {
        return;
      }
      if (returnFocusTo?.isConnected) {
        secondaryReturnFocusByPaneIdRef.current.set(paneId, returnFocusTo);
      } else if ("element" in (secondaryReturnFocusByPaneIdRef.current.get(paneId) ?? {})) {
        secondaryReturnFocusByPaneIdRef.current.delete(paneId);
      }
      const pane = panesRef.current.find(
        (candidate) => candidate.paneId === paneId,
      );
      const defaultWidthPx =
        getSecondaryWidthPolicy("resource-inspector").defaultWidthPx;
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(paneId);
        const next = new Map(current);
        next.set(paneId, {
          routeKey,
          surfaceId,
          expanded: true,
          widthPx:
            pane?.runtimeSecondaryPane?.widthPx ??
            existing?.widthPx ??
            defaultWidthPx,
        });
        return next;
      });
    },
    [canUsePublishedTransientSecondarySurface],
  );

  const handleCloseTransientSecondarySurface = useCallback(
    (paneId: string, routeKey: string) => {
      const stored = secondaryReturnFocusByPaneIdRef.current.get(paneId);
      const opener = stored && "element" in stored ? stored.element : stored ?? null;
      setTransientSecondaryActivationByPaneId((current) => {
        if (current.get(paneId)?.routeKey !== routeKey) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
      secondaryReturnFocusByPaneIdRef.current.delete(paneId);
      if (!isMobile && opener?.isConnected) {
        window.requestAnimationFrame(() => {
          opener.focus({ preventScroll: true });
        });
      }
    },
    [isMobile],
  );

  const handlePreviewTransientSecondaryResult = useCallback(
    (paneId: string, routeKey: string) => {
      if (!isMobile) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(paneId);
        if (!existing || existing.routeKey !== routeKey || !existing.expanded) {
          return current;
        }
        const next = new Map(current);
        next.set(paneId, { ...existing, expanded: false });
        return next;
      });
    },
    [isMobile],
  );

  const handleRequestSecondarySurface = useCallback(
    (
      paneId: string,
      surfaceId: WorkspaceSecondarySurfaceId,
      returnFocusTo?: HTMLElement | null,
    ) => {
      if (!canUsePublishedSecondarySurface(paneId, surfaceId)) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        if (!current.has(paneId)) return current;
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
      if (returnFocusTo?.isConnected) {
        secondaryReturnFocusByPaneIdRef.current.set(paneId, returnFocusTo);
      } else {
        secondaryReturnFocusByPaneIdRef.current.delete(paneId);
      }
      requestSecondarySurface(paneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, requestSecondarySurface],
  );

  const handleCloseSecondaryPane = useCallback(
    (secondaryPaneId: string, focusAfterClose?: HTMLElement | null) => {
      const pane = panesRef.current.find(
        (item) => item.secondaryPane?.id === secondaryPaneId,
      );
      // Desktop opener-refocus: capture the opener BEFORE clearing the
      // map, collapse, then refocus. A disconnected opener falls back to the
      // pane's chrome focus target (computed while the map entry still exists, so
      // the fallback is never starved). Mobile return-focus is owned by the
      // MobileSheet, so this only drives desktop.
      const stored = pane ? secondaryReturnFocusByPaneIdRef.current.get(pane.paneId) : null;
      const opener = stored && "element" in stored ? stored.element : stored ?? null;
      const destination = focusAfterClose?.isConnected ? focusAfterClose : null;
      const focusTarget =
        !isMobile && pane
          ? destination ?? (opener?.isConnected
            ? opener
            : findPaneChromeFocusTarget(pane.paneId))
          : null;
      if (isMobile && pane && destination) {
        // The sheet's existing return-focus owner restores this destination
        // after the modal layer releases the reader.
        secondaryReturnFocusByPaneIdRef.current.set(pane.paneId, { element: destination, preventScroll: true });
      }
      updateSecondaryPane(secondaryPaneId, { visibility: "collapsed" });
      if (pane && (!isMobile || !destination)) {
        secondaryReturnFocusByPaneIdRef.current.delete(pane.paneId);
      }
      if (focusTarget) {
        window.requestAnimationFrame(() => {
          focusTarget.focus({ preventScroll: true });
        });
      }
    },
    [updateSecondaryPane, isMobile],
  );

  const handleSetSecondarySurface = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      const pane = panesRef.current.find(
        (item) => item.runtimeSecondaryPane?.id === secondaryPaneId,
      );
      if (!pane || !canUsePublishedSecondarySurface(pane.paneId, surfaceId)) {
        return;
      }
      updateSecondaryPane(secondaryPaneId, { activeSurfaceId: surfaceId });
    },
    [canUsePublishedSecondarySurface, updateSecondaryPane],
  );

  const handleSelectDurableFromTransient = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) => {
      const pane = panesRef.current.find(
        (candidate) => candidate.transientSecondaryPaneId === secondaryPaneId,
      );
      if (
        !pane ||
        !canUsePublishedSecondarySurface(pane.paneId, surfaceId) ||
        transientSecondaryActivationByPaneIdRef.current.get(pane.paneId)
          ?.routeKey !== pane.routeKey
      ) {
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const next = new Map(current);
        next.delete(pane.paneId);
        return next;
      });
      requestSecondarySurface(pane.paneId, surfaceId);
    },
    [canUsePublishedSecondarySurface, requestSecondarySurface],
  );

  const resizeSecondaryPane = useCallback(
    (secondaryPaneId: string, widthPx: number) =>
      updateSecondaryPane(secondaryPaneId, { widthPx }),
    [updateSecondaryPane],
  );

  const handleResizeTransientSecondary = useCallback(
    (secondaryPaneId: string, widthPx: number) => {
      const pane = panesRef.current.find(
        (candidate) => candidate.transientSecondaryPaneId === secondaryPaneId,
      );
      if (!pane) return;
      if (pane.runtimeSecondaryPane) {
        updateSecondaryPane(pane.runtimeSecondaryPane.id, { widthPx });
        return;
      }
      setTransientSecondaryActivationByPaneId((current) => {
        const existing = current.get(pane.paneId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(pane.paneId, { ...existing, widthPx });
        return next;
      });
    },
    [updateSecondaryPane],
  );

  const visiblePaneCount = primaryPanes.filter(
    (pane) => pane.visibility === "visible",
  ).length;
  const stripItems = useMemo(
    () =>
      panes.map((pane) => ({
        paneId: pane.paneId,
        href: pane.href,
        label: pane.label,
        labelState: pane.labelState,
        isActive: pane.isActive,
        visibility: pane.visibility,
        canMinimize: pane.visibility === "visible" && visiblePaneCount > 1,
        isInView: inViewPaneIds.has(pane.paneId),
      })),
    [panes, visiblePaneCount, inViewPaneIds],
  );

  const activePane =
    panes.find(
      (pane) =>
        pane.paneId === state.activePrimaryPaneId &&
        pane.visibility === "visible",
    ) ??
    panes.find((pane) => pane.visibility === "visible") ??
    null;
  // The host is the workspace's only writer of the browser title, so an
  // inactive pane can never race the active pane's identity into the tab. The
  // title is rendered, not assigned: the authenticated tree emits no metadata
  // title (see its layout), so React owns this element and re-asserts it on
  // every commit instead of losing it to a late streamed metadata write.
  const documentTitle = activePane ? `${activePane.label} · Nexus` : "Nexus";
  const renderedPanes = isMobile ? (activePane ? [activePane] : []) : panes;

  // --- Pane focus management ---
  const focusPane = useCallback(
    (targetPaneId: string) => {
      if (!paneWrapRefById.current.has(targetPaneId)) {
        return false;
      }
      const target = isMobile
        ? findPaneLandmarkFocusTarget(targetPaneId)
        : findPaneChromeFocusTarget(targetPaneId);
      if (!target) {
        return false;
      }
      target.focus({ preventScroll: true });
      pendingPaneFocusPaneIdRef.current = null;
      return true;
    },
    [isMobile],
  );

  useLayoutEffect(() => {
    const previousIsMobile = previousIsMobileRef.current;
    previousIsMobileRef.current = isMobile;
    const targetPaneId =
      pendingPaneFocusPaneIdRef.current ??
      (isMobile || previousIsMobile ? state.activePrimaryPaneId : null);
    if (!targetPaneId) {
      return;
    }
    const focusedElement = document.activeElement;
    if (
      previousIsMobile !== isMobile &&
      pendingPaneFocusPaneIdRef.current === null &&
      focusedElement instanceof HTMLElement &&
      focusedElement.closest('[data-pane-collection-controls="true"]') &&
      paneWrapRefById.current.get(targetPaneId)?.contains(focusedElement)
    ) {
      return;
    }
    const entryDelivery =
      pendingPaneEntryDeliveryByPaneIdRef.current.get(targetPaneId);
    if (
      isMobile &&
      entryDelivery?.visitId === activePaneVisitIdRef.current &&
      entryDelivery.entry.kind === "AppendNote"
    ) {
      pendingPaneFocusPaneIdRef.current = null;
      return;
    }
    focusPane(targetPaneId);
  }, [state.activePrimaryPaneId, isMobile, focusPane]);

  useEffect(() => {
    scrollPaneIntoView(state.activePrimaryPaneId);
  }, [state.activePrimaryPaneId, scrollPaneIntoView]);

  const acknowledgeResponsivePaneSearchDelivery = useCallback((id: number) => {
    setPendingResponsivePaneSearchDelivery((current) =>
      current?.id === id ? null : current,
    );
  }, []);

  const requestPaneFocus = useCallback(
    (paneId: string) => {
      pendingPaneFocusPaneIdRef.current = paneId;
      window.requestAnimationFrame(() => {
        if (pendingPaneFocusPaneIdRef.current === paneId) {
          focusPane(paneId);
        }
      });
    },
    [focusPane],
  );

  const handleActivatePane = useCallback(
    (paneId: string, options?: { focusPane?: boolean }) => {
      const shouldFocusPane = options?.focusPane !== false;
      activatePane(paneId);
      if (!shouldFocusPane) {
        return;
      }
      requestPaneFocus(paneId);
    },
    [activatePane, requestPaneFocus],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const searchCombo = keybindings["Pane.Search"];
      if (searchCombo && matchesKeyEvent(searchCombo, event)) {
        const consumed = dispatchPaneSearchRequest();
        if (consumed) {
          const targetIsMobile = getBrowserViewportKind() === "mobile";
          const routeKey = currentRouteKeyByPaneIdRef.current.get(
            state.activePrimaryPaneId,
          );
          // The outgoing projection established capability synchronously, but a
          // live responsive transition will replace its shell. Carry one exact
          // delivery to the incoming route instead of losing the command.
          setPendingResponsivePaneSearchDelivery(
            targetIsMobile === isMobile || !routeKey
              ? null
              : {
                  id: ++nextResponsivePaneSearchDeliveryIdRef.current,
                  paneId: state.activePrimaryPaneId,
                  routeKey,
                  targetIsMobile,
                },
          );
          event.preventDefault();
        }
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [state.activePrimaryPaneId, keybindings, isMobile]);

  useAdjacentPaneKeybindings({ onActivated: requestPaneFocus });

  return (
    <section className={styles.host} aria-label="Workspace host">
      <title>{documentTitle}</title>
      {!isMobile && (
        <WorkspacePaneStrip
          items={stripItems}
          onActivatePane={handleActivatePane}
          onMinimizePane={minimizePane}
          onRestorePane={restorePane}
          onClosePane={closePane}
        />
      )}
      <div className={styles.canvasViewport}>
        <div ref={canvasRef} className={styles.paneCanvas} onWheel={onWheel}>
          {renderedPanes.map((pane) => (
            <div
              key={pane.paneId}
              className={styles.paneWrap}
              data-pane-id={pane.paneId}
              data-active={pane.isActive ? "true" : "false"}
              data-mobile={isMobile ? "true" : "false"}
              data-minimized={
                pane.visibility === "minimized" ? "true" : "false"
              }
              hidden={pane.visibility === "minimized"}
              inert={pane.visibility === "minimized" ? true : undefined}
              ref={(element) => {
                if (element) {
                  paneWrapRefById.current.set(pane.paneId, element);
                } else {
                  paneWrapRefById.current.delete(pane.paneId);
                }
              }}
              onMouseDown={() =>
                handleActivatePane(pane.paneId, { focusPane: false })
              }
            >
              <PaneRouteErrorBoundary
                paneId={pane.paneId}
                visitId={pane.visitId}
                isActive={pane.isActive}
                resetKey={`${pane.paneId}:${pane.routeKey}`}
                slotMinWidth={
                  isMobile
                    ? "100%"
                    : `${
                        pane.sizing.renderedPrimarySlotWidthPx +
                        (pane.transientSecondaryExpanded
                          ? (pane.transientSecondarySizing?.widthPx ?? 0)
                          : pane.secondaryPane?.visibility === "visible"
                            ? (pane.secondarySizing?.widthPx ?? 0)
                            : 0)
                      }px`
                }
              >
                <PaneRuntimeFrame
                  pane={pane.pane}
                  isActive={pane.isActive}
                  routeKey={pane.routeKey}
                  secondaryPane={pane.runtimeSecondaryPane}
                  transientSecondarySurface={
                    pane.transientSecondarySurface
                      ? {
                          id: pane.transientSecondarySurface.id,
                          expanded: pane.transientSecondaryExpanded,
                        }
                      : null
                  }
                  publishPaneLayout={publishPaneLayout}
                  publishPaneSecondary={publishPaneSecondary}
                  publishPaneFixedChrome={publishPaneFixedChrome}
                  requestSecondarySurface={handleRequestSecondarySurface}
                  closeSecondaryPane={handleCloseSecondaryPane}
                  requestTransientSecondarySurface={
                    handleRequestTransientSecondarySurface
                  }
                  closeTransientSecondarySurface={
                    handleCloseTransientSecondarySurface
                  }
                  previewTransientSecondaryResult={
                    handlePreviewTransientSecondaryResult
                  }
                >
                  <PaneShell
                    paneId={pane.paneId}
                    routeKey={pane.routeKey}
                    routeHeader={pane.route.header}
                    routeShareIdentity={pane.routeShareIdentity}
                    label={pane.label}
                    labelPending={pane.labelState === "pending"}
                    queryNavigation={pane.route.queryNavigation}
                    returnMementoEnabled={
                      pane.route.returnKind === "ShellScroll"
                    }
                    sizing={pane.sizing}
                    secondaryPane={pane.secondaryPane}
                    secondarySizing={pane.secondarySizing}
                    secondaryPublication={pane.secondaryPublication}
                    fixedChromePublication={pane.fixedChromePublication}
                    bodyMode={pane.bodyMode}
                    onResizePrimaryPane={resizePrimaryPane}
                    onResizeSecondaryPane={resizeSecondaryPane}
                    onCloseSecondaryPane={handleCloseSecondaryPane}
                    onSetSecondarySurface={handleSetSecondarySurface}
                    onChromeMouseDown={handleChromeMouseDown}
                    isActive={pane.isActive}
                    isMobile={isMobile}
                    responsiveSearchHandoff={
                      pendingResponsivePaneSearchDelivery?.paneId ===
                        pane.paneId &&
                      pendingResponsivePaneSearchDelivery.routeKey ===
                        pane.routeKey &&
                      pendingResponsivePaneSearchDelivery.targetIsMobile ===
                        isMobile
                        ? {
                            id: pendingResponsivePaneSearchDelivery.id,
                            onConsumed:
                              acknowledgeResponsivePaneSearchDelivery,
                          }
                        : null
                    }
                  >
                    {pane.content}
                  </PaneShell>
                  {!isMobile &&
                  pane.transientSecondarySurface &&
                  pane.transientSecondaryExpanded &&
                  pane.transientSecondarySizing &&
                  pane.secondaryPublication ? (
                    <SecondaryPaneShell
                      primaryPaneId={pane.paneId}
                      secondaryPaneId={pane.transientSecondaryPaneId}
                      publication={pane.secondaryPublication}
                      state={pane.runtimeSecondaryPane}
                      transientSurface={pane.transientSecondarySurface}
                      sizing={pane.transientSecondarySizing}
                      onActiveSurfaceChange={handleSetSecondarySurface}
                      onSelectDurableFromTransient={
                        handleSelectDurableFromTransient
                      }
                      onClose={handleCloseSecondaryPane}
                      onCloseTransient={() =>
                        handleCloseTransientSecondarySurface(
                          pane.paneId,
                          pane.routeKey,
                        )
                      }
                      onResize={handleResizeTransientSecondary}
                    />
                  ) : null}
                  {isMobile &&
                  (pane.runtimeSecondaryPane ||
                    pane.transientSecondarySurface) ? (
                    <MobileSecondaryPaneHost
                      primaryPaneId={pane.paneId}
                      secondaryPaneId={pane.transientSecondaryPaneId}
                      secondary={pane.runtimeSecondaryPane}
                      publication={pane.secondaryPublication}
                      transientSurface={pane.transientSecondarySurface}
                      transientExpanded={pane.transientSecondaryExpanded}
                      returnFocusTo={() =>
                        secondaryReturnFocusByPaneIdRef.current.get(
                          pane.paneId,
                        ) ?? null
                      }
                      onClose={handleCloseSecondaryPane}
                      onCloseTransient={() =>
                        handleCloseTransientSecondarySurface(
                          pane.paneId,
                          pane.routeKey,
                        )
                      }
                      onActiveSurfaceChange={handleSetSecondarySurface}
                      onSelectDurableFromTransient={
                        handleSelectDurableFromTransient
                      }
                    />
                  ) : null}
                </PaneRuntimeFrame>
              </PaneRouteErrorBoundary>
            </div>
          ))}
        </div>
        {layoutMode === "desktop" && edges.atStart ? (
          <div
            className={styles.edgeFade}
            data-side="start"
          />
        ) : null}
        {layoutMode === "desktop" && edges.atEnd ? (
          <div
            className={styles.edgeFade}
            data-side="end"
          />
        ) : null}
      </div>
    </section>
  );
}

// Not memo()'d: MobileChromeProvider owns the volatile chrome state and receives
// this whole subtree as stable `children`, so its scroll/publish re-renders never
// reconcile through here — only its context consumers (AppNav, PaneShell) re-render.
// Wrapping a zero-prop component in memo() would also turn rerender() into a no-op.
export default WorkspaceHost;
