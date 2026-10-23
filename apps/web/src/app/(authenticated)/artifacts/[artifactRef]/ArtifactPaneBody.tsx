"use client";

import { useMemo, useRef } from "react";
import DossierSurface from "@/components/dossier/DossierSurface";
import { useDossier } from "@/lib/dossiers/useDossier";
import {
  findInUnits,
  highlightPainter,
  type FindSource,
} from "@/lib/find/find";
import { useFind } from "@/lib/find/useFind";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { buildDomTextCursor } from "@/lib/canonicalText/domTextCursor";
import { resolveDomTextRanges } from "@/lib/canonicalText/domTextRanges";
import {
  paneSourceKey,
  requirePaneRuntime,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
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
  const runtime = requirePaneRuntime(
    usePaneRuntime(),
    "ArtifactPaneBody",
  );
  const dossier = useDossier({ kind: "Artifact", artifactRef });
  const head = dossier.head.kind === "Ready" ? dossier.head.value : null;
  usePaneReturnReady(dossier.head.kind !== "Loading");

  const articleRef = useRef<HTMLElement | null>(null);
  const revisionRef =
    head?.revision != null ? head.revision.revision_ref : null;
  const source = useMemo<FindSource<readonly StaticRange[]> | null>(
    () =>
      revisionRef === null
        ? null
        : {
            key: revisionRef,
            label: "Find in dossier",
            narrowLabel: null,
            prepare: () => null,
            search(options) {
              const article = articleRef.current;
              if (!article)
                return { kind: "Failed", message: "The dossier is not shown." };
              const cursor = buildDomTextCursor(article, (element) =>
                element.matches(".dossier-citation"),
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
            async reveal(ranges, signal) {
              if (signal.aborted) return { kind: "Cancelled" };
              const target = ranges[0]?.startContainer.parentElement;
              if (!target?.isConnected)
                return { kind: "Failed", message: "This match is no longer shown. Retry the search." };
              target.scrollIntoView({ block: "center" });
              return { kind: "Shown" };
            },
            paint: highlightPainter((ranges) => ranges),
          },
    [revisionRef],
  );
  const find = useFind({ ownerKey: paneSourceKey(runtime), source });
  usePaneChrome({
    header: head
      ? { kind: "Resource", resource: { status: "Ready", creditGroups: [] } }
      : dossier.head.kind === "Failed"
        ? { kind: "Resource", resource: { status: "Failed" } }
        : undefined,
    query: find
      ? { kind: "Find", find }
      : dossier.head.kind === "Loading"
        ? { kind: "Find", find: null }
        : undefined,
    resourceRef: canonicalResourceRef(ref),
  });

  return (
    <div className={styles.pane}>
      <DossierSurface
        draftKey={artifactRef}
        dossier={dossier}
        articleRef={articleRef}
        mediaEvidence={head?.subject_activation?.href ? {
          href: head.subject_activation.href,
          activate: event => activateTargetLink({ event, runtime, target: head.subject_activation?.href ? { href: head.subject_activation.href, labelHint: head.title } : null }),
        } : null}
      />
    </div>
  );
}
