"use client";

// One annotation occurrence retains its first-save id. Canonical texts own its
// body and acknowledgement, including a save that settles while this is unmounted.
import { useEffect, useMemo, useRef } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import AnnotationNoteEditor, { type AnnotationTarget } from "./AnnotationNoteEditor";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { bodyHasContent } from "@/lib/notes/noteBody";
import { readTextTitle, useText } from "@/lib/notes/texts";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { isDeletedResource, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import styles from "@/components/resources/ResourceOutline.module.css";

export default function AnnotationNoteHost({ target, noteRef, occurrenceKey, focusRequest, onChanged, onClose }: {
  target: AnnotationTarget;
  noteRef: string | null;
  occurrenceKey: string;
  focusRequest: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { value: draft, set: setDraft, read: readDraft } = useResourceDraft(`Annotations.Note:${occurrenceKey}`, () => ({
    noteId: noteRef?.slice("note_block:".length) ?? crypto.randomUUID(),
    attachmentRef: noteRef,
  }));
  const retainedRef = `note_block:${draft.noteId}`;
  const retainedText = useText(retainedRef);
  // A competing first create must not replace the draft whose write will report
  // the slot conflict. Canonical text ownership already knows its settlement.
  const keepDraft = noteRef !== null && noteRef !== retainedRef && retainedText !== undefined
    && typeof retainedText.value !== "string" && bodyHasContent(retainedText.value)
    && readTextTitle(retainedRef)?.unsettled === true;
  const changedAttachment = noteRef !== draft.attachmentRef && !keepDraft;
  const noteId = changedAttachment && noteRef !== null ? noteRef.slice("note_block:".length) : draft.noteId;
  const ref = `note_block:${noteId}`;
  const removedAttachment = noteRef === null && draft.attachmentRef === ref;
  const text = useText(ref);
  const root = useRef<HTMLDivElement>(null);
  const paneActive = usePaneIsActive();
  const close = () => {
    const ownsFocus = root.current?.contains(document.activeElement) ?? false;
    const row = root.current?.closest("[data-outline-occurrence]");
    const control = row?.querySelector<HTMLElement>("[data-row-focusable]:not(:disabled)");
    onClose();
    if (ownsFocus && control?.isConnected) control.focus({ preventScroll: true });
  };
  const currentClose = useRef(close);
  currentClose.current = close;
  const deleted = isDeletedResource(ref);
  const attachedRef = noteRef === ref ? noteRef : null;
  const read = usePaneFreeServerValue<Schema<"NoteBlockOut">>({
    key: !deleted && attachedRef !== null ? `annotation-note:${attachedRef}` : null,
    stale: "",
    load: async (signal) => (await apiFetch<ApiJson<"/notes/blocks/{note_id}", "get">>(
      `/api/notes/blocks/${noteId}`, { signal },
    )).data,
  });

  useEffect(() => {
    if (!changedAttachment) return;
    setDraft({
      noteId: removedAttachment ? crypto.randomUUID() : noteId,
      attachmentRef: noteRef,
    });
    if (removedAttachment) currentClose.current();
  }, [changedAttachment, removedAttachment, setDraft, noteId, noteRef]);
  useEffect(() => {
    const closeDeleted = () => { if (isDeletedResource(ref)) currentClose.current(); };
    closeDeleted();
    return subscribeLinkMutations((change) => { if (change.kind === "resource_deleted") closeDeleted(); });
  }, [ref]);

  const loaded = read.status === "ready" && attachedRef !== null ? read.data : null;
  const note = useMemo<Schema<"LinkedNoteBlockRef"> | null>(() => loaded === null ? null : {
    note_block_id: noteId,
    body_pm_json: loaded.body_pm_json,
    body_text: loaded.body_text,
    body_version: loaded.body_version,
    embedded_item: loaded.embedded_item,
  }, [loaded, noteId]);
  if (deleted) return null;
  return <div className={styles.details} ref={root} tabIndex={-1}>
    {note === null && text?.acked == null && attachedRef !== null ? read.status === "failed" ? <FeedbackNotice
      content={{ tone: "Danger", title: "couldn’t load the note", requestId: read.error.requestId }}
      announcement={paneActive ? "Polite" : "None"}
      actions={[{ label: "retry", onClick: read.refetch, busy: read.retrying }]}
      returnFocus={() => root.current?.querySelector<HTMLElement>("[contenteditable=true]") ?? root.current}
    /> : <FeedbackStatus content={{ tone: "Neutral", title: "loading note…" }} announcement={paneActive ? "Polite" : "None"} /> : <AnnotationNoteEditor
      key={noteId}
      target={target}
      noteId={noteId}
      note={note}
      editable
      focusRequest={focusRequest}
      onSaved={onChanged}
      onDetached={() => {
        if (readDraft().noteId === noteId) {
          setDraft({ noteId: crypto.randomUUID(), attachmentRef: noteRef });
          close();
        }
        onChanged();
      }}
    />}
    <button type="button" className={styles.textButton} onClick={close}>done editing note</button>
  </div>;
}
