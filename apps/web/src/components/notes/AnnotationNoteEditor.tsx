"use client";

// The evidence row's autosaving note on an existing highlight or link. Its first
// non-empty save creates and attaches it; later edits save like any note.
// "Remove annotation" detaches it and keeps the note. Undo belongs to this editor.
import { useEffect, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import { NoteConflict, WritingStatus } from "@/components/notes/NoteNotices";
import Button from "@/components/ui/Button";
import { apiFetch, apiTransportFeedback, isApiError, type ApiPath } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { emptyBody, type NoteBody } from "@/lib/notes/noteBody";
import {
  adoptText,
  createText,
  editText,
  readText,
  setCreator,
  useText,
  type Creator,
} from "@/lib/notes/texts";
import styles from "./AnnotationNoteEditor.module.css";

type AttachedNote = Schema<"LinkedNoteBlockRef">;

export interface AnnotationTarget {
  readonly kind: "highlight" | "link";
  readonly id: string;
}

export interface AnnotationNoteEditorProps {
  target: AnnotationTarget;
  note: AttachedNote | null;
  editable: boolean;
  onSaved: (targetId: string, note: AttachedNote) => void;
  onDetached: (targetId: string, noteBlockId: string) => void;
  /** Each new positive value focuses the note's end. */
  focusRequest?: number;
}

const notePath = (target: AnnotationTarget["kind"], id: string, noteId?: string) =>
  `/api/${target === "highlight" ? "highlights" : "resource-graph/links"}/${id}/note${
    noteId ? `/${noteId}` : ""
  }` as ApiPath;

export default function AnnotationNoteEditor(props: AnnotationNoteEditorProps) {
  const { target, note, editable, focusRequest = 0 } = props;
  const feedback = useFeedback();
  const [noteId] = useState(() => note?.note_block_id ?? crypto.randomUUID());
  const ref = `note_block:${noteId}`;
  const targetId = target.id;
  const [attached, setAttached] = useState(note !== null);
  const [detaching, setDetaching] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const text = useText(ref);
  const creatingHighlight = target.kind === "highlight" && !note && !attached ? targetId : null;
  const highlight = usePaneFreeServerValue<Schema<"TypedHighlightOut">>({
    key: creatingHighlight && `annotation-create:${creatingHighlight}`,
    stale: "",
    load: async (signal) => {
      if (!creatingHighlight) throw new Error("A highlight note needs its target");
      return (await apiFetch<ApiJson<"/highlights/{highlight_id}", "get">>(
        `/api/highlights/${creatingHighlight}`, { signal },
      )).data;
    },
  });

  // The note as the server has it, or a new one made by its first non-empty save.
  useEffect(() => {
    if (note) adoptText(ref, { body_pm_json: note.body_pm_json, body_text: note.body_text }, note.body_version);
    else if (!readText(ref)) createText(ref, emptyBody(), null);
  }, [note, ref]);

  // Freeze the observed empty highlight slot before binding its first save.
  const linksVersion = highlight.status === "ready" ? highlight.data.links_version : null;
  useEffect(() => {
    if (note || attached || (target.kind === "highlight" && linksVersion === null)) return;
    const creator: Creator = {
      request: (value: NoteBody) => ({
        path: notePath(target.kind, targetId),
        method: "PUT",
        body: {
          note_id: noteId,
          body_pm_json: value.body_pm_json,
          ...(target.kind === "highlight" ? { expected: { kind: "absent", version: linksVersion } } : {}),
        },
      }),
      settle(reply) {
        // justify-type-assertion: both note routes answer the attached note.
        const saved = reply as AttachedNote;
        reported.current = saved.body_version;
        setAttached(true);
        latest.current.onSaved(targetId, saved);
        return saved.body_version;
      },
    };
    setCreator(ref, creator);
  }, [attached, linksVersion, note, noteId, ref, target.kind, targetId]);

  // Later saves report the note as saved, so the reader shows its new text.
  const version = text?.acked?.version ?? null;
  const reported = useRef(note?.body_version ?? null);
  useEffect(() => {
    if (version === null || !attached || reported.current === version) return;
    reported.current = version;
    const value = text!.acked!.value as NoteBody;
    latest.current.onSaved(targetId, { note_block_id: noteId, ...value, body_version: version });
  }, [attached, noteId, targetId, text, version]);

  const detach = () => {
    setDetaching(true);
    apiFetch(notePath(target.kind, targetId, noteId), { method: "DELETE" }).then(
      () => {
        setAttached(false);
        latest.current.onDetached(targetId, noteId);
      },
      (error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        const title = "Annotation wasn’t removed";
        const content = (isApiError(error) && apiTransportFeedback(error, title)) || {
          tone: "Danger" as const,
          title,
          message: "Retry, or refresh the reader.",
        };
        feedback.offer({ key: "annotation-note", announcement: "Polite", content });
      },
    ).finally(() => setDetaching(false));
  };

  if (!text || typeof text.value === "string") return null;
  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <NoteEditor
        editorKey={ref}
        body={text.value}
        revision={text.revision}
        editable={editable}
        label={target.kind === "highlight" ? "Highlight note" : "Link note"}
        compact
        focus={focusRequest > 0 ? { selection: "end", serial: focusRequest } : null}
        history={null}
        onEdit={(edit) => editText(ref, edit.after)}
        embeddedItem={note?.embedded_item ?? null}
      />
      <NoteConflict textRef={ref} />
      {creatingHighlight && highlight.status === "failed" ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "note setup failed", message: "your draft is kept", requestId: highlight.error.requestId }}
          announcement="Polite"
          actions={[{ label: "retry note setup", onClick: highlight.refetch, busy: highlight.retrying }]}
        />
      ) : null}
      <div className={styles.actions}>
        <WritingStatus />
        {attached && editable ? (
          <Button variant="ghost" size="sm" onClick={detach} disabled={detaching}>
            Remove annotation
          </Button>
        ) : null}
      </div>
    </div>
  );
}
