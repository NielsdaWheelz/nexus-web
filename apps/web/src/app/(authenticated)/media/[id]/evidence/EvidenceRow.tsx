"use client";

// One reader evidence row. Local highlights and whole-document links render from the
// account database by ref; remote roots keep their server presentation. Membership
// only selects facets and reveal targets; the shared row owns resource commands.
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
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
  /** The media can mount a reader, so a row's placement is still coming until it has. */
  readonly readable: boolean;
  readonly sourceContext: boolean;
  /** The media every whole-document link attaches to. */
  readonly mediaLabel: string;
  readonly verbs: Pick<AnnotationVerbs, "noteEdit" | "annotate" | "hovered" | "hover" | "closeNoteEdit" | "relocate">;
  readonly refresh: () => void;
}

export type EvidenceEntry =
  | { readonly kind: "highlight"; readonly key: string; readonly annotation: ReaderAnnotation }
  | { readonly kind: "link"; readonly key: string; readonly link: LocalLink }
  | { readonly kind: "remote"; readonly key: string; readonly root: EvidenceRoot };

/** The same source reference can occur more than once in a mounted document. */
export function sourceTextKey(entry: EvidenceEntry): string | null {
  return entry.kind === "remote" && entry.root.content.kind === "SourceReference"
    ? JSON.stringify([entry.root.source.media_id, entry.root.source.identity, `evidence/${entry.key}`]) : null;
}

export default function EvidenceRow({ entry, actions, active, visible, placed, unresolvedText, openRequest, reader, revealInSidebar, onUnlink, style, className, displaced, sourceText, onSourceTextChange, onSourceLayout, position, count }: {
  readonly position: number | null;
  readonly count: number;
  readonly sourceText: ReadonlySet<string>;
  readonly onSourceTextChange: (key: string, open: boolean) => void;
  readonly onSourceLayout: (key: string, pending: boolean | null) => void;
  readonly entry: EvidenceEntry;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly visible: boolean;
  /** This entry has an extent in the mounted publication. */
  readonly placed: boolean;
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
  const rootProps = { hidden: !visible, style, className, "data-active": active || openRequest !== null, "data-group": entry.key, "data-window-key": entry.key,
    "aria-posinset": position ?? undefined, "aria-setsize": count,
    onMouseEnter: () => { if (highlightId) verbs.hover(highlightId); },
    onMouseLeave: () => { if (highlightId) verbs.hover(null); },
  };
  const placementDetails = <>
    {displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
  </>;
  if (entry.kind === "highlight") {
    const { annotation } = entry;
    const placement = annotation.placement.kind;
    return <ResourceOutlineRow resourceRef={annotation.ref} readingRef={annotation.readingRef} incoming={null} occurrenceKey={occurrenceKey} rowRef={row} rootProps={rootProps} inSource={placed}
      omitResourceActions={actions.sourceContext ? ["EditHighlightAnnotation"] : ["EditHighlightAnnotation", "Share"]}
      rowActions={[{ kind: "command", id: "EditHighlightAnnotation", label: annotation.body === null ? "annotate" : "edit annotation",
        icon: <ACTION_CATALOG.EditHighlightAnnotation.icon size={16} aria-hidden="true" />, restoreFocusOnClose: false, onSelect: () => verbs.annotate(annotation.id) }]}
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
  const disclosureKey = sourceTextKey(entry);
  return <ResourceOutlineRow incoming={null} item={rootItem(root)} occurrenceKey={occurrenceKey} rowRef={row} rootProps={rootProps} inSource={placed && content.kind === "Highlight"}
    omitResourceActions={!actions.sourceContext && content.kind === "Highlight" ? ["Share"] : undefined}
    sourceContent={content.kind === "SourceReference" && disclosureKey !== null ? <SourceNote disclosureKey={disclosureKey} open={sourceText.has(disclosureKey)} onOpenChange={onSourceTextChange} onLayout={onSourceLayout} occurrenceKey={occurrenceKey} reference={content} mediaId={root.source.media_id} identity={root.source.identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    onChanged={actions.refresh}
    resourceDetails={<>
      {placementDetails}
      {root.resolution?.kind === "Unavailable" ? <span className={styles.quiet}>location unavailable</span> : null}
    </>}
  />;
}
