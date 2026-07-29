"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DossierSurface, {
  type DossierCitationActivate,
} from "@/components/dossier/DossierSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
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
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateResource } from "@/lib/resources/activation";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
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
  usePanePrimaryChrome({
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
  });

  const activateCitation = useCallback<DossierCitationActivate>(
    (activation, target) => {
      if (target) dispatchReaderSourceActivation(target);
      activateResource(activation, {
        labelHint: target?.label,
        activateTarget: paneRuntime.activateTarget,
        disposition: { kind: "Follow" },
      });
    },
    [paneRuntime],
  );
  const viewMediaEvidence = useCallback(() => {
    if (identity?.kind !== "Resource") return;
    activateResource(identity.activation, {
      labelHint: identity.title,
      activateTarget: paneRuntime.activateTarget,
      disposition: { kind: "Follow" },
    });
  }, [identity, paneRuntime]);

  return (
    <div className={styles.pane}>
      <DossierSurface
        store={store}
        onViewMediaEvidence={viewMediaEvidence}
        onCitationActivate={activateCitation}
        onRevisionSelect={selectRevision}
      />
    </div>
  );
}
