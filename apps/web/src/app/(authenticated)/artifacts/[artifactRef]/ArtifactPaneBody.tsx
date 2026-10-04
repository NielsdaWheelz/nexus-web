"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DossierSurface, {
  type DossierCitationActivate,
} from "@/components/dossier/DossierSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  createDossierControllerStore,
  useDossierSelector,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateResource } from "@/lib/resources/activation";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./ArtifactPaneBody.module.css";

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
  const actionSubject = useMemo(
    () => ({
      ref: canonicalResourceRef({
        scheme: "artifact",
        id: parsedArtifactRef.id,
      }),
    }),
    [parsedArtifactRef.id],
  );
  const primaryChrome = useMemo<PanePrimaryChromePublication>(
    () => ({
      ...(identity
        ? {
            header: {
              kind: "Resource" as const,
              resource: { status: "Ready" as const, creditGroups: [] },
            },
          }
        : state.head.kind === "Failed"
          ? {
              header: {
                kind: "Resource" as const,
                resource: { status: "Failed" as const },
              },
            }
          : {}),
      // The dossier's canonical identity is its route ref, not a fact of the
      // head read. The snapshot owns missing state.
      actionSubject,
    }),
    [actionSubject, identity, state.head.kind],
  );

  const activateCitation = useCallback<DossierCitationActivate>(
    (activation, target, disposition) => {
      if (target) dispatchReaderSourceActivation(target);
      activateResource(activation, {
        labelHint: target?.label,
        activateTarget: activatePaneTarget,
        disposition,
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
  // The dossier publishes no find: the document is a sandboxed frame, so
  // Cmd/Ctrl+F falls through to the browser's own find, which searches it.
  usePanePrimaryChrome(primaryChrome);
  usePaneSecondary(null);

  return (
    <div className={styles.pane}>
      <DossierSurface
        store={store}
        onViewMediaEvidence={viewMediaEvidence}
        onCitationActivate={activateCitation}
      />
    </div>
  );
}
