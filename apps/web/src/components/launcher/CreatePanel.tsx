"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { ArrowLeft } from "lucide-react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { quickCaptureDailyNote, saveNoteBody } from "@/lib/notes/api";
import type { NoteBlock } from "@/lib/notes/normalize";
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
import type { LauncherActionTarget } from "@/lib/launcher/model";
import styles from "./CreatePanel.module.css";

export default function CreatePanel({
  onOpen,
  onClose,
  onBack,
}: {
  onOpen: (target: LauncherActionTarget) => void;
  onClose: () => void;
  onBack: () => void;
}): React.ReactElement {
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const resourceKey = "quick-note:daily";
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const [initialDoc, setInitialDoc] = useState(
    () =>
      readStoredNoteEditorDraft(resourceKey)?.doc ??
      createEmptyOutlineDoc(createRandomId()),
  );
  const editorResourceKey = `${resourceKey}:editor:${editorResetSerial}`;
  const currentDocRef = useRef<ProseMirrorNode | null>(null);
  const persistedBlockRef = useRef<NoteBlock | null>(null);

  const saveDoc = useCallback(
    async (
      doc: ProseMirrorNode,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const block = firstOutlineBlockFromDoc(doc);
      const persisted = persistedBlockRef.current;
      if (!block || (!persisted && !noteBodyHasContent(block))) {
        return;
      }
      if (persisted && !noteBodyHasContent(block)) {
        await saveNoteBody(persisted.id, {
          clientMutationId,
          baseVersion: persisted.versionByLane?.body ?? null,
          bodyPmJson: firstOutlineBlockFromDoc(
            createEmptyOutlineDoc(persisted.id),
          )!.bodyPmJson,
        });
        persistedBlockRef.current = null;
        return;
      }
      persistedBlockRef.current = await quickCaptureDailyNote({
        blockId: persisted?.id ?? block.id,
        clientMutationId,
        bodyPmJson: block.bodyPmJson,
      });
    },
    [],
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveDoc,
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(
        toFeedback(error, { fallback: "Quick note could not be added." }),
      );
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
    [scheduleSessionSave],
  );

  const openToday = useCallback(() => {
    flushSession(currentDocRef.current ?? undefined);
    onOpen({ kind: "open-today" });
    onClose();
  }, [flushSession, onOpen, onClose]);

  const resetToPersistedOrEmpty = useCallback(() => {
    const persisted = persistedBlockRef.current;
    const nextDoc = persisted
      ? createOutlineDocFromBlock({
          id: persisted.id,
          bodyPmJson: persisted.bodyPmJson,
          bodyText: persisted.bodyText,
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
    <div className={styles.panel}>
      <button
        type="button"
        tabIndex={-1}
        className={styles.backHeader}
        onClick={onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        <span>New note</span>
      </button>
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
            onFeedback={setFeedback}
            onError={(error) => {
              if (handleUnauthenticatedApiError(error)) return;
              setFeedback(
                toFeedback(error, {
                  fallback: "Attachment could not be added.",
                }),
              );
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
    </div>
  );
}
