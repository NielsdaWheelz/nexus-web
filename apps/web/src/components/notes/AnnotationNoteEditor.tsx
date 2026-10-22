"use client";

// An occurrence's autosaving note on an existing highlight or link. Its first
// non-empty save creates and attaches it; later edits save like any note.
// Detaching keeps the note. Text ownership retains first-save retries by note id;
// subsequent edits use the canonical acknowledged body version.
import { useContext, useEffect, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import CanonicalNoteEditor from "./CanonicalNoteEditor";
import {
  OutlineSessionContext,
  OutlineSessionScope,
  ResourceBranch,
} from "@/components/resources/ResourceOutlineList";
import {
  useOutlineSession,
  type OutlineSession,
} from "@/lib/notes/useOutlineSession";
import { WritingStatus } from "@/components/notes/NoteNotices";
import Button from "@/components/ui/Button";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  type ApiPath,
} from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { sendWrite } from "@/lib/notes/api";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { emptyBody, type NoteBody } from "@/lib/notes/noteBody";
import {
  adoptText,
  createText,
  readText,
  setCreator,
  textCreationReady,
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
  noteId: string;
  note: AttachedNote | null;
  editable: boolean;
  onSaved: (targetId: string, note: AttachedNote) => void;
  onDetached: (targetId: string, noteBlockId: string) => void;
  occurrenceKey?: string;
  label?: string;
  atomicEmbeds?: boolean;
}

const notePath = (
  target: AnnotationTarget["kind"],
  id: string,
  noteId?: string,
) =>
  `/api/${target === "highlight" ? "highlights" : "resource-graph/links"}/${id}/note${
    noteId ? `/${noteId}` : ""
  }` as ApiPath;

export default function AnnotationNoteEditor(props: AnnotationNoteEditorProps) {
  const session = useContext(OutlineSessionContext);
  return session ? (
    <SessionAnnotationEditor {...props} session={session} />
  ) : (
    <StandaloneAnnotationEditor {...props} />
  );
}

function StandaloneAnnotationEditor(props: AnnotationNoteEditorProps) {
  const branch = useContext(ResourceBranch);
  const session = useOutlineSession({
    scope:
      props.occurrenceKey ??
      `annotation:${props.target.kind}:${props.target.id}:${props.noteId}`,
    inheritedBranch: branch,
  });
  return (
    <OutlineSessionScope session={session}>
      <SessionAnnotationEditor {...props} session={session} />
    </OutlineSessionScope>
  );
}

function SessionAnnotationEditor(
  props: AnnotationNoteEditorProps & { session: OutlineSession },
) {
  const { target, noteId, note, editable } = props;
  const feedback = useFeedback();
  const ref = `note_block:${noteId}`;
  const targetId = target.id;
  const [detaching, setDetaching] = useState(false);
  const referencing =
    props.session.activeReference ===
    (props.occurrenceKey ?? `note_block:${noteId}`);
  const latest = useRef(props);
  latest.current = props;
  const text = useText(ref);
  const attached = note !== null || text?.acked != null;
  const creatingHighlight =
    target.kind === "highlight" && !note && !attached ? targetId : null;
  const highlight = usePaneFreeServerValue<Schema<"TypedHighlightOut">>({
    key: creatingHighlight && `annotation-create:${creatingHighlight}`,
    stale: "",
    load: async (signal) => {
      if (!creatingHighlight)
        throw new Error("A highlight note needs its target");
      return (
        await apiFetch<ApiJson<"/highlights/{highlight_id}", "get">>(
          `/api/highlights/${creatingHighlight}`,
          { signal },
        )
      ).data;
    },
  });

  // The note as the server has it, or a new one made by its first non-empty save.
  useEffect(() => {
    if (note)
      adoptText(
        ref,
        { body_pm_json: note.body_pm_json, body_text: note.body_text },
        note.body_version,
      );
    else if (!readText(ref)) createText(ref, emptyBody(), null);
  }, [note, ref]);

  // Freeze the observed empty highlight slot before binding its first save.
  const linksVersion =
    highlight.status === "ready" ? highlight.data.links_version : null;
  useEffect(() => {
    if (
      note ||
      attached ||
      (target.kind === "highlight" && linksVersion === null)
    )
      return;
    const creator: Creator = {
      request: (value: NoteBody) => ({
        path: notePath(target.kind, targetId),
        method: "PUT",
        link_refs: target.kind === "highlight" ? [`highlight:${targetId}`] : [],
        body: {
          note_id: noteId,
          body_pm_json: value.body_pm_json,
          ...(target.kind === "highlight"
            ? { expected: { kind: "absent", version: linksVersion } }
            : {}),
        },
      }),
      settle(reply) {
        // justify-type-assertion: both note routes answer the attached note.
        const saved = reply as AttachedNote;
        reported.current = saved.body_version;
        latest.current.onSaved(targetId, saved);
        return saved;
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
    latest.current.onSaved(targetId, {
      note_block_id: noteId,
      ...value,
      body_version: version,
    });
  }, [attached, noteId, targetId, text, version]);

  const detach = () => {
    setDetaching(true);
    sendWrite(notePath(target.kind, targetId, noteId), "DELETE")
      .then(
        () => {
          publishChange("Notes");
          latest.current.onDetached(targetId, noteId);
        },
        (error: unknown) => {
          if (handleUnauthenticatedApiError(error)) return;
          const title =
            target.kind === "link"
              ? "note wasn’t removed from link"
              : "annotation wasn’t removed";
          const content = (isApiError(error) &&
            apiTransportFeedback(error, title)) || {
            tone: "Danger" as const,
            title,
            message: "Retry, or refresh the reader.",
          };
          feedback.offer({
            key: "annotation-note",
            announcement: "Polite",
            content,
          });
        },
      )
      .finally(() => setDetaching(false));
  };

  if (!text || typeof text.value === "string") return null;
  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <CanonicalNoteEditor
        session={props.session}
        occurrence={{ key: props.occurrenceKey ?? ref, noteRef: ref }}
        continuation={
          target.kind === "highlight"
            ? {
                source: { kind: "resource", ref },
                position: null,
                occurrencePrefix: props.occurrenceKey ?? ref,
                path: [],
              }
            : null
        }
        label={
          props.label ??
          (target.kind === "highlight"
            ? "edit note: annotation"
            : "edit note: note on link")
        }
        editable={editable && textCreationReady(ref)}
        embeddedItem={note?.embedded_item ?? null}
        atomicEmbeds={props.atomicEmbeds}
      />
      {creatingHighlight && highlight.status === "failed" ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "note setup failed",
            message: "your draft is kept",
            requestId: highlight.error.requestId,
          }}
          announcement="Polite"
          actions={[
            {
              label: "retry note setup",
              onClick: highlight.refetch,
              busy: highlight.retrying,
            },
          ]}
        />
      ) : null}
      <div className={styles.actions}>
        <WritingStatus />
        {attached && editable ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={detach}
            disabled={detaching || referencing}
          >
            {target.kind === "link"
              ? "remove note from link"
              : "remove annotation"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
