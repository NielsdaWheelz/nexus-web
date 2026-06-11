"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchNotePage,
  quickCaptureDailyNote,
  saveNotePageDocument,
  type NoteBlock,
} from "@/lib/notes/api";
import { planNoteBlockDeletion } from "@/lib/notes/pageDocumentPersistence";
import { createRandomId } from "@/lib/createRandomId";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import {
  createEmptyOutlineDoc,
  createOutlineDocFromBlock,
  firstOutlineBlockFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
} from "@/lib/notes/useNoteEditorSession";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import Button from "@/components/ui/Button";
import styles from "./AddContentTray.module.css";

export default function QuickNotePanel({ onClose }: { onClose: () => void }) {
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const resourceKey = "quick-note:daily";
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const [initialDoc, setInitialDoc] = useState(
    () => readStoredNoteEditorDraft(resourceKey)?.doc ?? createEmptyOutlineDoc(createRandomId())
  );
  const editorResourceKey = `${resourceKey}:editor:${editorResetSerial}`;
  const currentDocRef = useRef<ProseMirrorNode | null>(null);
  const persistedBlockRef = useRef<NoteBlock | null>(null);

  const saveDoc = useCallback(
    async (
      doc: ProseMirrorNode,
      { clientMutationId }: { clientMutationId: string }
    ) => {
      const block = firstOutlineBlockFromDoc(doc);
      const persisted = persistedBlockRef.current;
      if (!block || (!persisted && !noteBodyHasContent(block))) {
        return;
      }
      if (persisted && !noteBodyHasContent(block)) {
        const page = await fetchNotePage(persisted.pageId);
        const plan = planNoteBlockDeletion(page, persisted.id);
        if (plan !== null) {
          await saveNotePageDocument(page.id, {
            clientMutationId,
            baseDocumentVersion: page.documentVersion,
            focusBlockId: null,
            blocks: plan.blocks,
            containment: plan.containment,
            deletedBlockIds: plan.deletedBlockIds,
          });
        }
        persistedBlockRef.current = null;
        return;
      }
      persistedBlockRef.current = await quickCaptureDailyNote({
        blockId: persisted?.id ?? block.id,
        clientMutationId,
        bodyPmJson: block.bodyPmJson,
      });
    },
    []
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveDoc,
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Quick note could not be added." }));
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
    const storedDraft = readStoredNoteEditorDraft(resourceKey);
    if (storedDraft) {
      recoverSessionDraft(storedDraft);
    }
  }, [recoverSessionDraft]);

  const scheduleSave = useCallback(
    (doc: ProseMirrorNode) => {
      currentDocRef.current = doc;
      setFeedback(null);
      scheduleSessionSave(doc);
    },
    [scheduleSessionSave]
  );

  const openToday = useCallback(() => {
    flushSession(currentDocRef.current ?? undefined);
    onClose();
    requestOpenInAppPane("/daily", { titleHint: "Today" });
  }, [flushSession, onClose]);

  const resetToPersistedOrEmpty = useCallback(() => {
    const persisted = persistedBlockRef.current;
    const nextDoc = persisted
      ? createOutlineDocFromBlock({
          id: persisted.id,
          bodyPmJson: persisted.bodyPmJson,
          bodyText: persisted.bodyText,
          blockKind: persisted.blockKind,
          collapsed: persisted.collapsed,
        })
      : createEmptyOutlineDoc(createRandomId());
    currentDocRef.current = nextDoc;
    setInitialDoc(nextDoc);
    setEditorResetSerial((current) => current + 1);
  }, []);

  const discardRecoveredDraft = useCallback(() => {
    discardSessionDraft();
    setFeedback(null);
    resetToPersistedOrEmpty();
  }, [discardSessionDraft, resetToPersistedOrEmpty]);

  return (
    <>
      <div className={styles.quickNoteForm}>
        <div className={styles.quickNoteEditor}>
          <ProseMirrorOutlineEditor
            resourceKey={editorResourceKey}
            initialDoc={initialDoc}
            ariaLabel="Quick note to today"
            createBlockId={createRandomId}
            singleBlock
            compact
            onDocChange={scheduleSave}
            onBlurFlush={flushSession}
            onError={(error) => {
              if (handleUnauthenticatedApiError(error)) return;
              setFeedback(toFeedback(error, { fallback: "Attachment could not be added." }));
            }}
          />
        </div>
        <NoteDraftRecovery
          status={saveStatus}
          hasRecoveredDraft={hasRecoveredDraft}
          onRetry={retrySession}
          onDiscard={discardRecoveredDraft}
        />
        <div className={styles.quickNoteActions}>
          <Button variant="secondary" size="md" onClick={openToday}>
            Open today
          </Button>
        </div>
      </div>
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </>
  );
}
