"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import {
  createOutlineDocFromBlock,
  firstOutlineBlockFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
} from "@/lib/notes/useNoteEditorSession";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
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
    clientMutationId: string
  ) => Promise<HighlightLinkedNoteBlock>;
  onDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean
  ) => Promise<void>;
  onLocalChange?: () => void;
  onOpenLink: (href: string, options: { newPane: boolean }) => void;
}) {
  const feedback = useFeedback();
  const editVersionRef = useRef(0);
  const persistedBlockIdRef = useRef<string | null>(note?.note_block_id ?? null);
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

  const persistedDoc = useMemo(
    () =>
      createOutlineDocFromBlock({
        id: note?.note_block_id ?? draftBlockId,
        bodyPmJson: note?.body_pm_json ?? null,
        bodyText: note?.body_text ?? "",
      }),
    [draftBlockId, note?.body_pm_json, note?.body_text, note?.note_block_id]
  );
  const [initialDoc, setInitialDoc] = useState(
    () => readStoredNoteEditorDraft(resourceKey)?.doc ?? persistedDoc
  );

  const saveDoc = useCallback(
    async (
      nextDoc: ProseMirrorNode,
      { clientMutationId }: { clientMutationId: string }
    ) => {
      const saveResourceKey = resourceKey;
      const saveEditVersion = editVersionRef.current;
      const block = firstOutlineBlockFromDoc(nextDoc);
      if (!block) return;

      const persistedBlockId = persistedBlockIdRef.current;
      if (noteBodyHasContent(block)) {
        const savedBlock = await onSave(
          highlightId,
          persistedBlockId,
          block.id,
          block.bodyPmJson,
          clientMutationId
        );
        if (currentResourceKeyRef.current === saveResourceKey) {
          persistedBlockIdRef.current =
            savedBlock?.note_block_id ?? persistedBlockId ?? block.id;
        }
        return;
      }

      if (persistedBlockId) {
        const shouldApply = () =>
          currentResourceKeyRef.current === saveResourceKey &&
          editVersionRef.current === saveEditVersion;
        await onDelete(highlightId, persistedBlockId, clientMutationId, shouldApply);
        if (shouldApply()) {
          persistedBlockIdRef.current = null;
        }
      }
    },
    [highlightId, onDelete, onSave, resourceKey]
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveDoc,
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
    setInitialDoc(storedDraft?.doc ?? persistedDoc);
    if (!isInitialLoad) {
      setEditorResetSerial((current) => current + 1);
    }
    if (storedDraft) {
      recoverSessionDraft(storedDraft);
    }
  }, [persistedDoc, recoverSessionDraft, resourceKey]);

  const scheduleSave = useCallback(
    (nextDoc: ProseMirrorNode) => {
      editVersionRef.current += 1;
      onLocalChange?.();
      scheduleSessionSave(nextDoc);
    },
    [onLocalChange, scheduleSessionSave]
  );

  const discardRecoveredDraft = useCallback(() => {
    discardSessionDraft();
    setInitialDoc(persistedDoc);
    setEditorResetSerial((current) => current + 1);
  }, [discardSessionDraft, persistedDoc]);

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      onOpenLink(`/notes/${blockId}`, { newPane: openInNewPane });
    },
    [onOpenLink]
  );

  const openObject = useCallback(
    async (objectType: string, objectId: string, openInNewPane: boolean) => {
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
        feedback.show(toFeedback(error, { fallback: "Linked object could not be opened." }));
        return;
      }
      if (!href) return;
      onOpenLink(href, { newPane: openInNewPane });
    },
    [feedback, onOpenLink]
  );

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <ProseMirrorOutlineEditor
        resourceKey={editorResourceKey}
        initialDoc={initialDoc}
        editable={editable}
        ariaLabel="Highlight note"
        createBlockId={createRandomId}
        singleBlock
        compact
        onDocChange={editable ? scheduleSave : undefined}
        onBlurFlush={flushSession}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
        onError={(error) => {
          if (handleUnauthenticatedApiError(error)) return;
          feedback.show(toFeedback(error, { fallback: "Attachment could not be added." }));
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
