"use client";

// One reader evidence row. Local highlights and whole-document links render from the
// account database by ref; remote roots keep their server presentation. Membership
// only selects facets and reveal targets; the shared row owns resource commands.
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { PLACEMENT_COPY } from "@/lib/documentReader/chrome/ReaderAnnotation";
import type { ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { Reader } from "@/lib/documentReader/runtime";
import { useInteractionOwner } from "@/lib/ui/overlay";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import type { LocalLink } from "../annotations";
import SourceNote from "./SourceNote";
import styles from "./EvidencePane.module.css";
import { rootItem, type EvidenceRoot } from "./model";

export interface EvidenceOpenRequest {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly onResolved: (element: HTMLElement | null) => void;
}

export interface EvidenceActions {
  readonly sourceContext: boolean;
  /** The media every whole-document link attaches to. */
  readonly mediaLabel: string;
  readonly verbs: Pick<AnnotationVerbs, "noteEdit" | "hovered" | "hover" | "closeNoteEdit" | "relocate">;
  readonly refresh: () => void;
}

export type EvidenceEntry =
  | { readonly kind: "highlight"; readonly key: string; readonly annotation: ReaderAnnotation }
  | { readonly kind: "link"; readonly key: string; readonly link: LocalLink }
  | { readonly kind: "remote"; readonly key: string; readonly root: EvidenceRoot };

export default function EvidenceRow({ entry, actions, active, visible, unresolvedText, openRequest, reader, revealInSidebar, onUnlink, style, className, displaced }: {
  readonly entry: EvidenceEntry;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly visible: boolean;
  readonly unresolvedText: boolean;
  readonly openRequest: EvidenceOpenRequest | null;
  readonly reader: Reader;
  readonly revealInSidebar: (element: HTMLElement) => void;
  /** The pane owns an unlink's commit, failure, retry and focus; the row only asks. */
  readonly onUnlink: (linkId: string, row: HTMLElement | null) => void;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly displaced: boolean;
}) {
  const row = useRef<HTMLLIElement>(null);
  const interactionOwner = useInteractionOwner();
  const occurrenceKey = `evidence/${entry.key}`;
  useLayoutEffect(() => {
    if (!visible || !openRequest?.isCurrent()) return;
    const element = row.current;
    if (!element?.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) return;
    revealInSidebar(element);
    if (openRequest.isCurrent()) openRequest.onResolved(element);
  }, [openRequest, interactionOwner, visible, occurrenceKey, revealInSidebar]);
  const { verbs } = actions;
  const highlightId = entry.kind === "highlight" ? entry.annotation.id
    : entry.kind === "remote" && entry.root.content.kind === "Highlight" ? entry.root.content.highlight_id : null;
  const rootProps = { hidden: !visible, style, className, "data-active": active || openRequest !== null, "data-group": entry.key,
    onMouseEnter: () => { if (highlightId) verbs.hover(highlightId); },
    onMouseLeave: () => { if (highlightId) verbs.hover(null); },
  };
  const placementDetails = <>
    {displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
  </>;
  if (entry.kind === "highlight") {
    const { annotation } = entry;
    const placement = annotation.placement.kind;
    return <ResourceOutlineRow resourceRef={annotation.ref} incoming={null} occurrenceKey={occurrenceKey} rowRef={row} rootProps={rootProps}
      omitResourceActions={!actions.sourceContext ? ["Share"] : undefined}
      annotationFocusRequest={verbs.noteEdit?.id === annotation.id ? verbs.noteEdit.request : null}
      onAnnotationClose={verbs.closeNoteEdit} onChanged={actions.refresh}
      resourceDetails={<>
        {placement === "unlocated" && unresolvedText ? <FeedbackNotice content={{ tone: "Warning", title: PLACEMENT_COPY.unlocated }} announcement="None"
          actions={[{ label: "select matching text to relocate", onClick: () => verbs.relocate(annotation.id) }]} />
          : placement !== "placed" ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY[placement] }} announcement="None" /> : null}
        {placementDetails}
      </>} />;
  }
  if (entry.kind === "link") {
    const { resource, link } = entry.link;
    return <ResourceOutlineRow resourceRef={resource.ref} occurrenceKey={occurrenceKey} rowRef={row} rootProps={rootProps} onChanged={actions.refresh}
      incoming={link ? { kind: "link", linkId: link.link_id, parentLabel: actions.mediaLabel, unlink: () => onUnlink(link.link_id, row.current) } : null}
      occurrenceLabel={link ? undefined : "mentions this document"} />;
  }
  const { root } = entry;
  const content = root.content;
  return <ResourceOutlineRow incoming={null} item={rootItem(root)} occurrenceKey={occurrenceKey} rowRef={row} rootProps={rootProps}
    omitResourceActions={!actions.sourceContext && content.kind === "Highlight" ? ["Share"] : undefined}
    sourceContent={content.kind === "SourceReference" ? <SourceNote occurrenceKey={occurrenceKey} reference={content} mediaId={root.source.media_id} identity={root.source.identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    onChanged={actions.refresh}
    resourceDetails={<>
      {placementDetails}
      {root.resolution?.kind === "Unavailable" ? <span className={styles.quiet}>location unavailable</span> : null}
    </>}
  />;
}
