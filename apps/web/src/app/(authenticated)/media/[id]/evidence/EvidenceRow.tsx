"use client";

// One evidence fact: a highlight (its note, edited here), a source note with
// its targets' text, a citation or a link. Removal follows its owning command.
// A current reveal moves only its owning sidebar, then acknowledges delivery.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import AnnotationNoteEditor from "@/components/notes/AnnotationNoteEditor";
import ResourceOutlineRow, { connectionOriginLabel } from "@/components/resources/ResourceOutlineRow";
import { ResourceOutlineContext } from "@/components/resources/ResourceOutlineList";
import ResourceBody from "@/components/resources/ResourceBody";
import MachineText from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useInteractionOwner } from "@/lib/ui/overlay";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchNote } from "@/lib/notes/api";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import styles from "../media.module.css";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";
import SourceNote from "./SourceNote";

export type EvidenceItem = Schema<"ReaderEvidencePassageGroupOut">["items"][number];
export interface EvidenceOpenRequest {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly onResolved: (element: HTMLElement | null) => void;
}

export interface EvidenceActions {
  readonly verbs: Pick<
    AnnotationVerbs,
    "noteEdit" | "hovered" | "hover" | "closeNoteEdit" | "relocate"
  >;
  readonly refresh: () => void;
}

/** The note editor over an annotation, its existing note loaded at its current versions. */
function NoteEditorHost({
  target,
  noteBlockId,
  actions,
  done,
}: {
  readonly target: { readonly kind: "highlight" | "link"; readonly id: string };
  readonly noteBlockId: string | null;
  readonly actions: EvidenceActions;
  readonly done: () => void;
}) {
  const [note, setNote] = useState<Schema<"LinkedNoteBlockRef"> | "loading" | "failed" | null>(
    noteBlockId ? "loading" : null,
  );
  const currentNote = useRef(note);
  const previousAttachment = useRef(noteBlockId);
  const root = useRef<HTMLDivElement>(null);
  const paneActive = usePaneIsActive();
  currentNote.current = note;
  const currentDone = useRef(done);
  currentDone.current = done;
  const loadedNoteId = typeof note === "object" ? note?.note_block_id ?? null : null;
  const deleted = (noteBlockId !== null && isDeletedResource(`note_block:${noteBlockId}`)) ||
    (loadedNoteId !== null && isDeletedResource(`note_block:${loadedNoteId}`));
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    const detached = previousAttachment.current !== null && noteBlockId === null;
    previousAttachment.current = noteBlockId;
    if (detached) { currentDone.current(); return; }
    let live = true;
    const closeDeleted = () => {
      const loaded = currentNote.current;
      if ((noteBlockId !== null && isDeletedResource(`note_block:${noteBlockId}`)) ||
        (typeof loaded === "object" && loaded !== null && isDeletedResource(`note_block:${loaded.note_block_id}`))) {
        live = false;
        currentDone.current();
        return true;
      }
      return false;
    };
    if (closeDeleted()) return;
    const unsubscribe = subscribeLinkMutations((change) => {
      if (live && change.kind === "resource_deleted") closeDeleted();
    });
    const cleanup = () => { live = false; unsubscribe(); };
    if (!noteBlockId) return cleanup;
    // A save already supplied this exact body and versions. Keep its editor
    // mounted so an unsaved successor remains in the same writing session.
    if (typeof currentNote.current === "object" && currentNote.current?.note_block_id === noteBlockId) return cleanup;
    setBusy(true);
    setNote((current) => current === "failed" ? current : "loading");
    void fetchNote(noteBlockId).then(
      (row) => {
        if (!live || closeDeleted()) return;
        const { body_pm_json, body_text, body_version, embedded_item } = row;
        setNote({ note_block_id: noteBlockId, body_pm_json, body_text, body_version, embedded_item });
      },
    ).catch((error: unknown) => {
      if (!live || closeDeleted() || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
      setNote("failed");
    }).finally(() => { if (live) setBusy(false); });
    return cleanup;
  }, [loadedNoteId, noteBlockId, retry]);
  if (deleted) return null;
  if (defect) throw defect.error;
  const { verbs } = actions;
  return (
    <div className={styles.noteEditor} ref={root} tabIndex={-1}>
      {note === "loading" ? (
        <FeedbackStatus content={{ tone: "Neutral", title: "loading note…" }} announcement={paneActive ? "Polite" : "None"} />
      ) : note === "failed" ? (
        <FeedbackNotice
          content={{ tone: "Danger", title: "couldn’t load the note" }}
          announcement={paneActive ? "Polite" : "None"}
          actions={[{ label: "retry", onClick: () => setRetry((value) => value + 1), busy }]}
          returnFocus={() => root.current?.querySelector<HTMLElement>("[contenteditable=true]") ?? root.current}
        />
      ) : (
        <AnnotationNoteEditor
          target={target}
          note={note}
          editable
          focusRequest={verbs.noteEdit?.kind === target.kind && verbs.noteEdit.id === target.id ? verbs.noteEdit.request : 0}
          onSaved={(_targetId, saved) => { setNote(saved); actions.refresh(); }}
          onDetached={() => { setNote(null); actions.refresh(); }}
        />
      )}
      <button type="button" className={styles.textButton} onClick={done}>
        Done editing note
      </button>
    </div>
  );
}

export default function EvidenceRow({ item, actions, active, visible, unresolvedText, mediaId, identity, apparatusSource, openRequest, revealInSidebar, reader, onConnectionChanged }: {
  readonly item: EvidenceItem;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly visible: boolean;
  readonly unresolvedText: boolean;
  readonly mediaId: string;
  readonly identity: string;
  readonly apparatusSource: Schema<"SourceAttributionOut"> | null;
  readonly openRequest: EvidenceOpenRequest | null;
  readonly revealInSidebar: (element: HTMLElement) => void;
  readonly reader: Reader;
  readonly onConnectionChanged: (row: HTMLElement | null) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const interactionOwner = useInteractionOwner();
  const outline = useContext(ResourceOutlineContext);
  const focused = outline?.view.focused ?? null;
  const showAll = outline?.showAll;
  useLayoutEffect(() => {
    if (!visible || !openRequest?.isCurrent()) return;
    const element = row.current;
    if (focused !== null && focused !== `evidence:${item.id}`) { showAll?.(); return; }
    // A retained companion mounts its rows before attaching the mobile sheet.
    if (!element?.isConnected || element.closest("[hidden], [inert]") || !element.getClientRects().length) return;
    revealInSidebar(element);
    openRequest.onResolved(element);
  }, [openRequest, revealInSidebar, interactionOwner, visible, focused, showAll, item.id]);
  const [linkNote, setLinkNote] = useState(false);
  const { verbs } = actions;
  const highlight = item.kind === "Highlight" ? item : null;
  const editing = highlight !== null && verbs.noteEdit?.kind === "highlight" && verbs.noteEdit.id === highlight.highlight_id;
  const editingLink = item.kind === "Link" && (linkNote || (verbs.noteEdit?.kind === "link" && verbs.noteEdit.id === item.edge_id));
  const annotation = item.associations.find((a) => a.relationship === "DirectlyAttached" && a.origin === "highlight_note" && a.object.kind === "Note");
  const annotationId = annotation?.object.kind === "Note" ? annotation.object.note_block_id : null;
  const resourceItem: Schema<"ResourceItemOut"> = item.kind === "SourceReference" ? {
    ref: item.resource_ref,
    action_ref: item.action_ref,
    label: item.label,
    preview: {
      body: { kind: "passage", prefix: null, exact: item.excerpt, suffix: null, color: null },
      source: apparatusSource === null ? null : { ...apparatusSource, location_label: item.location_label },
      annotation: null,
    },
    activation: item.activation,
    missing: false,
  } : item.item;
  return <ResourceOutlineRow item={resourceItem} occurrenceKey={`evidence:${item.id}`} rowRef={row}
    presentation={item.kind === "GeneratedCitation" && resourceItem.preview.body.kind === "passage" ? "quoted_passage" : undefined}
    edgeId={"edge_id" in item ? item.edge_id : undefined}
    body={item.kind === "SourceReference" ? <SourceNote reference={item} mediaId={mediaId} identity={identity} openRequest={openRequest} reader={reader} onContentChanged={actions.refresh} /> : undefined}
    rootProps={{ "data-active": active || openRequest !== null, onMouseEnter: () => { if (highlight) verbs.hover(highlight.highlight_id); }, onMouseLeave: () => { if (highlight) verbs.hover(null); } }}
    contextMutation={"mutation" in item ? item.mutation ?? undefined : undefined}
    onChanged={() => onConnectionChanged(row.current)}
    annotationEditor={editing && highlight ? <NoteEditorHost target={{ kind: "highlight", id: highlight.highlight_id }} noteBlockId={annotationId} actions={actions} done={verbs.closeNoteEdit} /> : undefined}
    historical={item.kind === "GeneratedCitation"}
    occurrenceLabel={item.kind === "GeneratedCitation" ? `citation${item.role === "context" ? "" : ` · ${item.role}`}`
      : item.kind === "Link" || item.kind === "MachineLink" ? `${connectionOriginLabel(item.origin)}${item.role === "context" ? "" : ` · ${item.role}`}` : undefined}
    creation={"creation" in item ? item.creation : null}
    resourceActions={unresolvedText && highlight?.is_owner ? [{ kind: "command", id: "Evidence.RelocateHighlight", label: "select matching text to relocate", onSelect: () => verbs.relocate(highlight.highlight_id) }] : []}
    resourceDetails={unresolvedText && highlight ? <span className={resourceStyles.quiet}>location unresolved</span> : null}
    occurrenceActions={item.kind === "Link" && item.origin === "user" && item.role === "context" ? [{ kind: "command", id: "Evidence.EditLinkNote", label: "edit note on link", onSelect: () => setLinkNote(true) }] : []}
    details={<>
      {item.kind === "MachineLink" && item.rationale ? <MachineText variant="inline" origin={{ label: item.origin === "discovery" ? "Connection discovery" : "Assistant" }}>{item.rationale}</MachineText> : null}
      {editingLink && item.kind === "Link" ? <NoteEditorHost target={{ kind: "link", id: item.edge_id }} noteBlockId={item.link_note?.note_block_id ?? null} actions={actions} done={() => { setLinkNote(false); verbs.closeNoteEdit(); }} /> : null}
      {item.kind === "Link" && item.link_note && !editingLink ? <div className={resourceStyles.details}><span className={resourceStyles.quiet}>note on link</span><ResourceBody body={item.link_note.item.preview.body} /></div> : null}
    </>}
  />;
}
