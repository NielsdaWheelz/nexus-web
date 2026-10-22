"use client";

// Every reader root is a resource. Membership facts only select its facets and
// reveal target; lazy shared disclosure owns individual relationship commands.
import { useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import {FeedbackNotice} from "@/components/feedback/Feedback";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { OutlineSessionContext } from "@/components/resources/ResourceOutlineList";
import type { Reader } from "@/lib/documentReader/runtime";
import type { OutlineDestination, PendingOccurrence } from "@/lib/notes/useOutlineSession";
import { useInteractionOwner } from "@/lib/ui/overlay";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import SourceNote from "./SourceNote";
import styles from "./EvidencePane.module.css";
import { pendingContinuation, pendingRootKey, rootContinuation, rootItem, rootKey, type EvidenceRoot } from "./model";

export interface EvidenceOpenRequest {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly onResolved: (element: HTMLElement | null) => void;
}

export interface EvidenceActions {
  readonly verbs: Pick<AnnotationVerbs, "noteEdit" | "hovered" | "hover" | "closeNoteEdit" | "relocate">;
  readonly refresh: () => void;
}

export type EvidenceEntry = { kind: "root"; root: EvidenceRoot } | { kind: "pending"; pending: PendingOccurrence };

export default function EvidenceRow({ entry, actions, active, visible, unresolvedText, openRequest, reader, revealInSidebar, style, className, displaced, indentDestination = null }: {
  readonly entry: EvidenceEntry;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly visible: boolean;
  readonly unresolvedText: boolean;
  readonly openRequest: EvidenceOpenRequest | null;
  readonly reader: Reader;
  readonly revealInSidebar: (element: HTMLElement) => void;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly displaced: boolean;
  readonly indentDestination?: OutlineDestination | null;
}) {
  const row = useRef<HTMLLIElement>(null);
  const interactionOwner = useInteractionOwner();
  const session = useContext(OutlineSessionContext);
  const root = entry.kind === "root" ? entry.root : null;
  const item = entry.kind === "root" ? rootItem(entry.root) : entry.pending.item;
  const occurrenceKey = entry.kind === "root" ? rootKey(entry.root) : pendingRootKey(entry.pending);
  useLayoutEffect(() => {
    if (!visible || !openRequest?.isCurrent()) return;
    const element = row.current;
    if (!element?.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) return;
    revealInSidebar(element);
    if (openRequest.isCurrent()) openRequest.onResolved(element);
  }, [openRequest, interactionOwner, visible, occurrenceKey, revealInSidebar]);
  const { verbs } = actions;
  const content = root?.content;
  const highlight = content?.kind === "Highlight" ? content : null;
  return <ResourceOutlineRow incoming={null} item={item} occurrenceKey={occurrenceKey} rowRef={row}
    continuation={entry.kind === "root" ? rootContinuation(entry.root) : pendingContinuation(entry.pending)}
    insertionSource={root?.continuation === null ? null : root?.continuation?.kind === "child" ? root.continuation.source : undefined}
    indentDestination={indentDestination}
    annotationFocusRequest={highlight?.is_owner && verbs.noteEdit?.kind === "highlight" && verbs.noteEdit.id === highlight.highlight_id ? verbs.noteEdit.request : null}
    onAnnotationClose={verbs.closeNoteEdit}
    authoredPlacement={root?.authored_placement ? { ...root.authored_placement, key: occurrenceKey, item }
      : entry.kind === "pending" ? session?.pendingPlacement(entry.pending) ?? null : null}
    noteAuthority={entry.kind === "pending" && entry.pending.body !== null ? "local"
      : (entry.kind === "pending" || content?.kind === "Resource") && !item.missing && item.ref.startsWith("note_block:") ? "current" : undefined}
    sourceContent={root && content?.kind === "SourceReference" ? <SourceNote occurrenceKey={occurrenceKey} reference={content} mediaId={root.source.media_id} identity={root.source.identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    rootProps={{ hidden: !visible, style, className, "data-active": active || openRequest !== null,
      ...{ "data-group": item.ref },
      onMouseEnter: () => { if (highlight) verbs.hover(highlight.highlight_id); },
      onMouseLeave: () => { if (highlight) verbs.hover(null); },
    }}
    onChanged={actions.refresh}
    resourceDetails={<>
      {unresolvedText && highlight?.is_owner ? <FeedbackNotice
        content={{tone: "Warning", title: "highlight location unavailable"}} announcement="None"
        actions={[{label: "select matching text to relocate", onClick: () => verbs.relocate(highlight.highlight_id)}]}/> : null}
      {displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
      {root?.resolution?.kind === "Unavailable" ? <span className={styles.quiet}>location unavailable</span> : null}
    </>}
  />;
}
