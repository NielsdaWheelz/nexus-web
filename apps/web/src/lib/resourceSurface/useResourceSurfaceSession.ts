"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { NoteBodyEdit, NoteBodyEditorDocument, NoteBodySelection } from "@/components/notes/NoteBodyEditor";
import { isApiError } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
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
import { acceptDailyCaptureResult } from "@/lib/notes/api";
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
  type OperationCallbacks,
  type RecoveryCandidate,
  type WritingStatus,
} from "@/lib/notes/writingSession";
import { subscribeLinkMutations, type LinkMutation } from "@/lib/resourceGraph/links";
import { resolveResourceLocator } from "@/lib/resources/resourceLocators";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { copyText } from "@/lib/ui/copyText";
import type { ResourceSurface, ResourceSurfaceNode } from "@/lib/resources/resourceItems";
import {
  acceptResourceSurfaceCommand,
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
  provisionalDailyOccurrence,
  type DailySurfaceSessionOptions,
} from "@/lib/resourceSurface/dailySurfacePersistence";
import {
  type ResourceSurfaceDraftIntent,
  type ResourceSurfacePendingBody,
  type ResourceSurfacePendingTitle,
} from "@/lib/resourceSurface/draftStore";
import {
  createResourceSurfaceIntent,
  projectSurfaceGraph,
  remapSurfaceIntent,
  surfacePathKey,
  surfaceIntentBodyRefs,
  type SurfaceContext,
  resourceSurfaceLaneVersion,
  surfaceLinkForTarget,
  pendingSurfaceLinkId,
  type ResourceSurfaceCommand,
} from "@/lib/resourceSurface/model";
import { createOutlineViewState, createResourceOutline, outlineRows, type ResourceOutline, type OutlineRow, type NeighborhoodLoad } from "./outline";
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

type SharedGraph = { lastLinkMutation: LinkMutation | null; nodes: Map<string, ResourceSurfaceNode>; surfaces: Map<string, ResourceSurface>; loads: Map<string, NeighborhoodLoad>; requests: Map<string, Promise<void>> };
const graphOwners = new Map<string, SharedGraph>();
function newestSurfaceNode(current: ResourceSurfaceNode | undefined, next: ResourceSurfaceNode): ResourceSurfaceNode {
  if (!current) return next;
  const versions = { ...next.item.versionByLane };
  for (const [lane, version] of Object.entries(current.item.versionByLane)) versions[lane] = Math.max(version, versions[lane] ?? 0);
  const lane = next.content.kind === "note_body" ? "body" : next.content.kind === "page_title" ? "title" : null;
  const older = lane
    ? (current.item.versionByLane[lane] ?? 0) > (next.item.versionByLane[lane] ?? 0)
    : Object.entries(current.item.versionByLane).some(([key, version]) => version > (next.item.versionByLane[key] ?? 0));
  const value = older ? current : next;
  return { ...value, item: { ...value.item, versionByLane: versions } };
}
function acceptGraphNode(graph: SharedGraph, node: ResourceSurfaceNode): ResourceSurfaceNode {
  const ref = node.item.ref;
  const next = newestSurfaceNode(graph.nodes.get(ref) ?? graph.surfaces.get(ref)?.source, node);
  graph.nodes.set(ref, next);
  for (const [endpoint, surface] of graph.surfaces) {
    // A node's newer links version does not refresh this adjacency snapshot.
    const source = endpoint === ref ? { ...next, item: { ...next.item, versionByLane: { ...next.item.versionByLane, links: resourceSurfaceLaneVersion(surface.source.item, "links") } } } : surface.source;
    graph.surfaces.set(endpoint, { source, orderedItems: surface.orderedItems.map((row) => row.target.item.ref === ref ? { ...row, target: next } : row) });
  }
  return next;
}
function acceptGraphSurface(graph: SharedGraph, next: ResourceSurface): ResourceSurface {
  const ref = next.source.item.ref;
  const linksVersion = resourceSurfaceLaneVersion(next.source.item, "links");
  for (const node of [next.source, ...next.orderedItems.map((row) => row.target)]) acceptGraphNode(graph, node);
  const current = graph.surfaces.get(ref);
  if (current && resourceSurfaceLaneVersion(current.source.item, "links") > linksVersion) return current;
  const source = graph.nodes.get(ref)!;
  next = {
    source: { ...source, item: { ...source.item, versionByLane: { ...source.item.versionByLane, links: linksVersion } } },
    orderedItems: next.orderedItems.map((row) => ({ ...row, target: graph.nodes.get(row.target.item.ref)! })),
  };
  graph.surfaces.set(ref, next);
  return next;
}


type SharedSurfaceOwner = {
  graph: SharedGraph;
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
  let graph = graphOwners.get(accountId);
  if (!graph) { graph = { lastLinkMutation: null, nodes: new Map(), surfaces: new Map(), loads: new Map(), requests: new Map() }; graphOwners.set(accountId, graph); }
  if (surface && !graph.surfaces.has(surface.source.item.ref)) acceptGraphSurface(graph, surface);
  if (typeof window === "undefined") {
    return { graph, surface, sourceRef, listeners: new Set(), failure: null, retained: true };
  }
  const key = accountId + ":" + ownerKey;
  let owner = surfaceOwners.get(key);
  if (!owner) {
    owner = { graph, surface, sourceRef, listeners: new Set(), failure: null, retained: true };
    surfaceOwners.set(key, owner);
  }
  return owner;
}

export interface ResourceSurfaceSession {
  outline: ResourceOutline;
  surface: ResourceSurface;
  status: WritingStatus;
  localRetained: boolean;
  hasRecoveredDraft: boolean;
  recoveryCandidates: readonly RecoveryCandidate[];
  recover(candidate: RecoveryCandidate): Promise<boolean>;
  bodyDocument(occurrenceId: string): NoteBodyEditorDocument;
  restoreSelection(occurrenceId: string): RestoreSelection | undefined;
  editBody(input: { occurrenceId: string; edit: NoteBodyEdit }): void;
  selection(input: { occurrenceId: string; selection: NoteBodySelection }): void;
  boundary(occurrenceId: string): void;
  undo(occurrenceId: string): void;
  redo(occurrenceId: string): void;
  updateTitle(title: string): void;
  command(command: ResourceSurfaceCommand, context?: SurfaceContext): string | null;
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
    : surfaceLinkForTarget(surface, noteRef)?.target;
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
      owner.surface = acceptGraphSurface(owner.graph, mounted);
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
  const outlineView = useRef(createOutlineViewState());
  const projectedGraphRef = useRef(new Map(owner.graph.surfaces));
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
      owner.surface = owner.sourceRef ? owner.graph.surfaces.get(owner.sourceRef) ?? owner.surface : owner.surface;
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
    if (next) next = acceptGraphSurface(owner.graph, next);
    owner.surface = next;
    owner.sourceRef = nextSourceRef;
    acknowledgedRef.current = next;
    sourceRefRef.current = nextSourceRef;
    for (const listener of owner.listeners) listener();
  }, [owner]);
  const publishOwner = useCallback(() => {
    for (const candidate of surfaceOwners.values()) if (candidate.graph === owner.graph) for (const listener of candidate.listeners) listener();
  }, [owner]);

  const loadNeighborhood = useCallback(async (ref: string, refresh = false): Promise<void> => {
    if (!refresh && owner.graph.surfaces.has(ref) && owner.graph.loads.get(ref)?.kind !== "error") return;
    const pending = owner.graph.requests.get(ref);
    if (pending && !refresh) return pending;
    owner.graph.loads.set(ref, { kind: "loading" }); publishOwner();
    const fetch = () => fetchResourceSurface(ref).then((surface) => {
      const accepted = acceptGraphSurface(owner.graph, surface);
      projectedGraphRef.current.set(ref, accepted);
      owner.graph.loads.delete(ref);
    }).catch((error: unknown) => { owner.graph.loads.set(ref, { kind: "error", error }); throw error; });
    // A read started before an acknowledged generic link mutation cannot satisfy
    // that mutation's refresh. Wait for it to settle, then issue a fresh read.
    const request = (pending ? pending.then(fetch, fetch) : fetch()).finally(() => {
      if (owner.graph.requests.get(ref) === request) owner.graph.requests.delete(ref);
      publishOwner();
    });
    owner.graph.requests.set(ref, request);
    await request;
  }, [owner, publishOwner]);

  useEffect(() => subscribeLinkMutations((mutation) => {
    if (owner.graph.lastLinkMutation === mutation) return;
    owner.graph.lastLinkMutation = mutation;
    const refs = mutation.kind === "created"
      ? [mutation.sourceRef, mutation.targetRef].filter((ref) => owner.graph.surfaces.has(ref) || owner.graph.requests.has(ref))
      : [...new Set([
          ...[...owner.graph.surfaces].filter(([, surface]) => surface.orderedItems.some((row) => row.linkId === mutation.linkId)).map(([ref]) => ref),
          ...owner.graph.requests.keys(),
        ])];
    for (const ref of refs) void loadNeighborhood(ref, true).catch((error: unknown) => inputRef.current.onError?.(error));
  }), [loadNeighborhood, owner]);

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
    const open = (node: ResourceSurfaceNode, fresh: boolean) => {
      if (node.content.kind !== "note_body" || bodyMap.has(node.item.ref)) return;
      session.openBody({ noteRef: node.item.ref, ownerKey,
        initial: { body: bodyFromJson(node.content.bodyPmJson), version: fresh ? null : resourceSurfaceLaneVersion(node.item, "body") },
        adapter: noteBodyAdapter(), awaitExternalCreation: fresh,
        onError: (error) => inputRef.current.onError?.(error),
        ...(node.item.ref === acknowledged?.source.item.ref ? { onMutationStarted: () => inputRef.current.onSourceBodyMutationStarted?.() ?? null } : {}),
      });
      const body = session.getSnapshot(node.item.ref).document.body;
      bodyMap.set(node.item.ref, { ...body, clientMutationId: "" });
    };
    for (const cached of owner.graph.surfaces.values()) {
      open(cached.source, false);
      for (const row of cached.orderedItems) open(row.target, false);
    }
    const projectionBase = new Map([...owner.graph.surfaces, ...(graph[0]?.baseSurfaces ?? []).map((surface) => [surface.source.item.ref, surface] as const)]);
    let projected = projectSurfaceGraph(projectionBase, graph, bodyMap);
    for (const cached of projected.values()) {
      open(cached.source, !owner.graph.surfaces.has(cached.source.item.ref) && ![...owner.graph.surfaces.values()].some((surface) => surface.orderedItems.some((row) => row.target.item.ref === cached.source.item.ref)));
      for (const row of cached.orderedItems) open(row.target, row.linkId.startsWith("pending:"));
    }
    projected = projectSurfaceGraph(projectionBase, graph, bodyMap);
    projectedGraphRef.current = projected;
    let surface = acknowledged ? projected.get(acknowledged.source.item.ref) ?? null : null;
    if (surface && title && surface.source.content.kind === "page_title") surface = { ...surface, source: { ...surface.source, content: { kind: "page_title", title: title.value } } };
    return { pending, surface };
  }, [acknowledged, owner, ownerKey, revision, session]);
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
    const row = current ? outlineRows(current.source.item.ref, projectedGraphRef.current, outlineView.current, owner.graph.loads).find((item) => item.occurrenceId === occurrenceId) : undefined;
    if (row?.target.content.kind === "note_body" && !row.terminal) return row.target.item.ref;
    const activeDraft = dailyDraftRef.current;
    if (activeDraft && occurrenceId === "daily-provisional:" + activeDraft.noteId) return draftNoteRef(activeDraft.noteId);
    throw new Error("note body occurrence is unavailable");
  }, [owner]);
  const viewIdFor = useCallback((occurrenceId: string) => ownerKey + ":" + occurrenceId, [ownerKey]);

  const bodyDocument = useCallback((occurrenceId: string) =>
    session.getSnapshot(noteRefFor(occurrenceId)).document, [noteRefFor, session]);
  const restoreSelection = useCallback((occurrenceId: string) =>
    selectionRef.current.get(viewIdFor(occurrenceId)), [viewIdFor]);
  const editBody = ({ occurrenceId, edit }: { occurrenceId: string; edit: NoteBodyEdit }) => {
    const ref = noteRefFor(occurrenceId);
    if (!session.edit(ref, occurrenceId, edit, ownerKey)) {
      publishOwner();
      return;
    }
    outlineView.current.selection = { kind: "text", occurrenceId, ...edit.selectionAfter };
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
    session.surfaceBoundary(ownerKey);
    outlineView.current.selection = { kind: "text", occurrenceId, ...next };
  }, [ownerKey, session]);
  const boundary = useCallback((_occurrenceId: string) => { session.surfaceBoundary(ownerKey); }, [ownerKey, session]);
  const revealHistoryOccurrence = (id: string) => {
    if (!id.startsWith("[")) return;
    const [rootRef, ...links] = JSON.parse(id) as string[];
    if (!rootRef) throw new Error("History appearance has no root");
    for (let depth = 1; depth < links.length; depth += 1) outlineView.current.folds.set(surfacePathKey({ rootRef, linkPath: links.slice(0, depth) }), false);
    const focused = outlineView.current.focusedPath;
    if (focused && !focused.linkPath.every((link, index) => links[index] === link)) outlineView.current.focusedPath = null;
  };
  const changeHistory = (redo: boolean) => {
    const item = session.surfaceUndo(ownerKey, redo);
    if (!item) return;
    if (item.kind === "body") {
      revealHistoryOccurrence(item.occurrenceId);
      outlineView.current.selection = { kind: "text", occurrenceId: item.occurrenceId, ...(redo ? item.edit.selectionAfter : item.edit.selectionBefore) };
      selectionRef.current.set(viewIdFor(item.occurrenceId), { token: ++tokenRef.current, selection: redo ? item.edit.selectionAfter : item.edit.selectionBefore });
      outlineView.current.focusRequest = { occurrenceId: item.occurrenceId, serial: ++tokenRef.current };
    } else {
      const before = item.before as ResourceSurface[];
      const after = item.after as ResourceSurface[];
      const ref = sourceRefRef.current;
      if (!ref) return;
      const mutationId = resourceSurfaceCommandId();
      const intent: ResourceSurfaceDraftIntent = { clientMutationId: mutationId, endpointRef: ref, context: { rootRef: ref, linkPath: [] }, command: { type: "reverse_edit", receiptId: item.receiptId ?? item.mutationId }, bodyEdits: [], baseSurfaces: [...projectedGraphRef.current.values()], inverseSurfaces: redo ? after : before, reversesMutationId: item.mutationId, reverseVersions: item.reverseVersions };
      const restoredBodies = new Map<string, NoteBodyValue>();
      for (const restored of intent.inverseSurfaces!) for (const node of [restored.source, ...restored.orderedItems.map((link) => link.target)]) {
        if (node.content.kind === "note_body" && item.bodyRefs.includes(node.item.ref) && session.peekSnapshot(node.item.ref)) restoredBodies.set(node.item.ref, bodyFromJson(node.content.bodyPmJson));
      }
      for (const [ref, body] of restoredBodies) session.stageStructuralBody(ref, body);
      session.updateStructureFrontier(item, mutationId);
      enqueue({ kind: "graph", sourceRef: ref, intent });
      const selection = redo ? item.selectionAfter : item.selectionBefore;
      outlineView.current.selection = selection;
      if (selection?.kind === "text") {
        revealHistoryOccurrence(selection.occurrenceId);
        outlineView.current.focusRequest = { occurrenceId: selection.occurrenceId, serial: ++tokenRef.current };
        selectionRef.current.set(viewIdFor(selection.occurrenceId), { token: ++tokenRef.current, selection: { anchor: selection.anchor, head: selection.head } });
      }
    }
    publishOwner();
  };
  const undo = (_occurrenceId: string) => changeHistory(false);
  const redo = (_occurrenceId: string) => changeHistory(true);

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
    const ack = owner.graph.surfaces.get(operation.sourceRef);
    if (!ack) throw new Error("Command endpoint has not loaded");
    if (operation.kind === "title") return prepareResourceSurfaceTitle({ sourceRef: operation.sourceRef, clientMutationId: operation.clientMutationId, baseVersion: resourceSurfaceLaneVersion(ack.source.item, "title"), title: operation.title });
    const intent = operation.intent;
    const versions = new Map<string, { ref: string; lane: "links" | "body" | "title"; version: number }>();
    const node = (ref: string) => owner.graph.nodes.get(ref) ?? owner.graph.surfaces.get(ref)?.source ?? [...owner.graph.surfaces.values()].flatMap((surface) => surface.orderedItems).find((row) => row.target.item.ref === ref)?.target;
    const add = (ref: string, lane: "links" | "body" | "title") => {
      const current = node(ref);
      if (!current) throw new Error("Versioned resource has not loaded");
      const version = lane === "body" && session.peekSnapshot(ref) ? session.bodyVersion(ref)! : resourceSurfaceLaneVersion(current.item, lane);
      versions.set(ref + ":" + lane, { ref, lane, version });
    };
    const path = (context: SurfaceContext) => {
      let ref = context.rootRef; add(ref, "links");
      for (const linkId of context.linkPath) {
        const link = owner.graph.surfaces.get(ref)?.orderedItems.find((row) => row.linkId === linkId);
        if (!link) throw new Error("Command path is stale");
        ref = link.target.item.ref; add(ref, "links");
      }
      return ref;
    };
    path(intent.context); add(operation.sourceRef, "links");
    const linkTarget = (ref: string, linkId: string) => {
      const link = owner.graph.surfaces.get(ref)?.orderedItems.find((row) => row.linkId === linkId);
      if (!link) throw new Error("Command link is no longer incident");
      return link.target.item.ref;
    };
    const command = intent.command;
    switch (command.type) {
      case "split_note": add(linkTarget(operation.sourceRef, command.linkId), "body"); break;
      case "insert_resource": add(command.targetRef, "links"); break;
      case "relink": add(linkTarget(operation.sourceRef, command.linkId), "links"); add(command.destinationRef, "links"); break;
      case "remove_occurrence": for (const entry of command.entries) { path(entry.context); add(entry.endpointRef, "links"); add(linkTarget(entry.endpointRef, entry.linkId), "links"); } break;
      case "join_notes": add(linkTarget(operation.sourceRef, command.earlierLinkId), "body"); add(linkTarget(operation.sourceRef, command.laterLinkId), "body"); add(linkTarget(operation.sourceRef, command.laterLinkId), "links"); break;
      case "reverse_edit": if (!intent.reverseVersions) throw new Error("Inverse receipt has not settled"); for (const version of intent.reverseVersions) add(version.ref, version.lane); break;
      case "insert_note": case "move_occurrence": case "paste_outline": break;
    }
    for (const edit of intent.bodyEdits) add(edit.ref, "body");
    return prepareResourceSurfaceCommand({ sourceRef: operation.sourceRef, clientMutationId: intent.clientMutationId, baseVersions: [...versions.values()], command, context: intent.context, bodyEdits: intent.bodyEdits });
  }

  function currentOperation(id: string): SurfaceOperation {
    const pending = session.pendingOperations(ownerKey).find((entry) => entry.id === id);
    if (!pending) throw new Error("submitted surface operation disappeared");
    return asOperation(pending.intent);
  }

  function beginAcknowledgement(id: string): SurfaceOperation {
    const operation = currentOperation(id);
    if (owner.failure !== "storage_failed") owner.failure = null;
    if (owner.failure !== "storage_failed" &&
        !session.pendingOperations(ownerKey).some((entry) => entry.id !== id)) {
      owner.retained = true;
    }
    return operation;
  }

  function acknowledgeCapture(id: string, data: ApiJson<"/notes/daily/{local_date}/captures", "post">["data"]): void {
    const operation = beginAcknowledgement(id);
    if (operation.kind !== "capture") throw new Error("submitted operation is not a capture");
    const result = acceptDailyCaptureResult(data);
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
  }

  function acknowledgeTitle(id: string, data: ApiJson<"/resource-items/{resource_ref}/title", "patch">["data"]): void {
    const operation = beginAcknowledgement(id);
    if (operation.kind !== "title") throw new Error("submitted operation is not a title edit");
    const previous = acknowledgedRef.current;
    if (!previous) throw new Error("surface owner disappeared during acknowledgement");
    acceptSurface({
      ...previous,
      source: {
        ...previous.source,
        item: data.item,
        content: previous.source.content.kind === "page_title"
          ? { kind: "page_title", title: operation.title }
          : previous.source.content,
      },
    }, sourceRefRef.current);
  }

  function acknowledgeGraph(id: string, data: ApiJson<"/resource-items/{resource_ref}/surface/commands", "post">["data"]): void {
    const operation = beginAcknowledgement(id);
    if (operation.kind !== "graph") throw new Error("submitted operation is not a graph edit");
    const previous = acknowledgedRef.current;
    if (!previous) throw new Error("surface owner disappeared during acknowledgement");
    const receipt = acceptResourceSurfaceCommand(data);
    if (receipt.clientMutationId !== operation.intent.clientMutationId) throw new TypeError("Surface receipt mutation identity mismatch");
    const local = projectSurfaceGraph(new Map(operation.intent.baseSurfaces.map((surface) => [surface.source.item.ref, surface])), [operation.intent]);
    const mapping = new Map<string, string>();
    for (const next of receipt.surfaces) {
      for (const row of local.get(next.source.item.ref)?.orderedItems ?? []) {
        if (!row.linkId.startsWith("pending:")) continue;
        const committed = next.orderedItems.find((candidate) => candidate.target.item.ref === row.target.item.ref);
        if (committed) mapping.set(row.linkId, committed.linkId);
      }
      acceptGraphSurface(owner.graph, next);
    }
    const laterBodyRefs = new Set(session.pendingOperations(ownerKey).filter((entry) => entry.id !== id).flatMap((entry) => {
      const next = asOperation(entry.intent);
      return next.kind === "graph" ? [...surfaceIntentBodyRefs(next.intent)] : [];
    }));
    for (const node of receipt.nodes) {
      acceptGraphNode(owner.graph, node);
      if (node.content.kind === "note_body" && session.peekSnapshot(node.item.ref)) session.acknowledgeExternalBody(node.item.ref, { body: bodyFromJson(node.content.bodyPmJson), version: resourceSurfaceLaneVersion(node.item, "body") }, laterBodyRefs.has(node.item.ref));
    }
    for (const entry of session.pendingOperations(ownerKey)) {
      if (entry.id === id) continue;
      const remaining = asOperation(entry.intent);
      if (remaining.kind !== "graph") continue;
      let intent = remapSurfaceIntent(remaining.intent, mapping);
      if (intent.reversesMutationId === receipt.clientMutationId && intent.command.type === "reverse_edit") intent = { ...intent, command: { type: "reverse_edit", receiptId: receipt.receiptId }, reverseVersions: receipt.reverseVersions };
      if (!session.replaceOperation(entry.id, { ...remaining, intent })) { owner.retained = false; owner.failure = "storage_failed"; }
    }
    const remapKey = (key: string) => { if (!key.startsWith("[")) return key; const parts = JSON.parse(key) as string[]; return JSON.stringify(parts.map((part) => mapping.get(part) ?? part)); };
    const remapSnapshot = (surfaces: ResourceSurface[]) => surfaces.map((surface) => ({ ...surface, orderedItems: surface.orderedItems.map((row) => ({ ...row, linkId: mapping.get(row.linkId) ?? row.linkId })) }));
    session.rewriteSurfaceHistory(ownerKey, (item) => {
      if (item.kind === "body") item.occurrenceId = remapKey(item.occurrenceId);
      else {
        item.before = remapSnapshot(item.before as ResourceSurface[]); item.after = remapSnapshot(item.after as ResourceSurface[]);
        for (const key of ["selectionBefore", "selectionAfter"] as const) {
          const selection = item[key];
          if (selection?.kind === "text") item[key] = { ...selection, occurrenceId: remapKey(selection.occurrenceId) };
          else if (selection?.kind === "blocks") item[key] = { kind: "blocks", anchor: remapKey(selection.anchor), occurrenceIds: selection.occurrenceIds.map(remapKey) };
        }
      }
    });
    selectionRef.current = new Map([...selectionRef.current].map(([key, value]) => {
      const prefix = ownerKey + ":";
      return [key.startsWith(prefix) ? prefix + remapKey(key.slice(prefix.length)) : key, value];
    }));
    const view = outlineView.current;
    view.focusReturns = view.focusReturns.map((entry) => ({ occurrenceId: remapKey(entry.occurrenceId), path: entry.path ? { ...entry.path, linkPath: entry.path.linkPath.map((id) => mapping.get(id) ?? id) } : null }));
    view.folds = new Map([...view.folds].map(([key, value]) => [remapKey(key), value]));
    if (view.focusedPath) view.focusedPath = { ...view.focusedPath, linkPath: view.focusedPath.linkPath.map((id) => mapping.get(id) ?? id) };
    if (view.focusRequest) view.focusRequest = { ...view.focusRequest, occurrenceId: remapKey(view.focusRequest.occurrenceId) };
    if (view.selection?.kind === "text") view.selection = { ...view.selection, occurrenceId: remapKey(view.selection.occurrenceId) };
    else if (view.selection?.kind === "blocks") view.selection = { kind: "blocks", anchor: remapKey(view.selection.anchor), occurrenceIds: view.selection.occurrenceIds.map(remapKey) };
    if (view.selection?.kind === "text") selectionRef.current.set(viewIdFor(view.selection.occurrenceId), { token: ++tokenRef.current, selection: { anchor: view.selection.anchor, head: view.selection.head } });
    session.acknowledgeStructure(ownerKey, receipt.clientMutationId, receipt.receiptId, receipt.reverseVersions);
    acceptSurface(owner.graph.surfaces.get(previous.source.item.ref)!, sourceRefRef.current);

    publishOwner();
  }

  function surfaceDelivery(onCommitted?: () => void): OperationCallbacks["deliver"] {
    return async (id, request, complete) => {
      switch (currentOperation(id).kind) {
        case "capture":
          return complete<ApiJson<"/notes/daily/{local_date}/captures", "post">>(request, (reply) => {
            acknowledgeCapture(id, reply.data);
            onCommitted?.();
          });
        case "title":
          return complete<ApiJson<"/resource-items/{resource_ref}/title", "patch">>(request, (reply) => {
            acknowledgeTitle(id, reply.data);
            onCommitted?.();
          });
        case "graph":
          return complete<ApiJson<"/resource-items/{resource_ref}/surface/commands", "post">>(request, (reply) => {
            acknowledgeGraph(id, reply.data);
            onCommitted?.();
          });
      }
    };
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
      deliver: surfaceDelivery(() => { void lease?.committed(); }),
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

  const command = (next: ResourceSurfaceCommand, context?: SurfaceContext): string | null => {
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
    const rootRef = sourceRefRef.current;
    if (!rootRef) return null;
    const path = context ?? { rootRef, linkPath: [] };
    let endpointRef = path.rootRef;
    for (const linkId of path.linkPath) {
      const link = projectedGraphRef.current.get(endpointRef)?.orderedItems.find((row) => row.linkId === linkId);
      if (!link) throw new Error("Command appearance path is stale");
      endpointRef = link.target.item.ref;
    }
    return commitCommand(endpointRef, path, next);
  };

  function commitCommand(endpointRef: string, context: SurfaceContext, next: ResourceSurfaceCommand, focusRef?: string, focusContext: SurfaceContext = context): string | null {
    const current = projectedGraphRef.current.get(endpointRef);
    if (!current) throw new Error("Command neighborhood has not loaded");
    const clientMutationId = resourceSurfaceCommandId();
    const before = [...projectedGraphRef.current.values()];
    const selectionBefore = outlineView.current.selection;
    const owned = new Set<string>();
    if (next.type === "split_note") {
      const row = current.orderedItems.find((row) => row.linkId === next.linkId);
      if (!row) throw new Error("Split link is absent");
      owned.add(row.target.item.ref);
      session.stageStructuralBody(row.target.item.ref, bodyFromJson(next.leftBodyPmJson));
    }
    if (next.type === "join_notes") {
      const row = current.orderedItems.find((row) => row.linkId === next.earlierLinkId);
      if (!row) throw new Error("Join link is absent");
      owned.add(row.target.item.ref);
      session.stageStructuralBody(row.target.item.ref, bodyFromJson(next.bodyPmJson));
    }
    const dependencies = new Set<string>();
    const dependencyLink = (endpoint: string, linkId: string) => {
      const ref = projectedGraphRef.current.get(endpoint)?.orderedItems.find((row) => row.linkId === linkId)?.target.item.ref;
      if (ref) dependencies.add(ref);
    };
    if ("linkId" in next) dependencyLink(endpointRef, next.linkId);
    if (next.type === "join_notes") { dependencyLink(endpointRef, next.earlierLinkId); dependencyLink(endpointRef, next.laterLinkId); }
    if (next.type === "remove_occurrence") for (const entry of next.entries) dependencyLink(entry.endpointRef, entry.linkId);
    if (next.type === "relink") dependencies.add(next.destinationRef);
    const dependentRefs = [...dependencies].filter((ref) => !owned.has(ref) && session.peekSnapshot(ref));
    const bodyEdits = session.structuralBodyEdits(dependentRefs);
    const absorbedRefs = new Set([...owned, ...bodyEdits.map((edit) => edit.ref)]);
    const queued = session.pendingOperations(ownerKey).map((entry) => asOperation(entry.intent)).filter((operation): operation is Extract<SurfaceOperation, { kind: "graph" }> => operation.kind === "graph").map((operation) => operation.intent);
    const queuedProjection = projectSurfaceGraph(new Map([...owner.graph.surfaces, ...(queued[0]?.baseSurfaces ?? []).map((surface) => [surface.source.item.ref, surface] as const)]), queued);
    const queuedBodyRefs = new Set(queued.flatMap((intent) => [...surfaceIntentBodyRefs(intent)]));
    const checkpointBodies = new Map<string, NoteBodyValue>();
    for (const ref of absorbedRefs) {
      const projected = queuedProjection.get(ref)?.source ?? [...queuedProjection.values()].flatMap((surface) => surface.orderedItems).find((row) => row.target.item.ref === ref)?.target;
      const base = queuedBodyRefs.has(ref) && projected?.content.kind === "note_body" ? bodyFromJson(projected.content.bodyPmJson) : session.structuralBodyBase(ref);
      checkpointBodies.set(ref, base);
      session.absorbSurfaceBodyHistory(ownerKey, ref, base);
    }
    const checkpointNode = (node: ResourceSurfaceNode): ResourceSurfaceNode => {
      const body = checkpointBodies.get(node.item.ref);
      return body && node.content.kind === "note_body" ? { ...node, content: { kind: "note_body", ...body } } : node;
    };
    const beforeCheckpoint = before.map((surface) => ({ source: checkpointNode(surface.source), orderedItems: surface.orderedItems.map((row) => ({ ...row, target: checkpointNode(row.target) })) }));
    const intent = createResourceSurfaceIntent({ surface: current, command: next, clientMutationId, context, bodyEdits, baseSurfaces: before });
    const after = projectSurfaceGraph(projectedGraphRef.current, [intent]);
    const changedRefs = new Set([...after].filter(([ref, surface]) => JSON.stringify(projectedGraphRef.current.get(ref)) !== JSON.stringify(surface)).map(([ref]) => ref));
    if (next.type !== "reverse_edit") session.recordStructure(ownerKey, { kind: "structure", mutationId: clientMutationId, receiptId: null, bodyRefs: [...absorbedRefs], before: [...beforeCheckpoint.filter((surface) => changedRefs.has(surface.source.item.ref)), ...[...after.values()].filter((surface) => !projectedGraphRef.current.has(surface.source.item.ref)).map((surface) => ({ ...surface, orderedItems: [] }))], after: [...after.values()].filter((surface) => changedRefs.has(surface.source.item.ref)), selectionBefore, selectionAfter: selectionBefore });
    projectedGraphRef.current = after;
    enqueue({ kind: "graph", sourceRef: endpointRef, intent });
    const root = sourceRefRef.current;
    if (focusRef && root) {
      const visible = outlineRows(root, after, outlineView.current, owner.graph.loads);
      const focused = visible.find((row) => row.target.item.ref === focusRef && !row.terminal && row.path.linkPath.slice(0, -1).join() === focusContext.linkPath.join());
      if (focused) {
        outlineView.current.focusRequest = { occurrenceId: focused.occurrenceId, serial: ++tokenRef.current };
        const selection = next.type === "relink" && selectionBefore?.kind === "text" ? { anchor: selectionBefore.anchor, head: selectionBefore.head } : { anchor: 1, head: 1 };
        outlineView.current.selection = { kind: "text", occurrenceId: focused.occurrenceId, ...selection };
        selectionRef.current.set(viewIdFor(focused.occurrenceId), { token: ++tokenRef.current, selection });
      }
    }
    session.structureSelection(ownerKey, outlineView.current.selection);
    publishOwner();
    return next.type === "insert_note" || next.type === "split_note" || next.type === "insert_resource" ? surfacePathKey({ rootRef: context.rootRef, linkPath: [...context.linkPath, pendingSurfaceLinkId(clientMutationId)] }) : null;
  }

  async function resolveNode(ref: string): Promise<void> {
    if (ref.startsWith("note_block:") || ref.startsWith("page:")) { await loadNeighborhood(ref); return; }
    if (owner.graph.nodes.has(ref) || owner.graph.surfaces.has(ref) || [...owner.graph.surfaces.values()].some((surface) => surface.orderedItems.some((row) => row.target.item.ref === ref))) return;
    const resolved = await resolveResourceLocator({ kind: "resource_ref", ref: assumeCanonicalResourceRef(ref) });
    acceptGraphNode(owner.graph, { item: resolved.resourceItem, content: { kind: "resource_summary" } });
  }


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
    for (const [ref, load] of owner.graph.loads) if (load.kind === "error") void loadNeighborhood(ref, true).catch((error: unknown) => inputRef.current.onError?.(error));
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
          projectSurfaceGraph(new Map([...owner.graph.surfaces, [next.source.item.ref, next], ...graphIntents[0]!.baseSurfaces.map((surface) => [surface.source.item.ref, surface] as const)]), graphIntents);
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
  const recover = async (candidate: RecoveryCandidate): Promise<boolean> => {
    if (candidate.corrupt || candidate.legacy || candidate.revision === null || candidate.ownerKey !== ownerKey) return false;
    const candidates = session.listRecovery(ownerKey).filter((entry) => entry.key === candidate.key && entry.revision === candidate.revision && !entry.corrupt);
    const raw = expectRecord(JSON.parse(candidate.raw), "recovered writing journal");
    if (!Array.isArray(raw.operations)) throw new TypeError("Recovered writing journal operations are invalid");
    const pending = raw.operations.map((value) => expectRecord(value, "recovered operation")).filter((entry) => entry.ownerKey === ownerKey);
    const operations = pending.map((entry) => ({ id: expectString(entry.id, "recovered operation id"), operation: asOperation(entry.intent), sequence: Number(entry.sequence) })).sort((left, right) => left.sequence - right.sequence);
    // Adopt the complete owner queue before attaching callbacks. A successor may
    // refer to a pending pair created by the lost reply, so replaying one entry
    // in isolation would strand its identity mapping in the old journal.
    for (const { operation } of operations) if (operation.kind === "graph") {
      for (const surface of operation.intent.baseSurfaces) {
        if (!owner.graph.surfaces.has(surface.source.item.ref)) owner.graph.surfaces.set(surface.source.item.ref, surface);
        for (const node of [surface.source, ...surface.orderedItems.map((row) => row.target)]) {
          if (node.content.kind !== "note_body" || session.peekSnapshot(node.item.ref)) continue;
          session.openBody({ noteRef: node.item.ref, ownerKey, initial: { body: bodyFromJson(node.content.bodyPmJson), version: resourceSurfaceLaneVersion(node.item, "body") }, adapter: noteBodyAdapter() });
        }
      }
      const projected = projectSurfaceGraph(new Map(operation.intent.baseSurfaces.map((surface) => [surface.source.item.ref, surface])), [operation.intent]);
      for (const surface of projected.values()) for (const node of [surface.source, ...surface.orderedItems.map((row) => row.target)]) {
        if (node.content.kind !== "note_body" || session.peekSnapshot(node.item.ref)) continue;
        session.openBody({ noteRef: node.item.ref, ownerKey, initial: { body: bodyFromJson(node.content.bodyPmJson), version: null }, adapter: noteBodyAdapter(), awaitExternalCreation: true });
      }
    }
    for (const entry of candidates) {
      if (!entry.noteRef) continue;
      if (!session.peekSnapshot(entry.noteRef)) {
        await loadNeighborhood(entry.noteRef);
        const node = owner.graph.surfaces.get(entry.noteRef)?.source;
        if (!node || node.content.kind !== "note_body") return false;
        session.openBody({ noteRef: entry.noteRef, ownerKey, initial: { body: bodyFromJson(node.content.bodyPmJson), version: resourceSurfaceLaneVersion(node.item, "body") }, adapter: noteBodyAdapter() });
      }
      if (!session.recover(entry.noteRef, entry.key, entry.revision!)) return false;
    }
    for (const { id } of operations) {
      if (!candidates.some((entry) => entry.operationId === id)) continue;
      if (!session.recoverOperation(candidate.key, candidate.revision, id)) return false;
    }
    for (const { id } of operations) {
      if (!session.pendingOperations(ownerKey).some((entry) => entry.id === id)) continue;
      session.attachOperation(id, {
        prepare: prepareOperation,
        deliver: surfaceDelivery(),
        onError: onOperationError,
      });
    }
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
  for (const cached of projectedGraphRef.current.values()) {
    if (cached.source.content.kind === "note_body") bodyRefs.add(cached.source.item.ref);
    for (const row of cached.orderedItems) if (row.target.content.kind === "note_body") bodyRefs.add(row.target.item.ref);
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
  const provisionalRow: OutlineRow | null = daily && provisional ? {
    occurrenceId: provisional.occurrenceId,
    path: { rootRef: sourceRefRef.current ?? ownerKey, linkPath: [] },
    endpointRef: sourceRefRef.current ?? ownerKey,
    linkId: provisional.occurrenceId,
    target: provisionalDailyOccurrence(provisional).target,
    depth: 0, collapsed: true, hasLinkNote: false, terminal: null, neighborhood: "unloaded",
  } : null;
  const shared = {
    status, localRetained, hasRecoveredDraft, recoveryCandidates, recover,
    bodyDocument, restoreSelection, editBody, selection, boundary, undo, redo,
    outline: createResourceOutline({ rootRef: sourceRefRef.current ?? ownerKey, provisional: provisionalRow, graph: () => projectedGraphRef.current, view: outlineView.current, loads: owner.graph.loads, load: loadNeighborhood, resolve: resolveNode, publish: publishOwner, recordSelection: (selection) => session.structureSelection(ownerKey, selection), command: commitCommand, body: (ref) => session.getSnapshot(ref).document.body.bodyPmJson, restore: (id, selection) => { selectionRef.current.set(viewIdFor(id), { token: ++tokenRef.current, selection }); session.structureSelection(ownerKey, { kind: "text", occurrenceId: id, ...selection }); } }),
    updateTitle, command, flush, retry, reload, copyRecovery,
  };
  if (daily && !surface) {
    shared.outline.insert = (position) => { command({ type: "insert_note", noteId: crypto.randomUUID(), position, bodyPmJson: { type: "paragraph" } }); };
  }
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
