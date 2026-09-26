"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  useFeedback,
  type FeedbackAnnouncement,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { decodeHighlightLinkedNoteBlock, type HighlightLinkedNoteBlock } from "@/lib/highlights/highlightContract";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import { emptyNoteBody } from "@/lib/notes/prosemirror/schema";
import { useNoteEditorSession } from "@/lib/notes/useNoteEditorSession";
import { getWritingSession, WritingStorageError, WritingUnknownOutcomeError, type BodyAdapter, type OperationCallbacks, type PendingBodyIdentity, type RecoveryCandidate } from "@/lib/notes/writingSession";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { decodeLinkNoteOut } from "@/lib/resourceGraph/links";
import { resolveResourceLocator } from "@/lib/resources/resourceLocators";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { expectExactRecord, expectOneOf, expectRecord, expectString } from "@/lib/validation";
import NoteBodyEditor, { type NoteBodyEdit } from "@/components/notes/NoteBodyEditor";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import styles from "./HighlightNoteEditor.module.css";

export interface AnnotationNoteTarget {
  kind: "highlight" | "link";
  id: string | null;
  ownerKey: string;
  recoveryOwnerKey?: string;
  creation?: Promise<{ id: string } | null>;
}

export interface HighlightNoteEditorProps {
  target: AnnotationNoteTarget;
  note: HighlightLinkedNoteBlock | null;
  editable: boolean;
  onSaved: (targetId: string, note: HighlightLinkedNoteBlock) => void;
  onDetached: (targetId: string, noteBlockId: string) => void;
  onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
  onEditAccepted?: (noteRef: string, hasPending: () => boolean) => void;
  onMutationStarted?: (noteRef: string) => MountedEditorMutationLease | null;
  onDone?: () => void;
}

type DetachIntent = { targetId: string; noteBlockId: string; clientMutationId: string; kind: "highlight" | "link" };

function decodeDetachIntent(raw: unknown): DetachIntent {
  const value = expectExactRecord(raw, ["targetId", "noteBlockId", "clientMutationId", "kind"], "pending removal intent");
  return {
    targetId: expectString(value.targetId, "pending removal target"),
    noteBlockId: expectString(value.noteBlockId, "pending removal note"),
    clientMutationId: expectString(value.clientMutationId, "pending removal mutation"),
    kind: expectOneOf(value.kind, ["highlight", "link"] as const, "pending removal kind"),
  };
}

export class HighlightNoteTargetUnavailableError extends Error {
  constructor() {
    super("highlight target was not created");
    this.name = "HighlightNoteTargetUnavailableError";
  }
}

function exportText(name: string, value: string, mime = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([value], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function attachmentErrorMessage(error: unknown): FeedbackContent {
  if (isApiError(error)) return mediaCaptureErrorMessage(error, "AddAttachment");
  if (!(error instanceof Error)) throw error;
  const modeledLocalFailure =
    error.message === "Select the note body or empty it before attaching a file." ||
    error.message === "Attach one file at a time here." ||
    error.message === "Only PDF and EPUB files are supported." ||
    /^(PDF|EPUB) files must not be empty\.$/.test(error.message) ||
    /^(PDF|EPUB) files must be \d+ MB or smaller\.$/.test(error.message) ||
    error.message === "Couldn’t save";
  if (!modeledLocalFailure) throw error;
  return {
    tone: "Danger",
    title: "Attachment wasn’t added",
    message: error.message === "Couldn’t save" ? "Check the URL and try again." : error.message,
  };
}

export default function HighlightNoteEditor(props: HighlightNoteEditorProps) {
  return <AnnotationEditor key={`${props.target.ownerKey}:${props.target.recoveryOwnerKey ?? ""}`} {...props} />;
}

function AnnotationEditor(props: HighlightNoteEditorProps) {
  const { accountId } = useAuthenticatedAccount();
  const { target, note } = props;
  const store = useMemo(() => getWritingSession(accountId), [accountId]);
  const [selected, setSelected] = useState<PendingBodyIdentity | null>(null);
  const [choices, setChoices] = useState<PendingBodyIdentity[] | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const prepared = useRef(false);
  const recoveryOwnerKey = target.kind === "highlight" && target.id !== null ? target.recoveryOwnerKey : undefined;

  useEffect(() => {
    if (note || prepared.current) return;
    prepared.current = true;
    try {
      const pending = [
        ...store.findPendingBodies(target.ownerKey),
        ...(recoveryOwnerKey ? store.findPendingBodies(recoveryOwnerKey) : []),
      ].filter((item, index, all) => all.findIndex((other) =>
        other.noteRef === item.noteRef && other.sourceKey === item.sourceKey && other.revision === item.revision,
      ) === index);
      if (pending.length === 1) setSelected(pending[0]);
      else if (pending.length > 1) setChoices(pending);
      else setSelected({ noteRef: `note_block:${createRandomId()}`, sourceKey: null, revision: null });
    } catch {
      setStorageUnavailable(true);
      setSelected({ noteRef: `note_block:${createRandomId()}`, sourceKey: null, revision: null });
    }
  }, [note, recoveryOwnerKey, store, target.ownerKey]);

  const noteRef = note ? `note_block:${note.note_block_id}` : selected?.noteRef;
  if (!noteRef) {
    return (
      <div className={styles.shell}>
        {choices ? (
          <div className={styles.recoveryChoices} role="alert">
            <p>Several unsaved notes belong to this annotation. Choose one before writing.</p>
            {choices.map((choice, index) => (
              <Button key={`${choice.noteRef}:${choice.sourceKey ?? "local"}:${index}`} variant="secondary" size="sm" onClick={() => { setSelected(choice); setChoices(null); }}>
                Recover note {index + 1}
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => { setSelected({ noteRef: `note_block:${createRandomId()}`, sourceKey: null, revision: null }); setChoices(null); }}>
              Start another note
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (!noteRef.startsWith("note_block:")) throw new TypeError("annotation draft has an invalid note reference");
  return <AnnotationBody key={noteRef} {...props} accountId={accountId} noteRef={noteRef} recovery={note ? null : selected} storageUnavailable={storageUnavailable} />;
}

function AnnotationBody({
  accountId,
  noteRef,
  recovery,
  storageUnavailable,
  target,
  note,
  editable,
  onSaved,
  onDetached,
  onOpenLink,
  onEditAccepted,
  onMutationStarted,
  onDone,
}: HighlightNoteEditorProps & {
  accountId: string;
  noteRef: string;
  recovery: PendingBodyIdentity | null;
  storageUnavailable: boolean;
}) {
  const feedback = useFeedback();
  const noteBlockId = noteRef.slice("note_block:".length);
  const [resolvedTargetId, setResolvedTargetId] = useState(target.id);
  const [targetFailure, setTargetFailure] = useState(false);
  const [attachedNote, setAttachedNote] = useState(note);
  const [detachOperationId, setDetachOperationId] = useState<string | null>(null);
  const detachLease = useRef<MountedEditorMutationLease | null>(null);
  const [detachFailure, setDetachFailure] = useState<FeedbackContent | null>(null);
  const [detachConflict, setDetachConflict] = useState(false);
  const [recoveryFailure, setRecoveryFailure] = useState(false);
  const [attachmentFeedback, setAttachmentFeedback] = useState<{ content: FeedbackContent; announcement: FeedbackAnnouncement } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryCandidate[]>([]);
  const [orphanBodies, setOrphanBodies] = useState<PendingBodyIdentity[]>([]);
  const [recoveryStorageUnavailable, setRecoveryStorageUnavailable] = useState(false);
  const projection = useRef(note);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const detachedCallback = useRef(onDetached);
  detachedCallback.current = onDetached;

  useEffect(() => {
    if (!note) return;
    if (!projection.current || note.version_by_lane.body >= projection.current.version_by_lane.body) {
      projection.current = note;
      setAttachedNote(note);
    }
  }, [note]);

  const makeAdapter = useCallback((targetId: string): BodyAdapter => ({
    prepare: ({ body, expectedBody, clientMutationId }) => ({
      path: target.kind === "highlight"
        ? `/api/highlights/${encodeURIComponent(targetId)}/note`
        : `/api/resource-graph/links/${encodeURIComponent(targetId)}/note`,
      method: "PUT",
      body: JSON.stringify({
        note_block_id: noteBlockId,
        client_mutation_id: clientMutationId,
        expected_body: expectedBody,
        body_pm_json: body.bodyPmJson,
      }),
    }),
    acknowledge: (data) => {
      const saved = target.kind === "highlight"
        ? decodeHighlightLinkedNoteBlock(data)
        : decodeLinkNoteOut(data);
      if (saved.note_block_id !== noteBlockId) throw new TypeError("annotation save changed note identity");
      projection.current = {
        note_block_id: saved.note_block_id,
        body_pm_json: saved.body_pm_json,
        body_text: saved.body_text,
        version_by_lane: saved.version_by_lane,
      };
      return { body: { bodyPmJson: saved.body_pm_json, bodyText: saved.body_text }, version: saved.version_by_lane.body };
    },
    onAcknowledge: async (ack) => {
      let previous = projection.current;
      if (!previous) {
        const response = await apiFetch<{ data: unknown }>(`/api/notes/blocks/${encodeURIComponent(noteBlockId)}`);
        const block = expectRecord(response.data, "saved annotation note");
        previous = decodeHighlightLinkedNoteBlock({
          note_block_id: block.id,
          body_pm_json: block.bodyPmJson,
          body_text: block.bodyText,
          version_by_lane: block.versionByLane,
        });
        if (previous.note_block_id !== noteBlockId) throw new TypeError("saved annotation changed note identity");
      }
      if (projection.current && projection.current.version_by_lane.body > ack.version) return;
      const saved: HighlightLinkedNoteBlock = previous.version_by_lane.body > ack.version ? previous : {
        ...previous,
        body_pm_json: ack.body.bodyPmJson,
        body_text: ack.body.bodyText,
        version_by_lane: { ...previous.version_by_lane, body: ack.version },
      };
      projection.current = saved;
      setAttachedNote(saved);
      savedCallback.current(targetId, saved);
    },
  }), [noteBlockId, target.kind]);
  const adapter = useMemo(() => resolvedTargetId ? makeAdapter(resolvedTargetId) : null, [makeAdapter, resolvedTargetId]);
  const activeOwnerKey = resolvedTargetId ? `${target.kind}:${resolvedTargetId}` : target.ownerKey;
  const initial = useMemo(() => ({
    body: note ? { bodyPmJson: note.body_pm_json, bodyText: note.body_text } : emptyNoteBody(),
    version: note?.version_by_lane.body ?? null,
  }), [note]);
  const session = useNoteEditorSession({
    accountId,
    noteRef,
    ownerKey: activeOwnerKey,
    initial,
    adapter,
    awaitExternalCreation: target.id === null,
    onMutationStarted: onMutationStarted ? () => onMutationStarted(noteRef) : undefined,
    onError: (error) => {
      if (error instanceof WritingUnknownOutcomeError) return;
      if (handleUnauthenticatedApiError(error)) return;
      if (isSameSystemApiDefect(error) || !isApiError(error)) setDefect({ error });
    },
  });
  const { recover, setAdapter, status } = session;
  const hasPending = useCallback(() => {
    const snapshot = getWritingSession(accountId).peekSnapshot(noteRef);
    return snapshot !== null && snapshot.localRetained &&
      (snapshot.status === "dirty" || snapshot.status === "saving");
  }, [accountId, noteRef]);
  const edit = useCallback((value: NoteBodyEdit) => {
    const store = getWritingSession(accountId);
    const before = store.peekSnapshot(noteRef)?.document.revision;
    const accepted = session.edit(value);
    if (accepted && store.peekSnapshot(noteRef)?.document.revision !== before) onEditAccepted?.(noteRef, hasPending);
    return accepted;
  }, [accountId, hasPending, noteRef, onEditAccepted, session]);
  const undo = useCallback(() => {
    const selection = session.undo();
    if (selection) onEditAccepted?.(noteRef, hasPending);
    return selection;
  }, [hasPending, noteRef, onEditAccepted, session]);
  const redo = useCallback(() => {
    const selection = session.redo();
    if (selection) onEditAccepted?.(noteRef, hasPending);
    return selection;
  }, [hasPending, noteRef, onEditAccepted, session]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!recovery) return;
    const store = getWritingSession(accountId);
    try {
      if (recovery.sourceKey) {
        const candidate = [
          ...store.listRecovery(activeOwnerKey),
          ...(target.recoveryOwnerKey ? store.listRecovery(target.recoveryOwnerKey) : []),
        ].find((item) => item.key === recovery.sourceKey && item.noteRef === noteRef && item.revision === recovery.revision);
        if (!candidate || !recover(candidate)) { setRecoveryFailure(true); return; }
      }
      if (target.recoveryOwnerKey && activeOwnerKey !== target.recoveryOwnerKey) {
        if (!store.rebindOwner(noteRef, activeOwnerKey)) { setRecoveryFailure(true); return; }
        if (adapter) setAdapter(adapter);
      }
      if (recovery.sourceKey || target.recoveryOwnerKey) store.flush(noteRef);
    } catch {
      setRecoveryFailure(true);
    }
  }, [accountId, activeOwnerKey, adapter, noteRef, recover, recovery, setAdapter, target.recoveryOwnerKey]);

  useEffect(() => {
    if (target.id !== null) return;
    if (!target.creation) { setTargetFailure(true); return; }
    void target.creation.then((created) => {
      if (!created) { if (mounted.current) setTargetFailure(true); return; }
      const store = getWritingSession(accountId);
      store.rebindOwner(noteRef, `${target.kind}:${created.id}`);
      const resolvedAdapter = makeAdapter(created.id);
      if (mounted.current) {
        setResolvedTargetId(created.id);
        setAdapter(resolvedAdapter);
      } else {
        store.setBodyAdapter(noteRef, resolvedAdapter);
      }
      store.flush(noteRef);
    }).catch((error: unknown) => {
      if (mounted.current) {
        if (handleUnauthenticatedApiError(error)) return;
        setTargetFailure(true);
      }
    });
  }, [accountId, makeAdapter, noteRef, setAdapter, target.creation, target.id, target.kind]);

  useEffect(() => {
    const store = getWritingSession(accountId);
    try {
      const candidates = [
        ...store.listRecovery(activeOwnerKey),
        ...(target.recoveryOwnerKey ? store.listRecovery(target.recoveryOwnerKey) : []),
      ];
      setRecoveryCandidates(candidates.filter((item, index) => candidates.findIndex((other) =>
        other.key === item.key && other.noteRef === item.noteRef && other.operationId === item.operationId,
      ) === index));
      setOrphanBodies(target.recoveryOwnerKey && attachedNote ? store.findPendingBodies(target.recoveryOwnerKey)
        .filter((item) => item.noteRef !== noteRef) : []);
      setRecoveryStorageUnavailable(false);
    } catch (error) {
      if (!(error instanceof WritingStorageError)) throw error;
      setRecoveryStorageUnavailable(true);
    }
  }, [accountId, activeOwnerKey, attachedNote, noteRef, status, target.recoveryOwnerKey]);

  const openObject = useCallback(async (objectType: string, objectId: string, disposition: WorkspaceTargetDisposition) => {
    const ref = `${objectType}:${objectId}`;
    if (!parseResourceRef(ref)) return;
    try {
      const resolved = await resolveResourceLocator({ kind: "resource_ref", ref });
      if (resolved.resourceItem.route) onOpenLink(resolved.resourceItem.route, disposition);
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
      const content = apiTransportFeedback(error, "Linked object wasn’t opened");
      if (!content) { setDefect({ error }); return; }
      feedback.publish({ kind: "Hud", content, actions: [{ label: "Retry", onClick: () => { void openObject(objectType, objectId, disposition); } }] });
    }
  }, [feedback, onOpenLink]);

  const detachCallbacks = useCallback((intent: DetachIntent): OperationCallbacks => ({
    prepare: () => {
      const params = new URLSearchParams({ note_block_id: intent.noteBlockId, client_mutation_id: intent.clientMutationId });
      return {
        path: intent.kind === "highlight"
          ? `/api/highlights/${encodeURIComponent(intent.targetId)}/note?${params.toString()}`
          : `/api/resource-graph/links/${encodeURIComponent(intent.targetId)}/note?${params.toString()}`,
        method: "DELETE",
        body: "",
      };
    },
    onAck: () => {
      setDetachOperationId(null);
      setDetachFailure(null);
      setDetachConflict(false);
      setAttachedNote((current) => current?.note_block_id === intent.noteBlockId ? null : current);
      detachedCallback.current(intent.targetId, intent.noteBlockId);
      const lease = detachLease.current;
      detachLease.current = null;
      void lease?.committed().catch((error: unknown) => setDefect({ error }));
    },
    onError: (error) => {
      detachLease.current?.failed();
      detachLease.current = null;
      if (error instanceof WritingUnknownOutcomeError) {
        setDetachFailure({ tone: "Danger", title: "Removal outcome unknown", message: "Retry the same removal request to confirm it." });
        return;
      }
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
      setDetachConflict(error.code === "E_RESOURCE_CONFLICT");
      setDetachFailure(apiTransportFeedback(error, "Annotation wasn’t removed") ?? {
        tone: "Danger",
        title: "Annotation wasn’t removed",
        message: error.code === "E_RESOURCE_CONFLICT" ? "This annotation changed. The old removal was not applied." : "Retry or refresh the reader.",
        requestId: error.requestId,
      });
    },
  }), []);

  const retryDetach = useCallback(() => {
    if (!detachOperationId) return;
    const store = getWritingSession(accountId);
    const operation = store.pendingOperations(activeOwnerKey).find((item) => item.id === detachOperationId);
    if (!operation) return;
    let intent: DetachIntent;
    try { intent = decodeDetachIntent(operation.intent); }
    catch { setRecoveryFailure(true); return; }
    const operationNoteRef = `note_block:${intent.noteBlockId}`;
    onEditAccepted?.(operationNoteRef, () => store.pendingOperations(activeOwnerKey)
      .some((item) => item.id === detachOperationId && item.paused === null));
    detachLease.current = onMutationStarted?.(operationNoteRef) ?? null;
    setDetachFailure(null);
    session.retryOperation(detachOperationId);
    if (!store.pendingOperations(activeOwnerKey).some((item) => item.id === detachOperationId && item.paused === null)) {
      detachLease.current?.failed();
      detachLease.current = null;
    }
  }, [accountId, activeOwnerKey, detachOperationId, onEditAccepted, onMutationStarted, session]);

  const detach = useCallback(() => {
    const attached = attachedNote;
    const targetId = resolvedTargetId;
    if (!attached || !targetId || detachOperationId) return;
    session.flush();
    const intent: DetachIntent = { targetId, noteBlockId: attached.note_block_id, clientMutationId: createRandomId(), kind: target.kind };
    let operationId: string | null = null;
    onEditAccepted?.(noteRef, () => operationId !== null && getWritingSession(accountId).pendingOperations(activeOwnerKey)
      .some((operation) => operation.id === operationId && operation.paused === null));
    detachLease.current = onMutationStarted?.(noteRef) ?? null;
    const operation = session.submitOperation({
      key: `annotation-detach:${target.kind}:${targetId}:${attached.note_block_id}`,
      intent,
      ...detachCallbacks(intent),
    });
    operationId = operation.id;
    setDetachOperationId(operation.id);
    if (!operation.retained) {
      detachLease.current?.failed();
      detachLease.current = null;
      setDetachFailure({ tone: "Danger", title: "Removal isn’t retained on this device", message: "Keep this tab open until the request finishes." });
    }
  }, [accountId, activeOwnerKey, attachedNote, detachCallbacks, detachOperationId, noteRef, onEditAccepted, onMutationStarted, resolvedTargetId, session, target.kind]);

  useEffect(() => {
    const store = getWritingSession(accountId);
    for (const operation of store.pendingOperations(activeOwnerKey)) {
      if (!operation.key.startsWith("annotation-detach:")) continue;
      try {
        const intent = decodeDetachIntent(operation.intent);
        if (intent.kind !== target.kind || intent.targetId !== resolvedTargetId) continue;
        detachLease.current ??= onMutationStarted?.(`note_block:${intent.noteBlockId}`) ?? null;
        store.attachOperation(operation.id, detachCallbacks(intent));
        setDetachOperationId(operation.id);
        setDetachFailure({ tone: "Danger", title: "Removal is still pending", message: "Retry the same removal request. A different note attachment is safe." });
      } catch {
        setRecoveryFailure(true);
      }
    }
  }, [accountId, activeOwnerKey, detachCallbacks, onMutationStarted, resolvedTargetId, target.kind]);

  const recoverDetach = useCallback((candidate: RecoveryCandidate) => {
    try {
      const journal = expectRecord(JSON.parse(candidate.raw), "writing journal");
      if (!Array.isArray(journal.operations)) throw new TypeError("writing journal operations are missing");
      const operation = journal.operations.find((item: unknown) => expectRecord(item, "pending operation").id === candidate.operationId);
      const stored = expectRecord(operation, "pending removal");
      if (typeof stored.key !== "string" || !stored.key.startsWith("annotation-detach:")) throw new TypeError("pending operation is not an annotation removal");
      const intent = decodeDetachIntent(stored.intent);
      if (intent.kind !== target.kind || intent.targetId !== resolvedTargetId) throw new TypeError("pending removal belongs to another annotation");
      if (!session.recoverOperation(candidate, detachCallbacks(intent))) return;
      setDetachOperationId(candidate.operationId);
      setRecoveryCandidates(session.recoveryCandidates());
    } catch {
      setRecoveryFailure(true);
    }
  }, [detachCallbacks, resolvedTargetId, session, target.kind]);

  if (defect) throw defect.error;

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <NoteBodyEditor
        resourceKey={noteRef}
        document={session.document}
        restoreSelection={session.restoreSelection ?? undefined}
        editable={editable}
        ariaLabel={target.kind === "highlight" ? "Highlight note" : "Link note"}
        compact
        onEdit={edit}
        onSelectionChange={session.selection}
        onHistoryBoundary={session.boundary}
        onUndoRequest={undo}
        onRedoRequest={redo}
        onFlushRequest={session.flush}
        onOpenObject={openObject}
        onFeedback={(content) => setAttachmentFeedback({ content, announcement: "Polite" })}
        onError={(error) => {
          if (handleUnauthenticatedApiError(error)) return;
          try { setAttachmentFeedback({ content: attachmentErrorMessage(error), announcement: "Assertive" }); }
          catch (caughtDefect) { setDefect({ error: caughtDefect }); }
        }}
      />
      {editable && (onDone || attachedNote) ? (
        <div className={styles.actions}>
          {attachedNote ? <Button variant="ghost" size="sm" onClick={detach} disabled={detachOperationId !== null}>Remove annotation</Button> : null}
          {onDone ? <Button variant="ghost" size="sm" onClick={() => { session.flush(); onDone(); }}>Done</Button> : null}
        </div>
      ) : null}
      {targetFailure ? <FeedbackNotice content={{ tone: "Danger", title: "Highlight creation wasn’t confirmed", message: "Your note remains here. Select the same passage again to recover it, or export it." }} announcement="Assertive" actions={[{ label: "Export my text", onClick: () => exportText("annotation-note.txt", session.document.body.bodyText) }]} /> : null}
      {storageUnavailable || recoveryStorageUnavailable ? <FeedbackNotice content={{ tone: "Danger", title: "Device storage is unavailable", message: "Changes may exist only in this tab. Export your text before closing." }} announcement="Assertive" /> : null}
      {attachmentFeedback ? <FeedbackNotice content={attachmentFeedback.content} announcement={attachmentFeedback.announcement} /> : null}
      {detachFailure ? <FeedbackNotice content={detachFailure} announcement="Assertive" actions={detachOperationId ? detachConflict
        ? [{ label: "Discard old removal", onClick: () => { if (session.discardOperation(detachOperationId)) { setDetachOperationId(null); setDetachFailure(null); setDetachConflict(false); } } }]
        : [{ label: "Retry", onClick: retryDetach }]
        : undefined} /> : null}
      {recoveryFailure ? <FeedbackNotice content={{ tone: "Danger", title: "Unsaved work couldn’t be recovered", message: "Export its raw journal before trying again." }} announcement="Assertive" actions={[{ label: "Export raw", onClick: () => exportText("writing-journal.json", recovery?.sourceKey ? getWritingSession(accountId).exportRaw(recovery.sourceKey) ?? getWritingSession(accountId).exportCurrentRaw() : getWritingSession(accountId).exportCurrentRaw(), "application/json") }]} /> : null}
      <NoteDraftRecovery
        status={session.status}
        localRetained={session.localRetained}
        hasRecoveredDraft={session.hasRecoveredDraft}
        conflict={session.conflict}
        onRetry={() => {
          onEditAccepted?.(noteRef, hasPending);
          session.retry();
          if (!hasPending()) onMutationStarted?.(noteRef)?.failed();
        }}
        onReapply={() => {
          onEditAccepted?.(noteRef, hasPending);
          session.reapply();
          if (!hasPending()) onMutationStarted?.(noteRef)?.failed();
        }}
        onDiscard={session.discard}
        onExport={() => exportText("annotation-note.txt", session.document.body.bodyText)}
      />
      {recoveryCandidates.length ? (
        <details className={styles.recoveryChoices}>
          <summary>Other unsaved drafts</summary>
          {recoveryCandidates.map((candidate, index) => (
            <div key={`${candidate.key}:${candidate.noteRef ?? candidate.operationId ?? index}`} className={styles.recoveryCandidate}>
              <span>{candidate.corrupt ? "Unreadable draft" : candidate.noteRef === noteRef ? "This note" : "Another note or pending removal"}</span>
              {!candidate.corrupt && candidate.noteRef === noteRef && candidate.revision !== null ? (
                <Button variant="secondary" size="sm" onClick={() => {
                  if (!session.recover(candidate)) return;
                  session.rebindOwner(activeOwnerKey);
                  session.flush();
                  try { setRecoveryCandidates(getWritingSession(accountId).listRecovery(activeOwnerKey)); }
                  catch (error) {
                    if (!(error instanceof WritingStorageError)) throw error;
                    setRecoveryStorageUnavailable(true);
                  }
                }}>Recover note</Button>
              ) : null}
              {!candidate.corrupt && candidate.operationId && candidate.revision !== null ? (
                <Button variant="secondary" size="sm" onClick={() => recoverDetach(candidate)}>Retry removal</Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => exportText("writing-journal.json", session.exportRaw(candidate.key) ?? candidate.raw, "application/json")}>Export raw</Button>
            </div>
          ))}
        </details>
      ) : null}
      {orphanBodies.length ? (
        <div className={styles.recoveryChoices} role="alert">
          <p>An unsaved draft belongs to this passage, but another note is attached. Export the draft before editing it elsewhere.</p>
          {orphanBodies.map((item, index) => (
            <Button key={`${item.noteRef}:${item.sourceKey ?? "current"}:${index}`} variant="secondary" size="sm" onClick={() => {
              const raw = item.sourceKey ? getWritingSession(accountId).exportRaw(item.sourceKey) : getWritingSession(accountId).exportCurrentRaw();
              if (raw === null) { setRecoveryFailure(true); return; }
              exportText(`annotation-draft-${index + 1}.json`, raw, "application/json");
            }}>Export unsaved draft {orphanBodies.length > 1 ? index + 1 : ""}</Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
