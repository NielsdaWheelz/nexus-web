"use client";

import { useMemo, useRef } from "react";
import DossierSurface from "@/components/dossier/DossierSurface";
import { FindResults } from "@/components/find/FindBar";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import { useDossier } from "@/lib/dossiers/useDossier";
import {
  findInUnits,
  highlightPainter,
  type FindSource,
} from "@/lib/find/find";
import { useFind } from "@/lib/find/useFind";
import { buildDomTextCursor } from "@/lib/highlights/domTextCursor";
import { resolveDomTextRanges } from "@/lib/highlights/domTextRanges";
import {
  requirePaneRuntime,
  usePaneParam,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateResource } from "@/lib/resources/activation";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./ArtifactPaneBody.module.css";

/**
 * The dossier pane. Its find is the plain dom case: the article in the shadow
 * root, citation buttons excluded, keyed on the revision whose text it holds.
 */
export default function ArtifactPaneBody() {
  const artifactRef = usePaneParam("artifactRef") ?? "";
  const ref = parseResourceRef(artifactRef);
  if (ref?.scheme !== "artifact") {
    throw new Error("ArtifactPaneBody requires a canonical Artifact ref");
  }
  const { activateTarget } = requirePaneRuntime(
    usePaneRuntime(),
    "ArtifactPaneBody",
  );
  const dossier = useDossier({ kind: "Artifact", artifactRef });
  const head = dossier.head.kind === "Ready" ? dossier.head.value : null;
  useSetPaneLabel(head?.title ?? null);
  usePaneReturnReady(dossier.head.kind !== "Loading");

  const articleRef = useRef<HTMLElement | null>(null);
  const revisionRef =
    head?.revision.kind === "Present" ? head.revision.value.revision_ref : null;
  const source = useMemo<FindSource<readonly Range[]> | null>(
    () =>
      revisionRef === null
        ? null
        : {
            key: revisionRef,
            label: "Find in dossier",
            prepare: () => null,
            search(options) {
              const article = articleRef.current;
              if (!article)
                return { kind: "Failed", message: "The dossier is not shown." };
              const cursor = buildDomTextCursor(article, (element) =>
                element.matches("button.dossier-citation"),
              );
              return findInUnits(
                [{ id: "article", text: cursor.emitted }],
                options,
                (hit) => ({
                  at: resolveDomTextRanges(cursor, hit.start, hit.end) ?? [],
                  context: [],
                }),
              );
            },
            async reveal(ranges) {
              ranges[0]?.startContainer.parentElement?.scrollIntoView({
                block: "center",
              });
              return null;
            },
            paint: highlightPainter((ranges) => ranges),
          },
    [revisionRef],
  );
  const find = useFind(source);
  usePaneSecondary(
    useMemo<PaneSecondaryPublication | null>(
      () =>
        find && {
          groupId: "resource-inspector",
          surfaces: [],
          defaultSurfaceId: null,
          transientSurfaces: [
            { id: "resource-search", body: <FindResults find={find} /> },
          ],
        },
      [find],
    ),
  );
  usePanePrimaryChrome({
    header: head
      ? { kind: "Resource", resource: { status: "Ready", creditGroups: [] } }
      : dossier.head.kind === "Failed"
        ? { kind: "Resource", resource: { status: "Failed" } }
        : undefined,
    search: find
      ? { kind: "Find", find }
      : dossier.head.kind === "Loading"
        ? { kind: "Resolving", control: "Find" }
        : undefined,
    actionSubject: { ref: canonicalResourceRef(ref) },
  });

  return (
    <div className={styles.pane}>
      <DossierSurface
        dossier={dossier}
        articleRef={articleRef}
        onCitationActivate={(activation, target, disposition) => {
          if (target) dispatchReaderSourceActivation(target);
          activateResource(activation, {
            labelHint: target?.label,
            activateTarget,
            disposition,
          });
        }}
        onViewMediaEvidence={() => {
          if (head?.subject_activation.kind === "Present")
            activateResource(head.subject_activation.value, {
              labelHint: head.title,
              activateTarget,
              disposition: { kind: "Follow" },
            });
        }}
      />
    </div>
  );
}
