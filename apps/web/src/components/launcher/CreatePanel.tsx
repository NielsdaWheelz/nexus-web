"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { quickCaptureDailyNote, saveNoteBody } from "@/lib/notes/api";
import type { NoteContent } from "@/lib/notes/normalize";
import { createRandomId } from "@/lib/createRandomId";
import NoteBodyEditor from "@/components/notes/NoteBodyEditor";
import {
  emptyNoteBody,
  type NoteBodyValue,
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
import { isRecord } from "@/lib/validation";
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
  const [initialBody, setInitialBody] = useState(
    () =>
      readStoredNoteEditorDraft(resourceKey)?.body ?? emptyNoteBody(),
  );
  const editorResourceKey = `${resourceKey}:editor:${editorResetSerial}`;
  const currentBodyRef = useRef<NoteBodyValue | null>(null);
  const persistedBlockRef = useRef<NoteContent | null>(null);
  const draftBlockIdRef = useRef(createRandomId());

  const saveBody = useCallback(
    async (
      body: NoteBodyValue,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const persisted = persistedBlockRef.current;
      if (!persisted && !noteBodyHasContent(body)) {
        return;
      }
      if (persisted && !noteBodyHasContent(body)) {
        await saveNoteBody(persisted.id, {
          clientMutationId,
          baseVersion: persisted.versionByLane?.body ?? null,
          bodyPmJson: emptyNoteBody().bodyPmJson,
        });
        persistedBlockRef.current = null;
        return;
      }
      persistedBlockRef.current = await quickCaptureDailyNote({
        blockId: persisted?.id ?? draftBlockIdRef.current,
        clientMutationId,
        bodyPmJson: body.bodyPmJson,
      });
    },
    [],
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveBody,
    draftMetadata: () => ({ blockId: draftBlockIdRef.current }),
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
      if (
        isRecord(storedDraft.metadata) &&
        typeof storedDraft.metadata.blockId === "string"
      ) {
        draftBlockIdRef.current = storedDraft.metadata.blockId;
      }
      recoverSessionDraft(storedDraft);
    }
  }, [recoverSessionDraft]);

  const scheduleSave = useCallback(
    (body: NoteBodyValue) => {
      currentBodyRef.current = body;
      setFeedback(null);
      scheduleSessionSave(body);
    },
    [scheduleSessionSave],
  );

  const openToday = useCallback(() => {
    flushSession(currentBodyRef.current ?? undefined);
    onOpen({ kind: "open-today" });
    onClose();
  }, [flushSession, onOpen, onClose]);

  const resetToPersistedOrEmpty = useCallback(() => {
    const persisted = persistedBlockRef.current;
    const nextBody = persisted
      ? {
          bodyPmJson: persisted.bodyPmJson,
          bodyText: persisted.bodyText,
        }
      : emptyNoteBody();
    currentBodyRef.current = nextBody;
    draftBlockIdRef.current = persisted?.id ?? createRandomId();
    setInitialBody(nextBody);
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
          <NoteBodyEditor
            resourceKey={editorResourceKey}
            initialBodyPmJson={initialBody.bodyPmJson}
            fallbackBodyText={initialBody.bodyText}
            ariaLabel="Quick note to today"
            compact
            onBodyChange={scheduleSave}
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
