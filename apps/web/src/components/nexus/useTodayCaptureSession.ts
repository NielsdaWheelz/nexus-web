"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { toFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { quickCaptureDailyNote, saveNoteBody } from "@/lib/notes/api";
import type { NoteContent } from "@/lib/notes/normalize";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  emptyNoteBody,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
  type NoteEditorSessionStatus,
} from "@/lib/notes/useNoteEditorSession";
import type { DismissDecision } from "@/lib/ui/useHistoryDismiss";
import { isRecord } from "@/lib/validation";

export const TODAY_CAPTURE_RESOURCE_KEY = "quick-note:daily";

export interface TodayCaptureSessionController {
  readonly sessionId: string;
  readonly resourceKey: string;
  readonly editorResourceKey: string;
  readonly initialBody: NoteBodyValue;
  readonly committedReplayId: string | null;
  readonly feedback: FeedbackContent | null;
  readonly saveStatus: NoteEditorSessionStatus;
  readonly hasRecoveredDraft: boolean;
  start(): string;
  scheduleSave(body: NoteBodyValue): void;
  flush(body?: NoteBodyValue): void;
  retry(): void;
  discardDraft(): void;
  setFeedback(feedback: FeedbackContent | null): void;
  checkpointForDismissal(): DismissDecision;
}

/**
 * Shell-owned Today capture session. It stays mounted with Nexus so a
 * mobile/desktop projection change cannot rotate the block identity, discard a
 * recovered draft, or terminate an in-flight save.
 */
export function useTodayCaptureSession(): TodayCaptureSessionController {
  const resourceKey = TODAY_CAPTURE_RESOURCE_KEY;
  const [sessionId, setSessionId] = useState(
    () => createRandomId("today-capture"),
  );
  const [committedReplayId, setCommittedReplayId] =
    useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [checkpointFailed, setCheckpointFailed] = useState(false);
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const [initialBody, setInitialBody] = useState(
    () => readStoredNoteEditorDraft(resourceKey)?.body ?? emptyNoteBody(),
  );
  const currentBodyRef = useRef<NoteBodyValue | null>(initialBody);
  const persistedBlockRef = useRef<NoteContent | null>(null);
  const draftBlockIdRef = useRef(createRandomId());

  const saveBody = useCallback(
    async (
      body: NoteBodyValue,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const persisted = persistedBlockRef.current;
      if (!persisted && !noteBodyHasContent(body)) return;
      if (persisted && !noteBodyHasContent(body)) {
        await saveNoteBody(persisted.id, {
          clientMutationId,
          baseVersion: persisted.versionByLane?.body ?? null,
          bodyPmJson: emptyNoteBody().bodyPmJson,
        });
        persistedBlockRef.current = null;
        setCommittedReplayId(null);
        return;
      }
      const saved = await quickCaptureDailyNote({
        blockId: persisted?.id ?? draftBlockIdRef.current,
        clientMutationId,
        bodyPmJson: body.bodyPmJson,
      });
      persistedBlockRef.current = saved;
      setCommittedReplayId(saved.id);
    },
    [],
  );

  const {
    status: editorStatus,
    hasRecoveredDraft,
    scheduleSave: scheduleEditorSave,
    flush: flushEditor,
    recoverDraft,
    retry: retryEditorSave,
    discardDraft: discardEditorDraft,
    reset: resetEditor,
  } = useNoteEditorSession({
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

  useEffect(() => {
    const storedDraft = readStoredNoteEditorDraft(resourceKey);
    if (!storedDraft) return;
    if (
      isRecord(storedDraft.metadata) &&
      typeof storedDraft.metadata.blockId === "string"
    ) {
      draftBlockIdRef.current = storedDraft.metadata.blockId;
    }
    currentBodyRef.current = storedDraft.body;
    recoverDraft(storedDraft);
  }, [recoverDraft, resourceKey]);

  const scheduleSave = useCallback(
    (body: NoteBodyValue) => {
      currentBodyRef.current = body;
      setInitialBody(body);
      setFeedback(null);
      setCheckpointFailed(false);
      scheduleEditorSave(body);
    },
    [scheduleEditorSave],
  );

  const flush = useCallback(
    (body?: NoteBodyValue) => {
      if (body) {
        currentBodyRef.current = body;
        setInitialBody(body);
      }
      flushEditor(body ?? currentBodyRef.current ?? undefined);
    },
    [flushEditor],
  );

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

  const discardDraft = useCallback(() => {
    discardEditorDraft();
    setFeedback(null);
    setCheckpointFailed(false);
    resetToPersistedOrEmpty();
  }, [discardEditorDraft, resetToPersistedOrEmpty]);

  const retry = useCallback(() => {
    setCheckpointFailed(false);
    retryEditorSave();
  }, [retryEditorSave]);

  const start = useCallback((): string => {
    const recoverableDraft = readStoredNoteEditorDraft(resourceKey);
    if (
      recoverableDraft !== null ||
      editorStatus === "dirty" ||
      editorStatus === "saving" ||
      editorStatus === "recovered" ||
      editorStatus === "failed"
    ) {
      return sessionId;
    }
    if (persistedBlockRef.current === null) {
      return sessionId;
    }

    resetEditor();
    persistedBlockRef.current = null;
    currentBodyRef.current = emptyNoteBody();
    draftBlockIdRef.current = createRandomId();
    setCommittedReplayId(null);
    setFeedback(null);
    setCheckpointFailed(false);
    setInitialBody(emptyNoteBody());
    setEditorResetSerial((current) => current + 1);
    const nextSessionId = createRandomId("today-capture");
    setSessionId(nextSessionId);
    return nextSessionId;
  }, [editorStatus, resetEditor, resourceKey, sessionId]);

  const checkpointForDismissal = useCallback((): DismissDecision => {
    const body = currentBodyRef.current;
    flush(body ?? undefined);
    if (!body || !noteBodyHasContent(body)) return "accepted";
    if (
      editorStatus === "clean" ||
      editorStatus === "saved" ||
      readStoredNoteEditorDraft(resourceKey) !== null
    ) {
      return "accepted";
    }
    setCheckpointFailed(true);
    setFeedback({
      severity: "error",
      title: "Quick note could not be saved for recovery.",
    });
    return "blocked";
  }, [editorStatus, flush, resourceKey]);

  return {
    sessionId,
    resourceKey,
    editorResourceKey: `${resourceKey}:editor:${editorResetSerial}`,
    initialBody,
    committedReplayId,
    feedback,
    saveStatus: checkpointFailed ? "failed" : editorStatus,
    hasRecoveredDraft,
    start,
    scheduleSave,
    flush,
    retry,
    discardDraft,
    setFeedback,
    checkpointForDismissal,
  };
}
