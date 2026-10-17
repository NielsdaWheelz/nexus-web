"use client";

// One evidence fact: a highlight (its note, edited here), a source note with
// its targets' text, a citation or a link. Removal follows its owning command.
import { useEffect, useRef, useState } from "react";
import AnnotationNoteEditor from "@/components/notes/AnnotationNoteEditor";
import ResourceOutlineRow, { connectionOriginLabel } from "@/components/resources/ResourceOutlineRow";
import ResourceBody from "@/components/resources/ResourceBody";
import MachineText from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchNote } from "@/lib/notes/api";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import styles from "../media.module.css";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";

export type EvidenceItem = Schema<"ReaderEvidencePassageGroupOut">["items"][number];

export interface EvidenceActions {
  readonly verbs: Pick<
    AnnotationVerbs,
    "noteEdit" | "hovered" | "hover" | "closeNoteEdit"
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
  currentNote.current = note;
  const currentDone = useRef(done);
  currentDone.current = done;
  const loadedNoteId = typeof note === "object" ? note?.note_block_id ?? null : null;
  const deleted = (noteBlockId !== null && isDeletedResource(`note_block:${noteBlockId}`)) ||
    (loadedNoteId !== null && isDeletedResource(`note_block:${loadedNoteId}`));
  const [retry, setRetry] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
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
    setNote("loading");
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
    });
    return cleanup;
  }, [loadedNoteId, noteBlockId, retry]);
  if (deleted) return null;
  if (defect) throw defect.error;
  const { verbs } = actions;
  return (
    <div className={styles.noteEditor}>
      {note === "loading" ? (
        <p role="status">Loading note…</p>
      ) : note === "failed" ? (
        <div role="alert">The note couldn’t be loaded. <button type="button" className={styles.textButton} onClick={() => setRetry((value) => value + 1)}>Retry</button></div>
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

export default function EvidenceRow({ item, actions, active, onConnectionChanged }: {
  readonly item: EvidenceItem;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly onConnectionChanged: (row: HTMLElement | null) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const [linkNote, setLinkNote] = useState(false);
  const { verbs } = actions;
  const highlight = item.kind === "Highlight" ? item : null;
  const editing = highlight !== null && verbs.noteEdit?.kind === "highlight" && verbs.noteEdit.id === highlight.highlight_id;
  const editingLink = item.kind === "Link" && (linkNote || (verbs.noteEdit?.kind === "link" && verbs.noteEdit.id === item.edge_id));
  const annotation = item.associations.find((a) => a.relationship === "DirectlyAttached" && a.origin === "highlight_note" && a.object.kind === "Note");
  const annotationId = annotation?.object.kind === "Note" ? annotation.object.note_block_id : null;
  const editor = editing && highlight ? <NoteEditorHost target={{ kind: "highlight", id: highlight.highlight_id }} noteBlockId={annotationId} actions={actions} done={verbs.closeNoteEdit} />
    : editingLink && item.kind === "Link" ? <NoteEditorHost target={{ kind: "link", id: item.edge_id }} noteBlockId={item.link_note?.note_block_id ?? null} actions={actions} done={() => { setLinkNote(false); verbs.closeNoteEdit(); }} /> : undefined;
  return <ResourceOutlineRow item={item.item} occurrenceKey={`evidence:${item.id}`} rowRef={row}
    rootProps={{ "data-active": active, onMouseEnter: () => { if (highlight) verbs.hover(highlight.highlight_id); }, onMouseLeave: () => { if (highlight) verbs.hover(null); } }}
    contextMutation={"mutation" in item ? item.mutation ?? undefined : undefined}
    mutationEdgeId={"edge_id" in item ? item.edge_id : undefined}
    onChanged={() => onConnectionChanged(row.current)} annotationEditor={editor}
    historical={item.kind === "GeneratedCitation"}
    occurrenceLabel={item.kind === "GeneratedCitation" ? `citation${item.role === "context" ? "" : ` · ${item.role}`}`
      : item.kind === "Link" || item.kind === "MachineLink" ? `${connectionOriginLabel(item.origin)}${item.role === "context" ? "" : ` · ${item.role}`}` : undefined}
    creation={"creation" in item ? item.creation : null}
    occurrenceActions={item.kind === "Link" && item.origin === "user" && item.role === "context" ? [{ kind: "command", id: "Evidence.EditLinkNote", label: "edit note on link", onSelect: () => setLinkNote(true) }] : []}
    details={<>
      {item.kind === "MachineLink" && item.rationale ? <MachineText variant="inline" origin={{ label: item.origin === "discovery" ? "Connection discovery" : "Assistant" }}>{item.rationale}</MachineText> : null}
      {item.kind === "Link" && item.link_note && !editingLink ? <div className={resourceStyles.details}><span className={resourceStyles.quiet}>note on link</span><ResourceBody body={item.link_note.item.preview.body} /></div> : null}
    </>}
  />;
}
