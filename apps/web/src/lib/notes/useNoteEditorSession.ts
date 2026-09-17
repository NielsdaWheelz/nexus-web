"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import {
  clearStoredNoteEditorDraft,
  createNoteEditorClientMutationId,
  storeNoteEditorDraft,
  type StoredNoteEditorDraft,
} from "@/lib/notes/noteEditorDraftStore";

const NOTE_AUTOSAVE_IDLE_DELAY_MS = 1500;
const NOTE_AUTOSAVE_MAX_WAIT_MS = 5000;

export type NoteEditorSessionStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "recovered"
  | "failed";

export interface NoteEditorSaveContext {
  resourceKey: string;
  sequence: number;
  clientMutationId: string;
}

interface UseNoteEditorSessionOptions {
  resourceKey: string;
  save: (body: NoteBodyValue, context: NoteEditorSaveContext) => Promise<void>;
  draftMetadata?: () => unknown;
  onError?: (error: unknown) => void;
}

export interface NoteEditorSession {
  status: NoteEditorSessionStatus;
  hasRecoveredDraft: boolean;
  scheduleSave(body: NoteBodyValue): void;
  flush(body?: NoteBodyValue): void;
  recoverDraft(draft: StoredNoteEditorDraft): void;
  discardDraft(): void;
  reset(): void;
}

export function useNoteEditorSession({
  resourceKey,
  save,
  draftMetadata,
  onError,
}: UseNoteEditorSessionOptions): NoteEditorSession {
  const [status, setStatus] = useState<NoteEditorSessionStatus>("clean");
  const [hasRecoveredDraft, setHasRecoveredDraft] = useState(false);
  const resourceKeyRef = useRef(resourceKey);
  const saveRef = useRef(save);
  const draftMetadataRef = useRef(draftMetadata);
  const onErrorRef = useRef(onError);
  const generationRef = useRef(0);
  const localSequenceRef = useRef(0);
  const pendingDocRef = useRef<NoteBodyValue | null>(null);
  const pendingSequenceRef = useRef(0);
  const pendingClientMutationIdRef = useRef<string | null>(null);
  const queuedDocRef = useRef<NoteBodyValue | null>(null);
  const queuedSequenceRef = useRef(0);
  const queuedClientMutationIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);
  const startSaveRef = useRef<(
    body: NoteBodyValue,
    sequence: number,
    clientMutationId: string
  ) => void>(() => undefined);
  const flushRef = useRef<(body?: NoteBodyValue) => void>(() => undefined);

  useEffect(() => {
    resourceKeyRef.current = resourceKey;
  }, [resourceKey]);

  useEffect(() => {
    saveRef.current = save;
    draftMetadataRef.current = draftMetadata;
    onErrorRef.current = onError;
  }, [draftMetadata, onError, save]);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (maxWaitTimerRef.current !== null) {
      window.clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = null;
    }
  }, []);

  const startSave = useCallback(
    (
      doc: NoteBodyValue,
      sequence: number,
      clientMutationId: string
    ) => {
      if (saveInFlightRef.current) {
        queuedDocRef.current = doc;
        queuedSequenceRef.current = sequence;
        queuedClientMutationIdRef.current = clientMutationId;
        return;
      }

      const saveResourceKey = resourceKeyRef.current;
      const saveGeneration = generationRef.current;
      const isStaleSave = () =>
        generationRef.current !== saveGeneration ||
        resourceKeyRef.current !== saveResourceKey;
      saveInFlightRef.current = true;
      setHasRecoveredDraft(false);
      setStatus("saving");

      void saveRef
        .current(doc, {
          resourceKey: saveResourceKey,
          sequence,
          clientMutationId,
        })
        .then(() => {
          if (isStaleSave()) {
            return;
          }

          const isLatestSequence = sequence === localSequenceRef.current;
          const hasQueuedWork =
            pendingDocRef.current !== null || queuedDocRef.current !== null;

          if (isLatestSequence && !hasQueuedWork) {
            clearStoredNoteEditorDraft(saveResourceKey);
            setHasRecoveredDraft(false);
            setStatus("saved");
            return;
          }

          setStatus("dirty");
        })
        .catch((error: unknown) => {
          if (isStaleSave()) {
            return;
          }

          const isLatestSequence = sequence === localSequenceRef.current;
          const hasQueuedWork =
            pendingDocRef.current !== null || queuedDocRef.current !== null;
          if (handleUnauthenticatedApiError(error)) {
            return;
          }
          if (isLatestSequence && !hasQueuedWork) {
            pendingDocRef.current = doc;
            pendingSequenceRef.current = sequence;
            pendingClientMutationIdRef.current = clientMutationId;
            storeNoteEditorDraft(
              saveResourceKey,
              doc,
              draftMetadataRef.current?.(),
              sequence,
              clientMutationId
            );
            setStatus("failed");
            onErrorRef.current?.(error);
            return;
          }

          setStatus("dirty");
        })
        .finally(() => {
          if (isStaleSave()) {
            return;
          }

          saveInFlightRef.current = false;
          const queuedDoc = queuedDocRef.current;
          const queuedSequence = queuedSequenceRef.current;
          const queuedClientMutationId = queuedClientMutationIdRef.current;
          queuedDocRef.current = null;
          queuedSequenceRef.current = 0;
          queuedClientMutationIdRef.current = null;
          if (queuedDoc && queuedClientMutationId) {
            startSaveRef.current(queuedDoc, queuedSequence, queuedClientMutationId);
          }
        });
    },
    []
  );

  useEffect(() => {
    startSaveRef.current = startSave;
  }, [startSave]);

  const flush = useCallback(
    (doc?: NoteBodyValue) => {
      if (doc && pendingDocRef.current) {
        const clientMutationId =
          pendingClientMutationIdRef.current ??
          createNoteEditorClientMutationId(pendingSequenceRef.current);
        pendingDocRef.current = doc;
        pendingClientMutationIdRef.current = clientMutationId;
        storeNoteEditorDraft(
          resourceKeyRef.current,
          doc,
          draftMetadataRef.current?.(),
          pendingSequenceRef.current,
          clientMutationId
        );
      }
      clearTimers();
      const pendingDoc = pendingDocRef.current;
      const pendingSequence = pendingSequenceRef.current;
      const pendingClientMutationId = pendingClientMutationIdRef.current;
      if (!pendingDoc || !pendingClientMutationId) {
        return;
      }
      pendingDocRef.current = null;
      pendingSequenceRef.current = 0;
      pendingClientMutationIdRef.current = null;
      startSave(pendingDoc, pendingSequence, pendingClientMutationId);
    },
    [clearTimers, startSave]
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const scheduleSave = useCallback(
    (doc: NoteBodyValue) => {
      const nextSequence = localSequenceRef.current + 1;
      const clientMutationId = createNoteEditorClientMutationId(nextSequence);
      localSequenceRef.current = nextSequence;
      pendingDocRef.current = doc;
      pendingSequenceRef.current = nextSequence;
      pendingClientMutationIdRef.current = clientMutationId;
      storeNoteEditorDraft(
        resourceKeyRef.current,
        doc,
        draftMetadataRef.current?.(),
        nextSequence,
        clientMutationId
      );
      setHasRecoveredDraft(false);
      setStatus("dirty");

      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        flushRef.current();
      }, NOTE_AUTOSAVE_IDLE_DELAY_MS);

      if (maxWaitTimerRef.current === null) {
        maxWaitTimerRef.current = window.setTimeout(() => {
          flushRef.current();
        }, NOTE_AUTOSAVE_MAX_WAIT_MS);
      }
    },
    []
  );

  const recoverDraft = useCallback(
    (draft: StoredNoteEditorDraft) => {
      generationRef.current += 1;
      clearTimers();
      localSequenceRef.current = Math.max(localSequenceRef.current, draft.sequence);
      pendingDocRef.current = draft.body;
      pendingSequenceRef.current = draft.sequence;
      pendingClientMutationIdRef.current = draft.clientMutationId;
      queuedDocRef.current = null;
      queuedSequenceRef.current = 0;
      queuedClientMutationIdRef.current = null;
      saveInFlightRef.current = false;
      setHasRecoveredDraft(true);
      setStatus("recovered");
    },
    [clearTimers]
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    localSequenceRef.current = 0;
    pendingDocRef.current = null;
    pendingSequenceRef.current = 0;
    pendingClientMutationIdRef.current = null;
    queuedDocRef.current = null;
    queuedSequenceRef.current = 0;
    queuedClientMutationIdRef.current = null;
    saveInFlightRef.current = false;
    clearTimers();
    setHasRecoveredDraft(false);
    setStatus("clean");
  }, [clearTimers]);

  const discardDraft = useCallback(() => {
    reset();
    clearStoredNoteEditorDraft(resourceKeyRef.current);
  }, [reset]);

  useEffect(() => {
    reset();
  }, [resourceKey, reset]);

  useEffect(() => {
    function flushForPageLifecycle() {
      flushRef.current();
    }

    function flushForHiddenDocument() {
      if (document.visibilityState === "hidden") {
        flushRef.current();
      }
    }

    window.addEventListener("pagehide", flushForPageLifecycle);
    document.addEventListener("visibilitychange", flushForHiddenDocument);

    return () => {
      flushRef.current();
      clearTimers();
      window.removeEventListener("pagehide", flushForPageLifecycle);
      document.removeEventListener("visibilitychange", flushForHiddenDocument);
    };
  }, [clearTimers]);

  return {
    status,
    hasRecoveredDraft,
    scheduleSave,
    flush,
    recoverDraft,
    discardDraft,
    reset,
  };
}
