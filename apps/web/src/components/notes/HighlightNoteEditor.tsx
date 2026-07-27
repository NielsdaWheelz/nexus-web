"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import { emptyNoteBody, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
} from "@/lib/notes/useNoteEditorSession";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import NoteBodyEditor from "@/components/notes/NoteBodyEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { isRecord } from "@/lib/validation";
import styles from "./HighlightNoteEditor.module.css";

export default function HighlightNoteEditor({
  highlightId,
  note,
  editable,
  onSave,
  onDelete,
  onLocalChange,
  onOpenLink,
}: {
  highlightId: string;
  note: HighlightLinkedNoteBlock | null;
  editable: boolean;
  onSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string,
  ) => Promise<HighlightLinkedNoteBlock>;
  onDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean,
  ) => Promise<void>;
  onLocalChange?: () => void;
  onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}) {
  const feedback = useFeedback();
  const editVersionRef = useRef(0);
  const persistedBlockIdRef = useRef<string | null>(
    note?.note_block_id ?? null,
  );
  const draftBlockRef = useRef({
    highlightId,
    blockId: note?.note_block_id ?? createRandomId(),
  });

  const noteBlockId = note?.note_block_id ?? null;
  if (
    draftBlockRef.current.highlightId !== highlightId ||
    (noteBlockId !== null && noteBlockId !== draftBlockRef.current.blockId)
  ) {
    draftBlockRef.current = {
      highlightId,
      blockId: noteBlockId ?? createRandomId(),
    };
  }
  const draftBlockId = draftBlockRef.current.blockId;
  const resourceKey = `highlight:${highlightId}:${draftBlockId}`;
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const editorResourceKey = `${resourceKey}:editor:${editorResetSerial}`;
  const currentResourceKeyRef = useRef(resourceKey);
  const loadedResourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    currentResourceKeyRef.current = resourceKey;
  }, [resourceKey]);

  useEffect(() => {
    if (
      noteBlockId &&
      noteBlockId !== persistedBlockIdRef.current &&
      noteBlockId === draftBlockId
    ) {
      persistedBlockIdRef.current = noteBlockId;
    }
  }, [draftBlockId, noteBlockId]);

  const persistedBody = useMemo<NoteBodyValue>(
    () => ({
      bodyPmJson: note?.body_pm_json ?? emptyNoteBody().bodyPmJson,
      bodyText: note?.body_text ?? "",
    }),
    [note?.body_pm_json, note?.body_text],
  );
  const [initialBody, setInitialBody] = useState(
    () => readStoredNoteEditorDraft(resourceKey)?.body ?? persistedBody,
  );

  const saveBody = useCallback(
    async (
      body: NoteBodyValue,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const saveResourceKey = resourceKey;
      const saveEditVersion = editVersionRef.current;

      const persistedBlockId = persistedBlockIdRef.current;
      if (noteBodyHasContent(body)) {
        const savedBlock = await onSave(
          highlightId,
          persistedBlockId,
          draftBlockId,
          body.bodyPmJson,
          clientMutationId,
        );
        if (currentResourceKeyRef.current === saveResourceKey) {
          persistedBlockIdRef.current =
            savedBlock?.note_block_id ?? persistedBlockId ?? draftBlockId;
        }
        return;
      }

      if (persistedBlockId) {
        const shouldApply = () =>
          currentResourceKeyRef.current === saveResourceKey &&
          editVersionRef.current === saveEditVersion;
        await onDelete(
          highlightId,
          persistedBlockId,
          clientMutationId,
          shouldApply,
        );
        if (shouldApply()) {
          persistedBlockIdRef.current = null;
        }
      }
    },
    [draftBlockId, highlightId, onDelete, onSave, resourceKey],
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveBody,
    draftMetadata: () => ({ blockId: draftBlockId }),
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Failed to save note" }));
    },
  });
  const {
    status: saveStatus,
    hasRecoveredDraft,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    recoverDraft: recoverSessionDraft,
    retry: retrySession,
    discardDraft: discardSessionDraft,
  } = session;

  useEffect(() => {
    if (loadedResourceKeyRef.current === resourceKey) {
      return;
    }
    const isInitialLoad = loadedResourceKeyRef.current === null;
    loadedResourceKeyRef.current = resourceKey;
    const storedDraft = readStoredNoteEditorDraft(resourceKey);
    if (
      !noteBlockId &&
      storedDraft &&
      isRecord(storedDraft.metadata) &&
      typeof storedDraft.metadata.blockId === "string"
    ) {
      draftBlockRef.current.blockId = storedDraft.metadata.blockId;
    }
    setInitialBody(storedDraft?.body ?? persistedBody);
    if (!isInitialLoad) {
      setEditorResetSerial((current) => current + 1);
    }
    if (storedDraft) {
      recoverSessionDraft(storedDraft);
    }
  }, [noteBlockId, persistedBody, recoverSessionDraft, resourceKey]);

  const scheduleSave = useCallback(
    (body: NoteBodyValue) => {
      editVersionRef.current += 1;
      onLocalChange?.();
      scheduleSessionSave(body);
    },
    [onLocalChange, scheduleSessionSave],
  );

  const discardRecoveredDraft = useCallback(() => {
    discardSessionDraft();
    setInitialBody(persistedBody);
    setEditorResetSerial((current) => current + 1);
  }, [discardSessionDraft, persistedBody]);

  const openObject = useCallback(
    async (objectType: string, objectId: string, disposition: WorkspaceTargetDisposition) => {
      const ref = `${objectType}:${objectId}`;
      if (!parseResourceRef(ref)) return;
      let href: string | null = null;
      try {
        const [resolved] = await resolveResourceLocators([
          { kind: "resource_ref", ref },
        ]);
        href = resolved?.resourceItem.route ?? null;
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        feedback.show(
          toFeedback(error, { fallback: "Linked object could not be opened." }),
        );
        return;
      }
      if (!href) return;
      onOpenLink(href, disposition);
    },
    [feedback, onOpenLink],
  );

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <NoteBodyEditor
        resourceKey={editorResourceKey}
        initialBodyPmJson={initialBody.bodyPmJson}
        fallbackBodyText={initialBody.bodyText}
        editable={editable}
        ariaLabel="Highlight note"
        compact
        onBodyChange={editable ? scheduleSave : undefined}
        onBlurFlush={flushSession}
        onOpenObject={openObject}
        onFeedback={feedback.show}
        onError={(error) => {
          if (handleUnauthenticatedApiError(error)) return;
          feedback.show(
            toFeedback(error, { fallback: "Attachment could not be added." }),
          );
        }}
      />
      <NoteDraftRecovery
        status={saveStatus}
        hasRecoveredDraft={hasRecoveredDraft}
        onRetry={retrySession}
        onDiscard={discardRecoveredDraft}
      />
    </div>
  );
}
