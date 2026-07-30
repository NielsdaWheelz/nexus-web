"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import PaneSearchResults from "@/components/resource-inspector/PaneSearchResults";
import DossierSurface, {
  type DossierCitationActivate,
} from "@/components/dossier/DossierSurface";
import type { DossierDocumentFindCapability } from "@/components/dossier/DossierDocumentFrame";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { emptyResourceMenuGroups } from "@/lib/actions/resourceActions";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  createDossierControllerStore,
  useDossierSelector,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";
import { artifactPaneHref } from "@/lib/dossiers/generationAdapter";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneReturnReady,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { PaneRuntimeContextValue } from "@/lib/panes/paneRuntime";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import type { PaneFindOccurrencesPublication } from "@/lib/panes/paneSearch";
import {
  usePaneFind,
  type PaneFindController,
  type PaneFindUseResult,
} from "@/lib/panes/usePaneFind";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateResource } from "@/lib/resources/activation";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { createArtifactPaneFindAdapter } from "./artifactPaneFind";
import styles from "./ArtifactPaneBody.module.css";

function requireArtifactPaneFindController(
  result: PaneFindUseResult,
): PaneFindController {
  if (result.kind !== "Available") {
    throw new Error("Artifact Pane Find capability must be available.");
  }
  return result.controller;
}

function useArtifactDossierStore(artifactRef: string): DossierControllerStore {
  const [store] = useState(() =>
    createDossierControllerStore({ kind: "Artifact", artifactRef }),
  );
  const currentStoreRef = useRef(store);
  currentStoreRef.current = store;
  const lifecycleEpochRef = useRef(0);
  useEffect(() => {
    const epoch = lifecycleEpochRef.current + 1;
    lifecycleEpochRef.current = epoch;
    return () => {
      queueMicrotask(() => {
        if (
          currentStoreRef.current !== store ||
          lifecycleEpochRef.current === epoch
        ) {
          store.dispose();
        }
      });
    };
  }, [store]);
  return store;
}

function ArtifactBasePublications({
  chrome,
}: {
  readonly chrome: PanePrimaryChromePublication;
}) {
  usePanePrimaryChrome(chrome);
  usePaneSecondary(null);
  return null;
}

function ArtifactFindPublications({
  chrome,
  search,
  resultsBody,
}: {
  readonly chrome: PanePrimaryChromePublication;
  readonly search: PaneFindOccurrencesPublication;
  readonly resultsBody: ReactNode;
}) {
  usePanePrimaryChrome({ ...chrome, search });
  usePaneSecondary({
    groupId: "resource-inspector",
    surfaces: [],
    defaultSurfaceId: null,
    transientSurfaces: [{ id: "resource-search", body: resultsBody }],
  });
  return null;
}

function ArtifactFindComposition({
  artifactRef,
  capability,
  chrome,
  paneRuntime,
}: {
  readonly artifactRef: string;
  readonly capability: DossierDocumentFindCapability;
  readonly chrome: PanePrimaryChromePublication;
  readonly paneRuntime: PaneRuntimeContextValue;
}) {
  const adapter = useMemo(
    () => createArtifactPaneFindAdapter(artifactRef, capability),
    [artifactRef, capability],
  );
  const paneFindCapability = useMemo(
    () => ({ kind: "Available" as const, adapter }),
    [adapter],
  );
  const paneFindResult = usePaneFind({ capability: paneFindCapability });
  const paneFind = requireArtifactPaneFindController(paneFindResult);
  const {
    closeTransientSecondarySurface,
    isActive,
    previewTransientSecondaryResult,
    requestTransientSecondarySurface,
    transientSecondarySurface,
  } = paneRuntime;
  const dismissPaneFind = paneFind.onDismiss;
  const activatePaneFind = paneFind.onActivate;
  const dismissFind = useCallback(() => {
    dismissPaneFind();
    closeTransientSecondarySurface();
  }, [closeTransientSecondarySurface, dismissPaneFind]);
  const showFindResults = useCallback(
    (trigger: HTMLButtonElement | null) => {
      requestTransientSecondarySurface("resource-search", {
        returnFocusTo: trigger,
      });
    },
    [requestTransientSecondarySurface],
  );
  const activateFindResult = useCallback(
    (key: Parameters<PaneFindOccurrencesPublication["onActivate"]>[0]) => {
      void activatePaneFind(key).then((previewed) => {
        if (previewed) previewTransientSecondaryResult();
      });
    },
    [activatePaneFind, previewTransientSecondaryResult],
  );
  const resultsExpanded =
    transientSecondarySurface?.id === "resource-search" &&
    transientSecondarySurface.expanded;
  const search = useMemo<PaneFindOccurrencesPublication>(
    () => ({
      kind: "FindOccurrences",
      query: paneFind.query,
      inputLabel: "Find in dossier",
      placeholder: "Find in dossier",
      onOpen: paneFind.onOpen,
      onQueryChange: paneFind.onQueryChange,
      onDismiss: dismissFind,
      result: paneFind.result,
      scope: paneFind.scope,
      matchCase: paneFind.matchCase,
      wholeWord: paneFind.wholeWord,
      onMatchCaseChange: paneFind.onMatchCaseChange,
      onWholeWordChange: paneFind.onWholeWordChange,
      onStep: paneFind.onStep,
      onActivate: activateFindResult,
      onShowResults: showFindResults,
      resultsExpanded,
      returnToReadingPosition: paneFind.returnToReadingPosition,
    }),
    [
      activateFindResult,
      dismissFind,
      paneFind.matchCase,
      paneFind.onMatchCaseChange,
      paneFind.onOpen,
      paneFind.onQueryChange,
      paneFind.onStep,
      paneFind.onWholeWordChange,
      paneFind.query,
      paneFind.result,
      paneFind.returnToReadingPosition,
      paneFind.scope,
      paneFind.wholeWord,
      resultsExpanded,
      showFindResults,
    ],
  );
  const resultsBody = useMemo(
    () => (
      <PaneSearchResults publication={{ ...search, resultsExpanded: true }} />
    ),
    [search],
  );

  // The publication component is a child deliberately: its layout effect
  // commits before this Enable, while this parent disables before the child
  // unpublishes during teardown.
  useLayoutEffect(() => {
    if (!isActive) return;
    capability.setFindEnabled(true);
    return () => capability.setFindEnabled(false);
  }, [capability, isActive]);
  useLayoutEffect(
    () => () => closeTransientSecondarySurface(),
    [capability, closeTransientSecondarySurface],
  );

  return (
    <ArtifactFindPublications
      chrome={chrome}
      search={search}
      resultsBody={resultsBody}
    />
  );
}

export default function ArtifactPaneBody() {
  const artifactRef = usePaneParam("artifactRef");
  if (!artifactRef) {
    throw new Error("ArtifactPaneBody requires an artifact ref");
  }
  const parsedArtifactRef = parseResourceRef(artifactRef);
  if (parsedArtifactRef?.scheme !== "artifact") {
    throw new Error("ArtifactPaneBody requires a canonical Artifact ref");
  }
  const paneRuntime = requirePaneRuntime(
    usePaneRuntime(),
    "ArtifactPaneBody",
  );
  const activatePaneTarget = paneRuntime.activateTarget;
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const store = useArtifactDossierStore(artifactRef);
  const state = useDossierSelector(store, (snapshot) => snapshot);
  const identity =
    state.head.kind === "Ready" &&
    state.head.ready.identity.kind === "Present"
      ? state.head.ready.identity.value
      : null;
  const title = identity?.title ?? null;
  useSetPaneLabel(title);
  usePaneReturnReady(state.head.kind === "Ready" || state.head.kind === "Failed");
  const [findCapability, setFindCapability] =
    useState<DossierDocumentFindCapability | null>(null);
  const displayedRevisionRef =
    state.head.kind !== "Ready"
      ? null
      : state.revisionSelection.kind === "Historical"
        ? state.historicalRevision.kind === "Ready"
          ? state.historicalRevision.revision.revisionRef
          : null
        : state.head.ready.currentRevision.kind === "Present"
          ? state.head.ready.currentRevision.value.revisionRef
          : null;
  const exactFindCapability =
    findCapability?.revisionRef === displayedRevisionRef
      ? findCapability
      : null;
  const findCapabilityRef = useRef(exactFindCapability);
  const paneActiveRef = useRef(paneRuntime.isActive);
  findCapabilityRef.current = exactFindCapability;
  paneActiveRef.current = paneRuntime.isActive;

  const revisionRef = searchParams.get("revision");
  useEffect(() => {
    if (revisionRef) store.selectHistorical(revisionRef);
    else store.selectCurrent();
  }, [revisionRef, store]);

  const canonicalHref = artifactPaneHref(artifactRef);
  const selectRevision = useCallback(
    (nextRevisionRef: string | null) => {
      const href =
        nextRevisionRef === null
          ? canonicalHref
          : `${canonicalHref}?revision=${encodeURIComponent(nextRevisionRef)}`;
      router.replace(href, { labelHint: title ?? "Dossier" });
    },
    [canonicalHref, router, title],
  );

  const actionTarget = useMemo(
    () =>
      routeResourceActionSubject({
        scheme: "artifact",
        id: parsedArtifactRef.id,
        href: canonicalHref,
      }),
    [canonicalHref, parsedArtifactRef.id],
  );
  const primaryChrome = useMemo<PanePrimaryChromePublication>(
    () => ({
      ...(identity
        ? {
            header: {
              kind: "resource" as const,
              resource: {
                status: "ready" as const,
                title: identity.title,
                creditGroups: [],
              },
            },
          }
        : state.head.kind === "Failed"
          ? {
              header: {
                kind: "resource" as const,
                resource: {
                  status: "failed" as const,
                  title: "Dossier failed to load",
                },
              },
            }
          : {}),
      menu:
        state.head.kind === "Ready"
          ? {
              kind: "ResourceMenu" as const,
              target: actionTarget,
              groups: emptyResourceMenuGroups(),
            }
          : undefined,
    }),
    [actionTarget, identity, state.head.kind],
  );

  const activateCitation = useCallback<DossierCitationActivate>(
    (activation, target) => {
      if (target) dispatchReaderSourceActivation(target);
      activateResource(activation, {
        labelHint: target?.label,
        activateTarget: activatePaneTarget,
        disposition: { kind: "Follow" },
      });
    },
    [activatePaneTarget],
  );
  const viewMediaEvidence = useCallback(() => {
    if (identity?.kind !== "Resource") return;
    activateResource(identity.activation, {
      labelHint: identity.title,
      activateTarget: activatePaneTarget,
      disposition: { kind: "Follow" },
    });
  }, [activatePaneTarget, identity]);
  const handleFindCapabilityChange = useCallback(
    (nextCapability: DossierDocumentFindCapability | null) => {
      if (nextCapability === null) findCapabilityRef.current = null;
      setFindCapability(nextCapability);
    },
    [],
  );
  const handleFindRequested = useCallback(() => {
    if (!paneActiveRef.current || findCapabilityRef.current === null) return;
    dispatchPaneSearchRequest();
  }, []);

  return (
    <div className={styles.pane}>
      {exactFindCapability ? (
        <ArtifactFindComposition
          artifactRef={artifactRef}
          capability={exactFindCapability}
          chrome={primaryChrome}
          paneRuntime={paneRuntime}
        />
      ) : (
        <ArtifactBasePublications chrome={primaryChrome} />
      )}
      <DossierSurface
        store={store}
        onViewMediaEvidence={viewMediaEvidence}
        onCitationActivate={activateCitation}
        onRevisionSelect={selectRevision}
        onFindCapabilityChange={handleFindCapabilityChange}
        onFindRequested={handleFindRequested}
      />
    </div>
  );
}
