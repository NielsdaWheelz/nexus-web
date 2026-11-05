"use client";

// One reader evidence row. Local highlights and whole-document links render from the
// held local projections; remote roots keep their server presentation. Membership
// only selects facets and reveal targets; the shared row owns resource commands.
import { useCallback, useLayoutEffect, useRef, type CSSProperties } from "react";
import QuotedMessageConnection from "@/components/chat/QuotedMessageConnection";
import Button from "@/components/ui/Button";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { PlacementNote } from "@/lib/documentReader/chrome/ReaderAnnotation";
import type { ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { Reader } from "@/lib/documentReader/runtime";
import { useInteractionOwner } from "@/lib/ui/overlay";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import type { LocalLink } from "../annotations";
import SourceNote from "./SourceNote";
import styles from "./EvidencePane.module.css";
import { rootItem, type EvidenceRoot } from "./model";
import type { useEvidenceWindow } from "./useEvidenceWindow";

export interface EvidenceOpenRequest {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly onResolved: (element: HTMLElement | null) => void;
}

export interface EvidenceActions {
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

export default function EvidenceRow({ entry, actions, active, presence, placed, unresolvedText, openRequest, reader, revealInSidebar, onUnlink, style, className, sourceText, onSourceTextChange, position, count, rowWindow }: {
  readonly rowWindow: Pick<ReturnType<typeof useEvidenceWindow>, "observeRow" | "reserve" | "moving">;
  readonly position: number | null;
  readonly count: number;
  readonly sourceText: ReadonlySet<string>;
  readonly onSourceTextChange: (key: string, open: boolean) => void;
  readonly entry: EvidenceEntry;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  /** A measuring row is laid out for the margin to read, and no request reaches it until it is shown. */
  readonly presence: "hidden" | "measuring" | "shown";
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
}) {
  const row = useRef<HTMLLIElement | null>(null);
  const { observeRow } = rowWindow;
  const attachRow = useCallback((node: HTMLLIElement | null) => {
    row.current = node;
    observeRow(entry.key, node);
  }, [entry.key, observeRow]);
  const interactionOwner = useInteractionOwner();
  const occurrenceKey = `evidence/${entry.key}`;
  useLayoutEffect(() => {
    if (presence !== "shown" || !openRequest?.isCurrent()) return;
    const element = row.current;
    if (!element?.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) return;
    revealInSidebar(element);
    if (openRequest.isCurrent()) openRequest.onResolved(element);
  }, [openRequest, interactionOwner, presence, occurrenceKey, revealInSidebar]);
  const { verbs } = actions;
  const highlightId = entry.kind === "highlight" ? entry.annotation.id
    : entry.kind === "remote" && entry.root.content.kind === "Highlight" ? entry.root.content.highlight_id : null;
  const rootProps = { hidden: presence === "hidden", style: { ...style, ...rowWindow.reserve(entry.key) }, className, "data-active": active || openRequest !== null, "data-group": entry.key, "data-window-key": entry.key,
    "aria-posinset": position ?? undefined, "aria-setsize": count,
    // a row passing under a still pointer is no hover.
    onMouseEnter: () => { if (highlightId && !rowWindow.moving()) verbs.hover(highlightId); },
    onMouseLeave: () => { if (highlightId) verbs.hover(null); },
  };
  if (entry.kind === "highlight") {
    const { annotation } = entry;
    const placement = annotation.placement.kind;
    if (annotation.display === null) return null;
    return <PreparedResourcesContext value={annotation.display.resources}><ResourceOutlineRow resource={annotation.display.projection} readingRef={annotation.readingRef} incoming={null} occurrenceKey={occurrenceKey} rowRef={attachRow} rootProps={rootProps} inSource={placed}
      omitResourceActions={actions.sourceContext ? ["EditHighlightAnnotation"] : ["EditHighlightAnnotation", "Share"]}
      rowActions={[{ kind: "command", id: "EditHighlightAnnotation", label: annotation.body === null ? "annotate" : "edit annotation",
        icon: <ACTION_CATALOG.EditHighlightAnnotation.icon aria-hidden="true" />, restoreFocusOnClose: false, onSelect: () => verbs.annotate(annotation.id) }]}
      annotationFocusRequest={presence === "shown" && verbs.noteEdit?.id === annotation.id ? verbs.noteEdit.request : null}
      onAnnotationClose={verbs.closeNoteEdit} onChanged={actions.refresh}
      resourceDetails={<>
        {placement !== "placed" ? <PlacementNote kind={placement} /> : null}
        {placement === "unlocated" && unresolvedText ? <Button onClick={() => verbs.relocate(annotation.id)}>relocate</Button> : null}
      </>} /></PreparedResourcesContext>;
  }
  if (entry.kind === "link") {
    const { resource, link } = entry.link;
    return <ResourceOutlineRow resource={resource} occurrenceKey={occurrenceKey} rowRef={attachRow} rootProps={rootProps} onChanged={actions.refresh}
      incoming={link ? { kind: "link", linkId: link.link_id, parentLabel: actions.mediaLabel, unlink: () => onUnlink(link.link_id, row.current) } : null}
      occurrenceLabel={link ? undefined : "mentions this document"} />;
  }
  const { root } = entry;
  const content = root.content;
  if (content.kind === "Quotation") return <li ref={attachRow} {...rootProps}>
    <QuotedMessageConnection content={content} />
  </li>;
  const disclosureKey = sourceTextKey(entry);
  return <ResourceOutlineRow incoming={null} item={rootItem(root)} occurrenceKey={occurrenceKey} rowRef={attachRow} rootProps={rootProps} inSource={placed && content.kind === "Highlight"}
    omitResourceActions={!actions.sourceContext && content.kind === "Highlight" ? ["Share"] : undefined}
    sourceContent={content.kind === "SourceReference" && disclosureKey !== null ? <SourceNote disclosureKey={disclosureKey} open={sourceText.has(disclosureKey)} onOpenChange={onSourceTextChange} occurrenceKey={occurrenceKey} reference={content} mediaId={root.source.media_id} identity={root.source.identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    onChanged={actions.refresh}
    resourceDetails={root.resolution?.kind === "Unavailable" ? <span className={styles.quiet}>location unavailable</span> : null}
  />;
}
