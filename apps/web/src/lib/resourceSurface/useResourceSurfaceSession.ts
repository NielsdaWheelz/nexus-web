"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { NoteBodyEdit, NoteBodyEditorDocument, NoteBodySelection } from "@/components/notes/NoteBodyEditor";
import { isApiError } from "@/lib/api/client";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  acknowledgeDailyDraftHandoff,
  claimDailyDraftBody,
  clearDailyDraft,
  DailyDraftStorageError,
  readDailyDraft,
  readDailyDraftRaw,
  writeDailyDraft,
  type DailyDraft,
  type DailyDraftHandoff,
} from "@/lib/notes/dailyDraftStore";
import { decodeDailyCaptureResult } from "@/lib/notes/api";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  createNoteBodyDoc,
  noteBodyValueFromDoc,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
import {
  getWritingSession,
  WritingStorageError,
  WritingUnknownOutcomeError,
  type FrozenRequest,
  type RecoveryCandidate,
  type WritingStatus,
} from "@/lib/notes/writingSession";
import { copyText } from "@/lib/ui/copyText";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import {
  decodeResourceSurfaceCommand,
  decodeResourceSurfaceTitle,
  fetchResourceSurface,
  prepareResourceSurfaceCommand,
  prepareResourceSurfaceTitle,
  resourceSurfaceCommandId,
} from "@/lib/resourceSurface/api";
import {
  appendDailyBodyText,
  appendDailyDraftText,
  createDailyDraft,
  draftNoteRef,
  loadDailySurface,
  type DailySurfaceSessionOptions,
} from "@/lib/resourceSurface/dailySurfacePersistence";
import {
  type ResourceSurfaceDraftIntent,
  type ResourceSurfacePendingBody,
  type ResourceSurfacePendingTitle,
} from "@/lib/resourceSurface/draftStore";
import {
  createResourceSurfaceIntent,
  materializeResourceSurfaceIntent,
  projectResourceSurface,
  rebindAcknowledgedResourceSurfaceIntents,
  resourceSurfaceLaneVersion,
  resourceSurfaceOccurrenceForRef,
  resourceSurfacePendingOccurrenceId,
  type ResourceSurfaceCommand,
} from "@/lib/resourceSurface/model";
import { expectRecord, expectString } from "@/lib/validation";

type SurfaceOperation =
  | { kind: "graph"; sourceRef: string; intent: ResourceSurfaceDraftIntent }
  | { kind: "title"; sourceRef: string; title: string; clientMutationId: string }
  | { kind: "capture"; localDate: string; noteId: string; clientMutationId: string };

type PersistedOptions = {
  accountId: string;
  sourceRef: string;
  initialSurface: ResourceSurface;
  onError?: (error: unknown) => void;
  onTitleMutationStarted?: () => MountedEditorMutationLease | null;
  onSourceBodyMutationStarted?: () => MountedEditorMutationLease | null;
};

type RestoreSelection = { token: number; selection: NoteBodySelection };

type SharedSurfaceOwner = {
  surface: ResourceSurface | null;
  sourceRef: string | null;
  listeners: Set<() => void>;
  failure: WritingStatus | null;
  retained: boolean;
};
const surfaceOwners = new Map<string, SharedSurfaceOwner>();

function getSurfaceOwner(
  accountId: string,
  ownerKey: string,
  surface: ResourceSurface | null,
  sourceRef: string | null,
): SharedSurfaceOwner {
  if (typeof window === "undefined") {
    return { surface, sourceRef, listeners: new Set(), failure: null, retained: true };
  }
  const key = accountId + ":" + ownerKey;
  let owner = surfaceOwners.get(key);
  if (!owner) {
    owner = { surface, sourceRef, listeners: new Set(), failure: null, retained: true };
    surfaceOwners.set(key, owner);
  }
  return owner;
}

export interface ResourceSurfaceSession {
  surface: ResourceSurface;
  status: WritingStatus;
  localRetained: boolean;
  hasRecoveredDraft: boolean;
  recoveryCandidates: readonly RecoveryCandidate[];
  recover(candidate: RecoveryCandidate): boolean;
  bodyDocument(occurrenceId: string): NoteBodyEditorDocument;
  restoreSelection(occurrenceId: string): RestoreSelection | undefined;
  editBody(input: { occurrenceId: string; edit: NoteBodyEdit }): void;
  selection(input: { occurrenceId: string; selection: NoteBodySelection }): void;
  boundary(occurrenceId: string): void;
  undo(occurrenceId: string): void;
  redo(occurrenceId: string): void;
  updateTitle(title: string): void;
  command(command: ResourceSurfaceCommand): string | null;
  flush(): void;
  retry(): void;
  reload(): Promise<void>;
  copyRecovery(): Promise<void>;
}

export interface DailyResourceSurfaceSession extends Omit<ResourceSurfaceSession, "surface"> {
  surface: ResourceSurface | null;
  title: string | null;
  provisional: { occurrenceId: string; noteRef: string; bodyPmJson: Record<string, unknown>; bodyText: string } | null;
  inputHandoff: DailyDraftHandoff;
  acknowledgeInputHandoff(handoffId: string): void;
}

function bodyFromJson(bodyPmJson: Record<string, unknown>): NoteBodyValue {
  return noteBodyValueFromDoc(createNoteBodyDoc({ bodyPmJson }));
}

function noteBodyAdapter() {
  return {
    prepare(): FrozenRequest {
      throw new Error("surface note creation must commit before its body");
    },
    acknowledge(): never {
      throw new Error("surface note body acknowledgement is owned by the canonical resource endpoint");
    },
  };
}

function surfaceBody(surface: ResourceSurface, noteRef: string): { body: NoteBodyValue; version: number } | null {
  const node = surface.source.item.ref === noteRef
    ? surface.source
    : resourceSurfaceOccurrenceForRef(surface, noteRef)?.target;
  if (!node || node.content.kind !== "note_body") return null;
  return {
    body: bodyFromJson(node.content.bodyPmJson),
    version: resourceSurfaceLaneVersion(node.item, "body"),
  };
}

function asOperation(raw: unknown): SurfaceOperation {
  const value = expectRecord(raw, "surface operation");
  const kind = expectString(value.kind, "surface operation.kind");
  if (kind === "graph" && typeof value.sourceRef === "string" && value.intent) {
    return value as SurfaceOperation;
  }
  if (kind === "title" && typeof value.sourceRef === "string" && typeof value.title === "string" && typeof value.clientMutationId === "string") {
    return value as SurfaceOperation;
  }
  if (kind === "capture" && typeof value.localDate === "string" && typeof value.noteId === "string" && typeof value.clientMutationId === "string") {
    return value as SurfaceOperation;
  }
  throw new TypeError("surface operation is invalid");
}

export function useResourceSurfaceSession(input: PersistedOptions | DailySurfaceSessionOptions): ResourceSurfaceSession | DailyResourceSurfaceSession {
  const daily = "daily" in input ? input.daily : null;
  const dailyStorageUnavailable = "daily" in input && input.storageUnavailable === true;
  const ownerKey = "surface:" + ("daily" in input ? input.sessionKey : input.sourceRef);
  const accountId = daily?.accountId ?? ("accountId" in input ? input.accountId : "");
  const dailyAccountId = daily?.accountId;
  const dailyLocalDate = daily?.localDate;
  const incomingDraft = "daily" in input ? input.draftSnapshot : undefined;
  const delivery = "daily" in input ? input.delivery : null;
  const session = getWritingSession(accountId);
  const [revision, publish] = useReducer((value: number) => value + 1, 0);
  const initial = "daily" in input ? input.initialMaterialized ?? null : null;
  const owner = getSurfaceOwner(
    accountId,
    ownerKey,
    "daily" in input ? initial?.surface ?? null : input.initialSurface,
    "daily" in input ? initial?.sourceRef ?? null : input.sourceRef,
  );
  if (typeof window !== "undefined" && owner.listeners.size === 0 &&
      session.pendingOperations(ownerKey).length === 0) {
    const mounted = "daily" in input ? initial?.surface ?? null : input.initialSurface;
    if (mounted) {
      owner.surface = mounted;
      owner.sourceRef = mounted.source.item.ref;
    }
  }
  const acknowledgedRef = useRef<ResourceSurface | null>(owner.surface);
  const sourceRefRef = useRef<string | null>(owner.sourceRef);
  const dailyDraftRef = useRef<DailyDraft | null>("daily" in input ? input.draftSnapshot ?? null : null);
  const dailyTitleRef = useRef<string | null>(null);
  const recoveredPauseRef = useRef(Boolean(dailyDraftRef.current));
  const deliveredIdsRef = useRef(new Set<string>());
  const appliedHandoffsRef = useRef(new Map<string, {
    handoff: Extract<DailyDraftHandoff, { kind: "Buffered" }>;
    retained: boolean;
  }>());
  const pendingHandoffClaimRef = useRef<string | null>(null);
  const selectionRef = useRef(new Map<string, RestoreSelection>());
  const tokenRef = useRef(0);
  const currentSurfaceRef = useRef<ResourceSurface | null>(null);
  const inputRef = useRef(input);
  const enqueueRef = useRef<(operation: SurfaceOperation) => string>(() => {
    throw new Error("surface operation queue is not ready");
  });
  inputRef.current = input;

  useEffect(() => session.subscribe(publish), [session]);
  useEffect(() => {
    const receive = () => {
      acknowledgedRef.current = owner.surface;
      sourceRefRef.current = owner.sourceRef;
      publish();
    };
    owner.listeners.add(receive);
    receive();
    return () => { owner.listeners.delete(receive); };
  }, [owner]);
  const acceptSurface = useCallback((next: ResourceSurface | null, nextSourceRef: string | null) => {
    owner.surface = next;
    owner.sourceRef = nextSourceRef;
    acknowledgedRef.current = next;
    sourceRefRef.current = nextSourceRef;
    for (const listener of owner.listeners) listener();
  }, [owner]);
  const publishOwner = useCallback(() => {
    for (const listener of owner.listeners) listener();
  }, [owner]);

  const acknowledged = acknowledgedRef.current;
  const { pending, surface } = useMemo(() => {
    // The session and owner publish when their mutable projection changes.
    void revision;
    const pending = session.pendingOperations(ownerKey);
    const graph = pending.filter((entry) => asOperation(entry.intent).kind === "graph").map((entry) => (asOperation(entry.intent) as Extract<SurfaceOperation, { kind: "graph" }>).intent);
    const titleOperation = [...pending].reverse().map((entry) => asOperation(entry.intent)).find((entry) => entry.kind === "title");
    const title: ResourceSurfacePendingTitle | undefined = titleOperation?.kind === "title"
      ? { value: titleOperation.title, clientMutationId: titleOperation.clientMutationId }
      : undefined;
    const bodyMap = new Map<string, ResourceSurfacePendingBody>();
    if (acknowledged) {
      const nodes = [acknowledged.source, ...acknowledged.orderedItems.map((row) => row.target)];
      for (const node of nodes) {
        if (node.content.kind !== "note_body" || bodyMap.has(node.item.ref)) continue;
        session.openBody({
          noteRef: node.item.ref,
          ownerKey,
          initial: surfaceBody(acknowledged, node.item.ref)!,
          adapter: noteBodyAdapter(),
          onError: (error) => inputRef.current.onError?.(error),
          ...(node.item.ref === acknowledged.source.item.ref
            ? { onMutationStarted: () => inputRef.current.onSourceBodyMutationStarted?.() ?? null }
            : {}),
        });
        const body = session.getSnapshot(node.item.ref).document.body;
        bodyMap.set(node.item.ref, { bodyPmJson: body.bodyPmJson, bodyText: body.bodyText, clientMutationId: "" });
      }
    }
    let surface = acknowledged ? projectResourceSurface({ acknowledgedSurface: acknowledged, intents: graph, title, bodies: bodyMap }) : null;
    if (surface) {
      for (const row of surface.orderedItems) {
        if (row.target.content.kind !== "note_body" || bodyMap.has(row.target.item.ref)) continue;
        session.openBody({
          noteRef: row.target.item.ref,
          ownerKey,
          initial: { body: bodyFromJson(row.target.content.bodyPmJson), version: null },
          adapter: noteBodyAdapter(),
          awaitExternalCreation: true,
        });
        const body = session.getSnapshot(row.target.item.ref).document.body;
        bodyMap.set(row.target.item.ref, { bodyPmJson: body.bodyPmJson, bodyText: body.bodyText, clientMutationId: "" });
      }
      surface = projectResourceSurface({ acknowledgedSurface: acknowledged!, intents: graph, title, bodies: bodyMap });
    }
    return { pending, surface };
  }, [acknowledged, ownerKey, revision, session]);
  const draft = dailyDraftRef.current;
  const provisionalRef = draft && !surface?.orderedItems.some((row) => row.target.item.ref === draftNoteRef(draft.noteId))
    ? draftNoteRef(draft.noteId)
    : null;
  if (provisionalRef) {
    session.openBody({
      noteRef: provisionalRef,
      ownerKey,
      initial: { body: draft!.seedBody ?? bodyFromJson({ type: "paragraph" }), version: null },
      adapter: noteBodyAdapter(),
      awaitExternalCreation: true,
    });
  }
  currentSurfaceRef.current = surface;
  void revision;

  const noteRefFor = useCallback((occurrenceId: string): string => {
    const current = currentSurfaceRef.current;
    if (current?.source.item.ref === occurrenceId) return occurrenceId;
    const row = current?.orderedItems.find((item) => item.occurrenceId === occurrenceId);
    if (row?.target.content.kind === "note_body") return row.target.item.ref;
    const activeDraft = dailyDraftRef.current;
    if (activeDraft && occurrenceId === "daily-provisional:" + activeDraft.noteId) return draftNoteRef(activeDraft.noteId);
    throw new Error("note body occurrence is unavailable");
  }, []);
  const viewIdFor = useCallback((occurrenceId: string) => ownerKey + ":" + occurrenceId, [ownerKey]);

  const bodyDocument = useCallback((occurrenceId: string) =>
    session.getSnapshot(noteRefFor(occurrenceId)).document, [noteRefFor, session]);
  const restoreSelection = useCallback((occurrenceId: string) =>
    selectionRef.current.get(viewIdFor(occurrenceId)), [viewIdFor]);
  const editBody = ({ occurrenceId, edit }: { occurrenceId: string; edit: NoteBodyEdit }) => {
    const ref = noteRefFor(occurrenceId);
    if (!session.edit(ref, viewIdFor(occurrenceId), edit)) {
      publishOwner();
      return;
    }
    publishOwner();
    const activeDraft = dailyDraftRef.current;
    if (daily && activeDraft && ref === draftNoteRef(activeDraft.noteId)) {
      recoveredPauseRef.current = false;
      if (session.getSnapshot(ref).localRetained && activeDraft.seedBody &&
          activeDraft.handoff.kind !== "Buffered") {
        if (claimDailyDraftBody(daily.accountId, daily.localDate, activeDraft.noteId)) {
          dailyDraftRef.current = { ...activeDraft, seedBody: null };
        } else {
          owner.retained = false;
          owner.failure = "storage_failed";
        }
      }
      const capturePending = session.pendingOperations(ownerKey).some((entry) => asOperation(entry.intent).kind === "capture");
      if (!capturePending && noteBodyHasContent(session.getSnapshot(ref).document.body)) {
        enqueue({ kind: "capture", localDate: daily.localDate, noteId: activeDraft.noteId, clientMutationId: activeDraft.clientMutationId });
      }
    }
  };
  const selection = useCallback(({ occurrenceId, selection: next }: { occurrenceId: string; selection: NoteBodySelection }) => {
    session.selection(noteRefFor(occurrenceId), viewIdFor(occurrenceId), next);
  }, [noteRefFor, session, viewIdFor]);
  const boundary = useCallback((occurrenceId: string) => {
    session.boundary(noteRefFor(occurrenceId), viewIdFor(occurrenceId));
  }, [noteRefFor, session, viewIdFor]);
  const undo = useCallback((occurrenceId: string) => {
    const selected = session.undo(noteRefFor(occurrenceId), viewIdFor(occurrenceId));
    if (selected) selectionRef.current.set(viewIdFor(occurrenceId), { token: ++tokenRef.current, selection: selected });
    publishOwner();
  }, [noteRefFor, publishOwner, session, viewIdFor]);
  const redo = useCallback((occurrenceId: string) => {
    const selected = session.redo(noteRefFor(occurrenceId), viewIdFor(occurrenceId));
    if (selected) selectionRef.current.set(viewIdFor(occurrenceId), { token: ++tokenRef.current, selection: selected });
    publishOwner();
  }, [noteRefFor, publishOwner, session, viewIdFor]);

  function prepareOperation(raw: unknown): FrozenRequest {
    const operation = asOperation(raw);
    if (operation.kind === "capture") {
      const ref = draftNoteRef(operation.noteId);
      const body = session.getSnapshot(ref).document.body;
      return {
        path: ("/api/notes/daily/" + operation.localDate + "/captures") as FrozenRequest["path"],
        method: "POST",
        body: JSON.stringify({ clientMutationId: operation.clientMutationId, noteId: operation.noteId, bodyPmJson: body.bodyPmJson }),
      };
    }
    const ack = acknowledgedRef.current;
    if (!ack || ack.source.item.ref !== operation.sourceRef) throw new Error("surface owner changed before mutation");
    if (operation.kind === "title") {
      return prepareResourceSurfaceTitle({
        sourceRef: operation.sourceRef,
        clientMutationId: operation.clientMutationId,
        baseVersion: resourceSurfaceLaneVersion(ack.source.item, "title"),
        title: operation.title,
      });
    }
    const command = materializeResourceSurfaceIntent(ack, operation.intent);
    if (!command) throw new Error("queued surface command no longer matches resource order");
    const baseVersions: Array<{ ref: string; lane: "outgoing_edges" | "body"; version: number }> = [{ ref: operation.sourceRef, lane: "outgoing_edges", version: resourceSurfaceLaneVersion(ack.source.item, "outgoing_edges") }];
    if (command.type === "split_note") {
      const row = ack.orderedItems.find((item) => item.occurrenceId === command.occurrenceId);
      if (!row) throw new Error("split target no longer exists");
      baseVersions.push({ ref: row.target.item.ref, lane: "body", version: session.bodyVersion(row.target.item.ref) ?? resourceSurfaceLaneVersion(row.target.item, "body") });
    }
    return prepareResourceSurfaceCommand({
      sourceRef: operation.sourceRef,
      clientMutationId: operation.intent.clientMutationId,
      baseVersions,
      command,
    });
  }

  function onOperationAck(id: string, raw: unknown, data: unknown): void {
    const operation = asOperation(raw);
    if (owner.failure !== "storage_failed") owner.failure = null;
    if (owner.failure !== "storage_failed" &&
        !session.pendingOperations(ownerKey).some((entry) => entry.id !== id)) {
      owner.retained = true;
    }
    if (operation.kind === "capture") {
      const result = decodeDailyCaptureResult(data);
      if (result.localDate !== operation.localDate || result.clientMutationId !== operation.clientMutationId) throw new TypeError("daily capture acknowledgement identity mismatch");
      acceptSurface(result.surface, "page:" + result.pageId);
      const captured = surfaceBody(result.surface, draftNoteRef(operation.noteId));
      if (!captured) throw new TypeError("daily capture omitted its note body");
      session.acknowledgeExternalBody(draftNoteRef(operation.noteId), captured);
      if (daily && !clearDailyDraft(daily.accountId, daily.localDate)) {
        owner.retained = false;
        owner.failure = "storage_failed";
      }
      dailyDraftRef.current = null;
      publishOwner();
      return;
    }
    const previous = acknowledgedRef.current;
    if (!previous) throw new Error("surface owner disappeared during acknowledgement");
    if (operation.kind === "title") {
      const item = decodeResourceSurfaceTitle(data);
      acceptSurface({
        ...previous,
        source: {
          ...previous.source,
          item,
          content: previous.source.content.kind === "page_title"
            ? { kind: "page_title", title: operation.title }
            : previous.source.content,
        },
      }, sourceRefRef.current);
      return;
    }
    const next = decodeResourceSurfaceCommand(data);
    const remaining = session.pendingOperations(ownerKey).filter((entry) => entry.id !== id && asOperation(entry.intent).kind === "graph");
    const rebound = rebindAcknowledgedResourceSurfaceIntents({
      previousSurface: previous,
      acknowledgedSurface: next,
      completedIntent: operation.intent,
      remainingIntents: remaining.map((entry) => (asOperation(entry.intent) as Extract<SurfaceOperation, { kind: "graph" }>).intent),
    });
    remaining.forEach((entry, index) => {
      if (!session.replaceOperation(entry.id, { kind: "graph", sourceRef: operation.sourceRef, intent: rebound[index]! })) {
        owner.retained = false;
        owner.failure = "storage_failed";
      }
    });
    acceptSurface(next, sourceRefRef.current);
    const command = operation.intent.command;
    if (command.type === "insert_note" || command.type === "split_note") {
      const created = surfaceBody(next, draftNoteRef(command.noteId));
      if (!created) throw new TypeError("surface insertion omitted its note body");
      session.acknowledgeExternalBody(draftNoteRef(command.noteId), created);
    }
    if (command.type === "split_note") {
      const before = previous.orderedItems.find((row) => row.occurrenceId === command.occurrenceId);
      if (!before) throw new Error("split source disappeared");
      const left = surfaceBody(next, before.target.item.ref);
      if (!left) throw new TypeError("split acknowledgement omitted left body");
      session.acknowledgeExternalBody(before.target.item.ref, left);
    }
    publishOwner();
  }

  function onOperationError(error: unknown): void {
    if (error instanceof WritingStorageError) {
      owner.failure = "storage_failed";
      owner.retained = false;
      publishOwner();
      return;
    }
    if (handleUnauthenticatedApiError(error)) return;
    owner.failure = isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
      ? "conflict"
      : error instanceof WritingUnknownOutcomeError ||
          isApiError(error) && (error.code === "E_NETWORK" || error.status >= 500 || error.status === 0) ||
          error instanceof Error && error.name === "AbortError"
        ? "network_failed"
        : "server_failed";
    inputRef.current.onError?.(error);
    publishOwner();
  }

  function enqueue(operation: SurfaceOperation): string {
    const key = operation.kind === "capture" ? "capture:" + ownerKey : operation.kind + ":" + operation.sourceRef;
    let lease: MountedEditorMutationLease | null = null;
    const result = session.enqueueOperation({
      ownerKey,
      key,
      intent: operation,
      prepare: (raw) => {
        const request = prepareOperation(raw);
        if (asOperation(raw).kind === "title") lease = inputRef.current.onTitleMutationStarted?.() ?? null;
        return request;
      },
      onAck: (data) => {
        const submitted = session.pendingOperations(ownerKey).find((entry) => entry.id === result.id);
        if (!submitted) throw new Error("submitted surface operation disappeared");
        onOperationAck(result.id, submitted.intent, data);
        void lease?.committed();
      },
      onError: (error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500 && error.code !== "E_NETWORK") {
          lease?.failed();
          lease = null;
        }
        onOperationError(error);
      },
    });
    owner.retained &&= result.retained;
    if (!result.retained) owner.failure = "storage_failed";
    publishOwner();
    return result.id;
  }

  enqueueRef.current = enqueue;
  useEffect(() => {
    if (!dailyAccountId || !dailyLocalDate || incomingDraft === undefined) return;
    dailyDraftRef.current = incomingDraft;
    publishOwner();
  }, [dailyAccountId, dailyLocalDate, incomingDraft, publishOwner]);

  useEffect(() => {
    if (!dailyAccountId || !dailyLocalDate || !delivery || deliveredIdsRef.current.has(delivery.activationId)) return;
    if (dailyStorageUnavailable) return;
    const current = inputRef.current;
    if (!("daily" in current)) return;
    deliveredIdsRef.current.add(delivery.activationId);
    let next = dailyDraftRef.current ?? createDailyDraft({ accountId: dailyAccountId, localDate: dailyLocalDate }, delivery.entry.noteId, delivery.entry.clientMutationId);
    let changed = dailyDraftRef.current === null;
    if (next.noteId !== delivery.entry.noteId || next.clientMutationId !== delivery.entry.clientMutationId) {
      throw new Error("daily delivery identity differs from retained draft");
    }
    if (next.handoff.kind !== "Buffered") {
      if (next.seedBody) {
        const appended = appendDailyDraftText(next, delivery.entry.initialText);
        if (appended.kind === "Unavailable") throw new Error("daily delivery cannot append to an atomic draft");
        next = appended.draft;
        changed = true;
      } else if (delivery.entry.initialText.length > 0) {
        const length = delivery.entry.initialText.length;
        next = {
          ...next,
          handoff: {
            kind: "Buffered",
            handoffId: delivery.activationId,
            text: delivery.entry.initialText,
            selectionStart: length,
            selectionEnd: length,
            composition: "Complete",
          },
        };
        changed = true;
      }
    }
    dailyDraftRef.current = next;
    recoveredPauseRef.current = false;
    if (changed && !writeDailyDraft(next)) {
      owner.retained = false;
      owner.failure = "storage_failed";
    }
    current.onDeliveryClaimed?.(delivery, next.noteId);
    publishOwner();
  }, [dailyAccountId, dailyLocalDate, dailyStorageUnavailable, delivery, owner, publishOwner]);

  useEffect(() => {
    const activeDraft = dailyDraftRef.current;
    if (!dailyAccountId || !dailyLocalDate || !activeDraft || activeDraft.seedBody || !provisionalRef) return;
    const handoff = activeDraft.handoff;
    if (handoff.kind !== "Buffered" || handoff.composition !== "Complete") return;
    const applied = appliedHandoffsRef.current.get(handoff.handoffId);
    if (applied) {
      if (applied.retained) return;
      if (!session.retainInitialBody(provisionalRef)) {
        owner.failure = "storage_failed";
        owner.retained = false;
        return;
      }
      appliedHandoffsRef.current.set(handoff.handoffId, { ...applied, retained: true });
      owner.retained = true;
      owner.failure = null;
      publishOwner();
      return;
    }
    try {
      if (session.listRecovery(ownerKey).some((candidate) => candidate.noteRef === provisionalRef)) return;
    } catch (error) {
      if (!(error instanceof WritingStorageError)) throw error;
      if (owner.failure !== "storage_failed" || owner.retained) {
        owner.failure = "storage_failed";
        owner.retained = false;
        publishOwner();
      }
      return;
    }
    if (!acknowledgedRef.current?.orderedItems.some((row) => row.target.item.ref === provisionalRef) &&
        session.bodyVersion(provisionalRef) === null &&
        session.getSnapshot(provisionalRef).document.revision === 0) return;
    const before = session.getSnapshot(provisionalRef).document.body;
    const after = appendDailyBodyText(before, handoff.text);
    if (after === null) {
      owner.failure = "server_failed";
      inputRef.current.onError?.(new Error("daily text handoff cannot append to an atomic note"));
      publishOwner();
      return;
    }
    const beforePosition = createNoteBodyDoc({ bodyPmJson: before.bodyPmJson }).content.size - 1;
    const afterPosition = createNoteBodyDoc({ bodyPmJson: after.bodyPmJson }).content.size - 1;
    if (handoff.text.length > 0 && !session.edit(provisionalRef, ownerKey + ":handoff", {
      before,
      after,
      selectionBefore: { anchor: beforePosition, head: beforePosition },
      selectionAfter: { anchor: afterPosition, head: afterPosition },
      source: "paste",
    })) return;
    const retained = session.getSnapshot(provisionalRef).localRetained;
    const offset = before.bodyText.length;
    appliedHandoffsRef.current.set(handoff.handoffId, {
      handoff: {
        ...handoff,
        selectionStart: offset + handoff.selectionStart,
        selectionEnd: offset + handoff.selectionEnd,
      },
      retained,
    });
    if (!retained) {
      owner.failure = "storage_failed";
      owner.retained = false;
    }
    publishOwner();
  }, [dailyAccountId, dailyLocalDate, owner, ownerKey, provisionalRef, publishOwner, revision, session]);

  useEffect(() => {
    const activeDraft = dailyDraftRef.current;
    if (!dailyAccountId || !dailyLocalDate || !activeDraft || !provisionalRef || recoveredPauseRef.current ||
        activeDraft.handoff.kind === "Buffered") return;
    if (session.pendingOperations(ownerKey).some((entry) => asOperation(entry.intent).kind === "capture")) return;
    if (!noteBodyHasContent(session.getSnapshot(provisionalRef).document.body)) return;
    enqueueRef.current({
      kind: "capture",
      localDate: dailyLocalDate,
      noteId: activeDraft.noteId,
      clientMutationId: activeDraft.clientMutationId,
    });
  }, [dailyAccountId, dailyLocalDate, ownerKey, provisionalRef, revision, session]);

  useEffect(() => {
    if (!dailyAccountId || !dailyLocalDate) return;
    let cancelled = false;
    void loadDailySurface({ accountId: dailyAccountId, localDate: dailyLocalDate }).then((loaded) => {
      if (cancelled) return;
      dailyTitleRef.current = loaded.title;
      if (session.pendingOperations(ownerKey).length === 0) {
        acceptSurface(
          loaded.kind === "Materialized" ? loaded.surface : null,
          loaded.kind === "Materialized" ? loaded.sourceRef : null,
        );
      }
      publishOwner();
    }).catch((error) => {
      if (cancelled || handleUnauthenticatedApiError(error)) return;
      owner.failure = "server_failed";
      inputRef.current.onError?.(error);
      publishOwner();
    });
    return () => { cancelled = true; };
  }, [acceptSurface, dailyAccountId, dailyLocalDate, owner, ownerKey, publishOwner, session]);

  const updateTitle = (next: string) => {
    const sourceRef = sourceRefRef.current;
    if (!sourceRef) return;
    const pendingTitle = [...session.pendingOperations(ownerKey)].reverse().find((entry) =>
      asOperation(entry.intent).kind === "title" && entry.request === null);
    if (pendingTitle) {
      const previous = asOperation(pendingTitle.intent);
      if (previous.kind === "title") {
        owner.retained = session.replaceOperation(pendingTitle.id, { ...previous, title: next });
        if (!owner.retained) owner.failure = "storage_failed";
      }
    } else {
      enqueue({ kind: "title", sourceRef, title: next, clientMutationId: resourceSurfaceCommandId() });
    }
    publishOwner();
  };

  const command = (next: ResourceSurfaceCommand): string | null => {
    if (daily && !acknowledgedRef.current && next.type === "insert_note") {
      if (dailyStorageUnavailable || dailyDraftRef.current) return null;
      const draft = createDailyDraft(daily, next.noteId, resourceSurfaceCommandId(), next.bodyPmJson);
      dailyDraftRef.current = draft;
      recoveredPauseRef.current = false;
      if (!writeDailyDraft(draft)) {
        owner.retained = false;
        owner.failure = "storage_failed";
      }
      publishOwner();
      return "daily-provisional:" + next.noteId;
    }
    const current = currentSurfaceRef.current;
    const sourceRef = sourceRefRef.current;
    if (!current || !sourceRef) return null;
    const clientMutationId = resourceSurfaceCommandId();
    const intent = createResourceSurfaceIntent({ surface: current, command: next, clientMutationId });
    if (!intent) throw new Error("surface command no longer matches its projected order");
    if (next.type === "split_note") {
      const row = current.orderedItems.find((item) => item.occurrenceId === next.occurrenceId);
      if (!row) throw new Error("split source does not exist");
      session.stageStructuralBody(row.target.item.ref, bodyFromJson(next.leftBodyPmJson));
    }
    enqueue({ kind: "graph", sourceRef, intent });
    return next.type === "insert_note" || next.type === "split_note" || next.type === "insert_resource"
      ? resourceSurfacePendingOccurrenceId(clientMutationId)
      : null;
  };

  const finalizeDailyHandoff = (handoffId: string): void => {
    const activeDraft = dailyDraftRef.current;
    if (!daily || activeDraft?.handoff.kind !== "Buffered" || activeDraft.handoff.handoffId !== handoffId) return;
    const ref = draftNoteRef(activeDraft.noteId);
    if (activeDraft.seedBody) {
      const body = session.getSnapshot(ref).document.body;
      if (noteBodyHasContent(body) && !session.retainInitialBody(ref)) {
        owner.failure = "storage_failed";
        owner.retained = false;
        publishOwner();
        return;
      }
      if (!claimDailyDraftBody(daily.accountId, daily.localDate, activeDraft.noteId)) {
        owner.failure = "storage_failed";
        owner.retained = false;
        publishOwner();
        return;
      }
      dailyDraftRef.current = { ...activeDraft, seedBody: null };
    }
    if (!acknowledgeDailyDraftHandoff(daily.accountId, daily.localDate, handoffId)) {
      owner.failure = "storage_failed";
      owner.retained = false;
      publishOwner();
      return;
    }
    dailyDraftRef.current = { ...dailyDraftRef.current!, handoff: { kind: "None" } };
    pendingHandoffClaimRef.current = null;
    recoveredPauseRef.current = false;
    if (owner.failure === "storage_failed") owner.failure = null;
    owner.retained = true;
    publishOwner();
  };

  const flush = useCallback(() => session.flush(), [session]);
  const retry = () => {
    let recoveredStorage = false;
    for (const entry of session.pendingOperations(ownerKey)) {
      if (entry.paused === null || entry.paused === "conflict") continue;
      const retried = session.retry(entry.id);
      if (entry.paused === "storage" && retried) recoveredStorage = true;
    }
    const current = currentSurfaceRef.current;
    const refs = new Set<string>();
    if (current) {
      if (current.source.content.kind === "note_body") refs.add(current.source.item.ref);
      for (const row of current.orderedItems) {
        if (row.target.content.kind === "note_body") refs.add(row.target.item.ref);
      }
    }
    const activeDraft = dailyDraftRef.current;
    if (activeDraft) refs.add(draftNoteRef(activeDraft.noteId));
    for (const ref of refs) {
      const snapshot = session.getSnapshot(ref);
      if (snapshot.status === "clean" || snapshot.status === "saved" || snapshot.status === "conflict") continue;
      session.retry(ref);
    }
    if (pendingHandoffClaimRef.current) finalizeDailyHandoff(pendingHandoffClaimRef.current);
    if (recoveredStorage &&
        !session.pendingOperations(ownerKey).some((entry) => entry.paused === "storage") &&
        [...refs].every((ref) => session.getSnapshot(ref).localRetained)) {
      owner.retained = true;
      if (owner.failure === "storage_failed") owner.failure = null;
    }
    publishOwner();
  };
  const reload = async () => {
    const graphIntents = session.pendingOperations(ownerKey)
      .map((entry) => asOperation(entry.intent))
      .filter((entry): entry is Extract<SurfaceOperation, { kind: "graph" }> => entry.kind === "graph")
      .map((entry) => entry.intent);
    const acceptReload = (next: ResourceSurface | null, ref: string | null) => {
      if (graphIntents.length) {
        if (!next) {
          owner.failure = "conflict";
          return;
        }
        try {
          projectResourceSurface({ acknowledgedSurface: next, intents: graphIntents, title: undefined, bodies: new Map() });
        } catch {
          owner.failure = "conflict";
          return;
        }
      }
      acceptSurface(next, ref);
    };
    if (daily) {
      const loaded = await loadDailySurface(daily);
      dailyTitleRef.current = loaded.title;
      acceptReload(
        loaded.kind === "Materialized" ? loaded.surface : null,
        loaded.kind === "Materialized" ? loaded.sourceRef : null,
      );
    } else {
      const ref = sourceRefRef.current;
      if (!ref) return;
      acceptReload(await fetchResourceSurface(ref), ref);
    }
    publishOwner();
  };
  const recover = (candidate: RecoveryCandidate): boolean => {
    if (candidate.corrupt || candidate.revision === null || candidate.ownerKey !== ownerKey) return false;
    if (candidate.noteRef) {
      const current = currentSurfaceRef.current;
      const ref = candidate.noteRef;
      if (!current || (current.source.item.ref !== ref && !resourceSurfaceOccurrenceForRef(current, ref) && draftNoteRef(dailyDraftRef.current?.noteId ?? "") !== ref)) return false;
      const result = session.recover(ref, candidate.key, candidate.revision);
      if (result) publishOwner();
      return result;
    }
    if (!candidate.operationId) return false;
    const result = session.recoverOperation(candidate.key, candidate.revision, candidate.operationId);
    if (!result) return false;
    session.attachOperation(candidate.operationId, {
      prepare: prepareOperation,
      onAck: (data) => {
        const operation = session.pendingOperations(ownerKey).find((entry) => entry.id === candidate.operationId);
        if (!operation) throw new Error("recovered surface operation disappeared");
        onOperationAck(candidate.operationId!, operation.intent, data);
      },
      onError: onOperationError,
    });
    publishOwner();
    return true;
  };
  const copyRecovery = useCallback(async () => {
    const current = session.exportCurrentRaw();
    let activeDraft: string | null = null;
    let candidates: RecoveryCandidate[] = [];
    let storageUnavailable = dailyStorageUnavailable;
    try {
      if (daily) activeDraft = readDailyDraftRaw(daily.accountId, daily.localDate);
      candidates = session.listRecovery(ownerKey);
    } catch (error) {
      if (!(error instanceof DailyDraftStorageError || error instanceof WritingStorageError)) throw error;
      storageUnavailable = true;
    }
    const visible = currentSurfaceRef.current;
    const refs = new Set<string>();
    if (visible?.source.content.kind === "note_body") refs.add(visible.source.item.ref);
    for (const row of visible?.orderedItems ?? []) {
      if (row.target.content.kind === "note_body") refs.add(row.target.item.ref);
    }
    if (dailyDraftRef.current) refs.add(draftNoteRef(dailyDraftRef.current.noteId));
    const visibleBodies = [...refs].map((noteRef) => {
      const snapshot = session.getSnapshot(noteRef);
      return { noteRef, ...snapshot.document.body, status: snapshot.status, localRetained: snapshot.localRetained };
    });
    const conflicts = [...refs].flatMap((ref) => {
      const conflict = session.getSnapshot(ref).conflict;
      return conflict ? [{ noteRef: ref, ...conflict }] : [];
    });
    await copyText(JSON.stringify({ current, activeDraft, candidates, visibleBodies, conflicts, storageUnavailable }, null, 2));
  }, [daily, dailyStorageUnavailable, ownerKey, session]);

  useEffect(() => {
    const flushOnHidden = () => { if (document.visibilityState === "hidden") session.flush(); };
    document.addEventListener("visibilitychange", flushOnHidden);
    const flushOnPageHide = () => session.flush();
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      session.flush();
    };
  }, [session]);

  const provisional = provisionalRef
    ? {
        occurrenceId: "daily-provisional:" + draft!.noteId,
        noteRef: provisionalRef,
        ...session.getSnapshot(provisionalRef).document.body,
      }
    : null;
  const bodyRefs = new Set<string>();
  if (surface) {
    if (surface.source.content.kind === "note_body") bodyRefs.add(surface.source.item.ref);
    for (const row of surface.orderedItems) if (row.target.content.kind === "note_body") bodyRefs.add(row.target.item.ref);
  }
  if (provisionalRef) bodyRefs.add(provisionalRef);
  let status: WritingStatus = owner.failure ?? "clean";
  let localRetained = owner.retained;
  for (const ref of bodyRefs) {
    const snapshot = session.getSnapshot(ref);
    localRetained &&= snapshot.localRetained;
    if (snapshot.status === "conflict" || snapshot.status === "storage_failed") status = snapshot.status;
    else if (status === "clean" && snapshot.status !== "clean" && snapshot.status !== "saved") status = snapshot.status;
  }
  if (!localRetained || pending.some((entry) => entry.paused === "storage")) {
    status = "storage_failed";
    localRetained = false;
  } else if (pending.some((entry) => entry.paused === "conflict")) {
    status = "conflict";
  } else if (pending.some((entry) => entry.paused === "network") &&
             status !== "conflict") {
    status = "network_failed";
  } else if (pending.some((entry) => entry.paused === "server") &&
             status !== "conflict" && status !== "network_failed") {
    status = "server_failed";
  }
  if (status === "clean" && pending.length) status = "dirty";
  let recoveryCandidates: RecoveryCandidate[] = [];
  let storageUnavailable = dailyStorageUnavailable;
  let unreadableDailyDraft = false;
  try {
    recoveryCandidates = session.listRecovery(ownerKey);
    if (daily) {
      const raw = readDailyDraftRaw(daily.accountId, daily.localDate);
      unreadableDailyDraft = Boolean(raw && !readDailyDraft(daily.accountId, daily.localDate));
    }
  } catch (error) {
    if (!(error instanceof DailyDraftStorageError || error instanceof WritingStorageError)) throw error;
    storageUnavailable = true;
  }
  const hasRecoveredDraft = recoveryCandidates.length > 0 || recoveredPauseRef.current || unreadableDailyDraft;
  if (storageUnavailable) { status = "storage_failed"; localRetained = false; }
  else if (status === "clean" && hasRecoveredDraft) status = "recovered";
  const shared = {
    status, localRetained, hasRecoveredDraft, recoveryCandidates, recover,
    bodyDocument, restoreSelection, editBody, selection, boundary, undo, redo,
    updateTitle, command, flush, retry, reload, copyRecovery,
  };
  if (daily) {
    return {
      ...shared,
      surface,
      title: surface?.source.content.kind === "page_title" ? surface.source.content.title : dailyTitleRef.current,
      provisional,
      inputHandoff: draft?.handoff.kind === "Buffered" && draft.seedBody === null
        ? appliedHandoffsRef.current.get(draft.handoff.handoffId)?.retained
          ? appliedHandoffsRef.current.get(draft.handoff.handoffId)!.handoff
          : { kind: "None" }
        : draft?.handoff ?? { kind: "None" },
      acknowledgeInputHandoff: (handoffId: string) => {
        pendingHandoffClaimRef.current = handoffId;
        finalizeDailyHandoff(handoffId);
      },
    };
  }
  if (!surface) throw new Error("persisted resource surface requires a surface");
  return { ...shared, surface };
}
