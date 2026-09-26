"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NoteBodyEdit, NoteBodySelection } from "@/components/notes/NoteBodyEditor";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import type { NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import {
  getWritingSession,
  type BodyAdapter,
  type RecoveryCandidate,
  type OperationCallbacks,
  type PendingBodyIdentity,
  type WritingSnapshot,
  type WritingStatus,
} from "@/lib/notes/writingSession";

export type NoteEditorSessionStatus = WritingStatus;

export interface UseNoteEditorSessionOptions {
  accountId: string;
  noteRef: string;
  ownerKey: string;
  initial: { body: NoteBodyValue; version: number | null };
  adapter: BodyAdapter | null;
  awaitExternalCreation?: boolean;
  onError?: (error: unknown) => void;
  onMutationStarted?: () => MountedEditorMutationLease | null;
}

export interface NoteEditorSession extends WritingSnapshot {
  edit(edit: NoteBodyEdit): boolean;
  selection(selection: NoteBodySelection): void;
  boundary(): void;
  undo(): NoteBodySelection | null;
  redo(): NoteBodySelection | null;
  flush(): void;
  retry(): void;
  recoveryCandidates(): RecoveryCandidate[];
  recover(candidate: RecoveryCandidate): boolean;
  discard(): boolean;
  exportRaw(key: string): string | null;
  reapply(): boolean;
  restoreSelection: { token: number; selection: NoteBodySelection } | null;
  setAdapter(adapter: BodyAdapter): void;
  pendingBodies(): PendingBodyIdentity[];
  rebindOwner(ownerKey: string): boolean;
  submitOperation(input: { key: string; intent: unknown } & OperationCallbacks): { id: string; retained: boolean };
  recoverOperation(candidate: RecoveryCandidate, callbacks: OperationCallbacks): boolean;
  retryOperation(id: string): void;
  discardOperation(id: string): boolean;
}

export function useNoteEditorSession(input: UseNoteEditorSessionOptions): NoteEditorSession {
  const { accountId, noteRef, ownerKey } = input;
  const store = useMemo(() => getWritingSession(accountId), [accountId]);
  const viewId = useState(() => crypto.randomUUID())[0];
  const restoreToken = useRef(0);
  const [restoreSelection, setRestoreSelection] = useState<{ token: number; selection: NoteBodySelection } | null>(null);
  const initialSnapshot = useMemo<WritingSnapshot>(() => ({
    document: { body: input.initial.body, revision: 0 },
    status: "clean", localRetained: true, hasRecoveredDraft: false, conflict: null,
  }), [input.initial.body]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.peekSnapshot(noteRef) ?? initialSnapshot,
    () => initialSnapshot,
  );
  useEffect(() => {
    store.openBody(input);
    store.observeBodyAcknowledgement(noteRef, viewId, input.adapter?.onAcknowledge);
  }, [store, noteRef, viewId, input]);
  useEffect(() => () => store.closeView(noteRef, viewId), [store, noteRef, viewId]);
  const edit = useCallback((value: NoteBodyEdit) => store.edit(noteRef, viewId, value), [store, noteRef, viewId]);
  const selection = useCallback((value: NoteBodySelection) => store.selection(noteRef, viewId, value), [store, noteRef, viewId]);
  const boundary = useCallback(() => store.boundary(noteRef, viewId), [store, noteRef, viewId]);
  const undo = useCallback(() => {
    const selection = store.undo(noteRef, viewId);
    if (selection) setRestoreSelection({ token: ++restoreToken.current, selection });
    return selection;
  }, [store, noteRef, viewId]);
  const redo = useCallback(() => {
    const selection = store.redo(noteRef, viewId);
    if (selection) setRestoreSelection({ token: ++restoreToken.current, selection });
    return selection;
  }, [store, noteRef, viewId]);
  const flush = useCallback(() => store.flush(noteRef), [store, noteRef]);
  const retry = useCallback(() => store.retry(noteRef), [store, noteRef]);
  const recoveryCandidates = useCallback(() => store.listRecovery(ownerKey), [store, ownerKey]);
  const recover = useCallback((candidate: RecoveryCandidate) => candidate.revision !== null && !candidate.corrupt && store.recover(noteRef, candidate.key, candidate.revision), [store, noteRef]);
  const discard = useCallback(() => store.discard(noteRef), [store, noteRef]);
  const exportRaw = useCallback((key: string) => store.exportRaw(key), [store]);
  const reapply = useCallback(() => store.reapply(noteRef), [store, noteRef]);
  const setAdapter = useCallback((adapter: BodyAdapter) => { store.setBodyAdapter(noteRef, adapter); store.observeBodyAcknowledgement(noteRef, viewId, adapter.onAcknowledge); }, [store, noteRef, viewId]);
  const pendingBodies = useCallback(() => store.findPendingBodies(ownerKey), [store, ownerKey]);
  const rebindOwner = useCallback((nextOwnerKey: string) => store.rebindOwner(noteRef, nextOwnerKey), [store, noteRef]);
  const submitOperation = useCallback((operation: { key: string; intent: unknown } & OperationCallbacks) => store.enqueueOperation({ ownerKey, ...operation }), [store, ownerKey]);
  const recoverOperation = useCallback((candidate: RecoveryCandidate, callbacks: OperationCallbacks) => {
    if (candidate.corrupt || candidate.revision === null || candidate.operationId === null) return false;
    if (!store.recoverOperation(candidate.key, candidate.revision, candidate.operationId)) return false;
    store.attachOperation(candidate.operationId, callbacks);
    return true;
  }, [store]);
  const retryOperation = useCallback((id: string) => store.retry(id), [store]);
  const discardOperation = useCallback((id: string) => store.discardOperation(id), [store]);
  return { ...snapshot, edit, selection, boundary, undo, redo, flush, retry, recoveryCandidates, recover, discard, exportRaw, reapply, restoreSelection, setAdapter, pendingBodies, rebindOwner, submitOperation, recoverOperation, retryOperation, discardOperation };
}
