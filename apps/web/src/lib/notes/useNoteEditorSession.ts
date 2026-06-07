"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Node as ProseMirrorNode } from "prosemirror-model";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";

export const NOTE_AUTOSAVE_IDLE_DELAY_MS = 1500;
export const NOTE_AUTOSAVE_MAX_WAIT_MS = 5000;
export const NOTE_LAYOUT_MEASURE_DELAY_MS = 100;
const NOTE_DRAFT_STORAGE_PREFIX = "nexus.noteDraft:";

export type NoteEditorSessionStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "failed";

export interface NoteEditorSaveContext {
  resourceKey: string;
  sequence: number;
  clientMutationId: string;
}

interface UseNoteEditorSessionOptions {
  resourceKey: string;
  save: (doc: ProseMirrorNode, context: NoteEditorSaveContext) => Promise<void>;
  draftMetadata?: () => unknown;
  onError?: (error: unknown) => void;
}

export interface NoteEditorSession {
  status: NoteEditorSessionStatus;
  scheduleSave(doc: ProseMirrorNode): void;
  flush(doc?: ProseMirrorNode): void;
  reset(): void;
}

export interface StoredNoteEditorDraft {
  doc: ProseMirrorNode;
  metadata: unknown;
}

export function useNoteEditorSession({
  resourceKey,
  save,
  draftMetadata,
  onError,
}: UseNoteEditorSessionOptions): NoteEditorSession {
  const [status, setStatus] = useState<NoteEditorSessionStatus>("clean");
  const resourceKeyRef = useRef(resourceKey);
  const saveRef = useRef(save);
  const draftMetadataRef = useRef(draftMetadata);
  const onErrorRef = useRef(onError);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const localSequenceRef = useRef(0);
  const pendingDocRef = useRef<ProseMirrorNode | null>(null);
  const pendingSequenceRef = useRef(0);
  const queuedDocRef = useRef<ProseMirrorNode | null>(null);
  const queuedSequenceRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);
  const startSaveRef = useRef<(doc: ProseMirrorNode, sequence: number) => void>(
    () => undefined
  );
  const flushRef = useRef<(doc?: ProseMirrorNode) => void>(() => undefined);

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

  const setMountedStatus = useCallback((nextStatus: NoteEditorSessionStatus) => {
    if (mountedRef.current) {
      setStatus(nextStatus);
    }
  }, []);

  const startSave = useCallback(
    (doc: ProseMirrorNode, sequence: number) => {
      if (saveInFlightRef.current) {
        queuedDocRef.current = doc;
        queuedSequenceRef.current = sequence;
        return;
      }

      const saveResourceKey = resourceKeyRef.current;
      const saveGeneration = generationRef.current;
      const isStaleSave = () =>
        generationRef.current !== saveGeneration ||
        resourceKeyRef.current !== saveResourceKey;
      const clientMutationId = createClientMutationId(saveResourceKey, sequence);
      saveInFlightRef.current = true;
      setMountedStatus("saving");

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
            setMountedStatus("saved");
            return;
          }

          setMountedStatus("dirty");
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
            setMountedStatus("failed");
            onErrorRef.current?.(error);
            return;
          }

          setMountedStatus("dirty");
        })
        .finally(() => {
          if (isStaleSave()) {
            return;
          }

          saveInFlightRef.current = false;
          const queuedDoc = queuedDocRef.current;
          const queuedSequence = queuedSequenceRef.current;
          queuedDocRef.current = null;
          queuedSequenceRef.current = 0;
          if (queuedDoc) {
            startSaveRef.current(queuedDoc, queuedSequence);
          }
        });
    },
    [setMountedStatus]
  );

  useEffect(() => {
    startSaveRef.current = startSave;
  }, [startSave]);

  const flush = useCallback(
    (doc?: ProseMirrorNode) => {
      if (doc && pendingDocRef.current) {
        pendingDocRef.current = doc;
        storeNoteEditorDraft(resourceKeyRef.current, doc, draftMetadataRef.current?.());
      }
      clearTimers();
      const pendingDoc = pendingDocRef.current;
      const pendingSequence = pendingSequenceRef.current;
      if (!pendingDoc) {
        return;
      }
      pendingDocRef.current = null;
      pendingSequenceRef.current = 0;
      startSave(pendingDoc, pendingSequence);
    },
    [clearTimers, startSave]
  );

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const scheduleSave = useCallback(
    (doc: ProseMirrorNode) => {
      const nextSequence = localSequenceRef.current + 1;
      localSequenceRef.current = nextSequence;
      pendingDocRef.current = doc;
      pendingSequenceRef.current = nextSequence;
      storeNoteEditorDraft(resourceKeyRef.current, doc, draftMetadataRef.current?.());
      setMountedStatus("dirty");

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
    [setMountedStatus]
  );

  const reset = useCallback(
    () => {
      generationRef.current += 1;
      localSequenceRef.current = 0;
      pendingDocRef.current = null;
      pendingSequenceRef.current = 0;
      queuedDocRef.current = null;
      queuedSequenceRef.current = 0;
      saveInFlightRef.current = false;
      clearTimers();
      setMountedStatus("clean");
    },
    [clearTimers, setMountedStatus]
  );

  useEffect(() => {
    reset();
  }, [resourceKey, reset]);

  useEffect(() => {
    mountedRef.current = true;

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
      mountedRef.current = false;
      window.removeEventListener("pagehide", flushForPageLifecycle);
      document.removeEventListener("visibilitychange", flushForHiddenDocument);
    };
  }, [clearTimers]);

  return { status, scheduleSave, flush, reset };
}

function createClientMutationId(resourceKey: string, sequence: number): string {
  return `${resourceKey}:${sequence}:${createRandomId()}`;
}

export function readStoredNoteEditorDraft(resourceKey: string): StoredNoteEditorDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(`${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`);
  if (!raw) {
    return null;
  }
  try {
    const draft = JSON.parse(raw) as { doc?: unknown; metadata?: unknown };
    if (typeof draft !== "object" || draft === null || draft.doc === undefined) {
      window.localStorage.removeItem(`${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`);
      return null;
    }
    return {
      doc: ProseMirrorNode.fromJSON(outlineSchema, draft.doc),
      metadata: draft.metadata,
    };
  } catch {
    window.localStorage.removeItem(`${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`);
    return null;
  }
}

function storeNoteEditorDraft(
  resourceKey: string,
  doc: ProseMirrorNode,
  metadata: unknown
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      `${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`,
      JSON.stringify({ doc: doc.toJSON(), metadata })
    );
  } catch {
    // Storage can be unavailable or full; autosave still continues through the network path.
  }
}

export function clearStoredNoteEditorDraft(resourceKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(`${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`);
  } catch {
    // Nothing useful to do if the browser refuses storage access.
  }
}
