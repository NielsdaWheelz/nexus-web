"use client";

// Every reader root is a resource. Membership facts only select its facets and
// reveal target; lazy shared disclosure owns individual relationship commands.
import { useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import AnnotationNoteHost from "@/components/notes/AnnotationNoteHost";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { ResourceOutlineContext } from "@/components/resources/ResourceOutlineList";
import type { Reader } from "@/lib/documentReader/runtime";
import { useInteractionOwner } from "@/lib/ui/overlay";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";
import SourceNote from "./SourceNote";
import styles from "./EvidencePane.module.css";
import { rootItem, type EvidenceRoot } from "./model";

export interface EvidenceOpenRequest {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly onResolved: (element: HTMLElement | null) => void;
}

export interface EvidenceActions {
  readonly verbs: Pick<AnnotationVerbs, "noteEdit" | "hovered" | "hover" | "closeNoteEdit" | "relocate">;
  readonly refresh: () => void;
}

export default function EvidenceRow({ root, actions, active, visible, unresolvedText, openRequest, reader, revealInSidebar, style, className, displaced }: {
  readonly root: EvidenceRoot;
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
}) {
  const row = useRef<HTMLLIElement>(null);
  const interactionOwner = useInteractionOwner();
  const outline = useContext(ResourceOutlineContext);
  const focused = outline?.view.focused ?? null;
  const showAll = outline?.showAll;
  const occurrenceKey = `evidence:${root.ref}`;
  useLayoutEffect(() => {
    if (!visible || !openRequest?.isCurrent()) return;
    const element = row.current;
    if (focused !== null && focused !== occurrenceKey) { showAll?.(); return; }
    if (!element?.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) return;
    revealInSidebar(element);
    if (openRequest.isCurrent()) openRequest.onResolved(element);
  }, [openRequest, interactionOwner, visible, focused, occurrenceKey, showAll, revealInSidebar]);
  const { verbs } = actions;
  const content = root.content;
  const highlight = content.kind === "Highlight" ? content : null;
  const editing = highlight?.is_owner === true && verbs.noteEdit?.kind === "highlight" && verbs.noteEdit.id === highlight.highlight_id;
  return <ResourceOutlineRow item={rootItem(root)} occurrenceKey={occurrenceKey} rowRef={row}
    body={content.kind === "SourceReference" ? <SourceNote occurrenceKey={occurrenceKey} reference={content} mediaId={root.source.media_id} identity={root.source.identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    rootProps={{ hidden: !visible, style, className, "data-active": active || openRequest !== null,
      ...{ "data-group": root.ref },
      onMouseEnter: () => { if (highlight) verbs.hover(highlight.highlight_id); },
      onMouseLeave: () => { if (highlight) verbs.hover(null); },
    }}
    onChanged={actions.refresh}
    annotationEditor={editing && highlight ? <AnnotationNoteHost target={{ kind: "highlight", id: highlight.highlight_id }}
      noteRef={highlight.item.preview.annotation?.note_ref ?? null} occurrenceKey={occurrenceKey}
      focusRequest={verbs.noteEdit?.request ?? 0} onChanged={actions.refresh} onClose={verbs.closeNoteEdit} /> : undefined}
    resourceActions={unresolvedText && highlight?.is_owner ? [{ kind: "command", id: "Evidence.RelocateHighlight", label: "select matching text to relocate", onSelect: () => verbs.relocate(highlight.highlight_id) }] : []}
    resourceDetails={<>
      {displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
      {root.resolution?.kind === "Unavailable" ? <span className={resourceStyles.quiet}>location unavailable</span> : null}
    </>}
  />;
}
