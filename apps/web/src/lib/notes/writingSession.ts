"use client";

import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import type { NoteBodyEdit, NoteBodyEditorDocument, NoteBodySelection } from "@/components/notes/NoteBodyEditor";
import { expectRecord, expectInteger, expectString } from "@/lib/validation";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import { decodeNoteBodyValue, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";

const PREFIX = "nexus.writingJournal:v3:";
const IDLE_MS = 1500;
const MAX_MS = 5000;

export type ExpectedBody = { kind: "absent" } | { kind: "version"; version: number };
export type WritingStatus = "clean" | "dirty" | "saving" | "saved" | "recovered" | "network_failed" | "storage_failed" | "conflict" | "server_failed";
export class WritingStorageError extends Error {
  constructor() { super("Writing storage is unavailable on this device"); this.name = "WritingStorageError"; }
}
export class WritingUnknownOutcomeError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("The server reply could not be read after the request was sent");
    this.name = "WritingUnknownOutcomeError";
    this.cause = cause;
  }
}
export type FrozenRequest = Readonly<{ path: ApiPath; method: "PATCH" | "PUT" | "POST" | "DELETE"; body: string }>;
export type BodyAck = { body: NoteBodyValue; version: number };
export type BodyAdapter = {
  prepare: (input: { body: NoteBodyValue; expectedBody: ExpectedBody; clientMutationId: string }) => FrozenRequest;
  acknowledge: (data: unknown) => BodyAck;
  onAcknowledge?: (ack: BodyAck) => void | Promise<void>;
};
export type WritingSnapshot = {
  document: NoteBodyEditorDocument;
  status: WritingStatus;
  localRetained: boolean;
  hasRecoveredDraft: boolean;
  conflict: { local: NoteBodyValue; remote: NoteBodyValue | null } | null;
};
export type RecoveryCandidate = { key: string; revision: number | null; ownerKey: string | null; noteRef: string | null; operationId: string | null; raw: string; corrupt: boolean };
export type PendingBodyIdentity = { noteRef: string; sourceKey: string | null; revision: number | null };

type Submitted = { request: FrozenRequest; clientMutationId: string; body: NoteBodyValue; revision: number; expectedBody: ExpectedBody };
type BodyEntry = {
  ownerKey: string;
  ownerKeys: string[];
  noteRef: string;
  desired: NoteBodyValue;
  desiredRevision: number;
  acknowledged: BodyAck | null;
  submitted: Submitted | null;
  sequence: number;
  paused: "network" | "conflict" | "server" | "storage" | null;
  heldForStructure: boolean;
};
type OperationEntry = {
  id: string;
  ownerKey: string;
  key: string;
  sequence: number;
  intent: unknown;
  request: FrozenRequest | null;
  paused: "network" | "conflict" | "server" | "storage" | null;
};
type Journal = {
  version: 3;
  accountId: string;
  writerId: string;
  revision: number;
  adoptedSources: Array<{ key: string; revision: number; entryId: string }>;
  entries: Record<string, BodyEntry>;
  operations: OperationEntry[];
};
type BodyRuntime = {
  ownerKey: string;
  ownerKeys: Set<string>;
  body: NoteBodyValue;
  initialBody: NoteBodyValue;
  version: number | null;
  revision: number;
  adapter: BodyAdapter | null;
  onError?: (error: unknown) => void;
  onMutationStarted?: () => MountedEditorMutationLease | null;
  lease: MountedEditorMutationLease | null;
  entry: BodyEntry | null;
  snapshot: WritingSnapshot;
  histories: Map<string, { undo: HistoryItem[]; redo: HistoryItem[]; group: number }>;
  observers: Map<string, (ack: BodyAck) => void | Promise<void>>;
  submittedObservers: Map<string, (ack: BodyAck) => void | Promise<void>> | null;
  submittedAdapterObserver: ((ack: BodyAck) => void | Promise<void>) | null;
  idleTimer: number | null;
  maxTimer: number | null;
  ready: boolean;
  remote: NoteBodyValue | null;
  awaitExternalCreation: boolean;
};
type HistoryItem = { before: NoteBodyValue; after: NoteBodyValue; selectionBefore: NoteBodySelection; selectionAfter: NoteBodySelection; group: number; source: NoteBodyEdit["source"] };
export type OperationCallbacks = { prepare: (intent: unknown) => FrozenRequest; onAck: (data: unknown) => void; onError?: (error: unknown) => void };
type OperationRuntime = OperationCallbacks;

function sameBody(a: NoteBodyValue, b: NoteBodyValue): boolean {
  return a.bodyText === b.bodyText && JSON.stringify(a.bodyPmJson) === JSON.stringify(b.bodyPmJson);
}

function validRequest(request: FrozenRequest): boolean {
  return typeof request.path === "string" && request.path.startsWith("/api/") &&
    ["PATCH", "PUT", "POST", "DELETE"].includes(request.method) && typeof request.body === "string";
}

function parseJournal(raw: string, accountId: string): Journal {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("journal must be an object");
  const journal = value as Journal;
  if (journal.version !== 3 || journal.accountId !== accountId || typeof journal.writerId !== "string" ||
    !Number.isSafeInteger(journal.revision) || !journal.entries || typeof journal.entries !== "object" ||
    Array.isArray(journal.entries) || !Array.isArray(journal.operations) || !Array.isArray(journal.adoptedSources)) {
    throw new TypeError("journal identity or structure is invalid");
  }
  for (const source of journal.adoptedSources) {
    if (typeof source.key !== "string" || !Number.isSafeInteger(source.revision) || typeof source.entryId !== "string") {
      throw new TypeError("journal adopted source is invalid");
    }
  }
  for (const [ref, entry] of Object.entries(journal.entries)) {
    if (!entry || entry.noteRef !== ref || typeof entry.ownerKey !== "string" || !Array.isArray(entry.ownerKeys) ||
      !entry.ownerKeys.includes(entry.ownerKey) || !entry.ownerKeys.every((key) => typeof key === "string") ||
      !Number.isSafeInteger(entry.desiredRevision) || !Number.isSafeInteger(entry.sequence) ||
      typeof entry.heldForStructure !== "boolean" || ![null, "network", "conflict", "server", "storage"].includes(entry.paused)) {
      throw new TypeError("journal body entry is invalid");
    }
    entry.desired = decodeNoteBodyValue(entry.desired.bodyPmJson, entry.desired.bodyText, "writing journal body");
    if (entry.acknowledged) {
      if (!Number.isSafeInteger(entry.acknowledged.version)) throw new TypeError("journal body version is invalid");
      entry.acknowledged.body = decodeNoteBodyValue(entry.acknowledged.body.bodyPmJson, entry.acknowledged.body.bodyText, "writing journal acknowledged body");
    }
    if (entry.submitted) {
      const submitted = entry.submitted;
      if (!validRequest(submitted.request) || typeof submitted.clientMutationId !== "string" ||
        !Number.isSafeInteger(submitted.revision) || !submitted.expectedBody ||
        (submitted.expectedBody.kind !== "absent" &&
          (submitted.expectedBody.kind !== "version" || !Number.isSafeInteger(submitted.expectedBody.version)))) {
        throw new TypeError("journal submitted body is invalid");
      }
      submitted.body = decodeNoteBodyValue(submitted.body.bodyPmJson, submitted.body.bodyText, "writing journal submitted body");
    }
  }
  for (const operation of journal.operations) {
    if (!operation || typeof operation.id !== "string" || typeof operation.ownerKey !== "string" ||
      typeof operation.key !== "string" || !Number.isSafeInteger(operation.sequence) ||
      ![null, "network", "conflict", "server", "storage"].includes(operation.paused) ||
      (operation.request !== null && !validRequest(operation.request))) {
      throw new TypeError("journal operation is invalid");
    }
  }
  return journal;
}

const stores = new Map<string, WritingSession>();

/** One runtime writer and one transport slot per account. */
export function getWritingSession(accountId: string): WritingSession {
  if (!accountId) throw new TypeError("writing account is required");
  if (typeof window === "undefined") return new WritingSession(accountId);
  let store = stores.get(accountId);
  if (!store) {
    store = new WritingSession(accountId);
    stores.set(accountId, store);
  }
  return store;
}

export class WritingSession {
  private readonly accountId: string;
  private readonly writerId = createRandomId();
  private readonly bodies = new Map<string, BodyRuntime>();
  private readonly listeners = new Set<() => void>();
  private readonly operations = new Map<string, OperationRuntime>();
  private readonly journal: Journal;
  private active: string | null = null;
  private blocked: string | null = null;
  private sequence = 0;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.journal = { version: 3, accountId, writerId: this.writerId, revision: 0, adoptedSources: [], entries: {}, operations: [] };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void { for (const listener of this.listeners) listener(); }
  private key(): string { return `${PREFIX}${this.accountId}:${this.writerId}`; }
  private retain(): boolean {
    this.journal.revision += 1;
    try {
      window.localStorage.setItem(this.key(), JSON.stringify(this.journal));
      return true;
    } catch {
      return false;
    }
  }
  private removeCleanJournal(): boolean {
    if (Object.keys(this.journal.entries).length || this.journal.operations.length || this.journal.adoptedSources.length) return this.retain();
    try { window.localStorage.removeItem(this.key()); return true; } catch { return false; }
  }
  private state(ref: string): BodyRuntime {
    const body = this.bodies.get(ref);
    if (!body) throw new Error(`writing body ${ref} was not opened`);
    return body;
  }
  private snapshot(body: BodyRuntime, status: WritingStatus, retained: boolean, recovered = false, notify = true): void {
    body.snapshot = {
      document: { body: body.body, revision: body.revision }, status,
      localRetained: retained, hasRecoveredDraft: recovered,
      conflict: status === "conflict" ? { local: body.body, remote: body.remote } : null,
    };
    if (notify) this.publish();
  }

  openBody(input: { noteRef: string; ownerKey: string; initial: { body: NoteBodyValue; version: number | null }; adapter: BodyAdapter | null; awaitExternalCreation?: boolean; onError?: (error: unknown) => void; onMutationStarted?: () => MountedEditorMutationLease | null }): void {
    const existing = this.bodies.get(input.noteRef);
    if (existing) {
      if (!existing.adapter && input.adapter) existing.adapter = input.adapter;
      if (!existing.ownerKeys.has(input.ownerKey)) {
        existing.ownerKeys.add(input.ownerKey);
        if (existing.entry) {
          existing.entry.ownerKeys = [...existing.ownerKeys];
          if (!this.retain()) { this.snapshot(existing, "storage_failed", false, false, false); queueMicrotask(() => this.publish()); }
        }
      }
      if (input.onError) existing.onError = input.onError;
      if (input.onMutationStarted) existing.onMutationStarted = input.onMutationStarted;
      if (input.awaitExternalCreation && !existing.adapter && existing.version === null) existing.awaitExternalCreation = true;
      if (!existing.entry && existing.version === null && existing.awaitExternalCreation && !sameBody(existing.body, input.initial.body)) {
        existing.body = input.initial.body; existing.initialBody = input.initial.body; existing.revision += 1;
        for (const history of existing.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
        this.snapshot(existing, "clean", true, false, false);
        queueMicrotask(() => this.publish());
      }
      if (!existing.entry && input.initial.version !== null && (existing.version === null || input.initial.version > existing.version)) {
        existing.version = input.initial.version; existing.body = input.initial.body; existing.revision += 1;
        for (const history of existing.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
        this.snapshot(existing, "clean", true, false, false);
        queueMicrotask(() => this.publish());
      }
      return;
    }
    const body: BodyRuntime = {
      ownerKey: input.ownerKey, ownerKeys: new Set([input.ownerKey]), body: input.initial.body, initialBody: input.initial.body, version: input.initial.version,
      revision: 0, adapter: input.adapter, onError: input.onError, onMutationStarted: input.onMutationStarted, lease: null, entry: null,
      snapshot: { document: { body: input.initial.body, revision: 0 }, status: "clean", localRetained: true, hasRecoveredDraft: false, conflict: null },
      histories: new Map(), observers: new Map(), submittedObservers: null, submittedAdapterObserver: null, idleTimer: null, maxTimer: null, ready: false, remote: null, awaitExternalCreation: input.awaitExternalCreation ?? false,
    };
    this.bodies.set(input.noteRef, body);
  }

  getSnapshot = (noteRef: string): WritingSnapshot => this.state(noteRef).snapshot;
  peekSnapshot = (noteRef: string): WritingSnapshot | null => this.bodies.get(noteRef)?.snapshot ?? null;
  bodyVersion(noteRef: string): number | null { return this.state(noteRef).version; }
  setBodyAdapter(noteRef: string, adapter: BodyAdapter): void {
    const runtime = this.state(noteRef);
    if (!runtime.adapter) runtime.adapter = adapter;
    runtime.awaitExternalCreation = false;
    this.pump();
  }
  rebindOwner(noteRef: string, ownerKey: string): boolean {
    const runtime = this.state(noteRef);
    if (!ownerKey) throw new TypeError("writing owner is required");
    runtime.ownerKey = ownerKey; runtime.ownerKeys.add(ownerKey);
    if (!runtime.entry) return true;
    runtime.entry.ownerKey = ownerKey; runtime.entry.ownerKeys = [...runtime.ownerKeys];
    const retained = this.retain();
    if (!retained) this.snapshot(runtime, "storage_failed", false);
    return retained;
  }
  findPendingBodies(ownerKey: string): PendingBodyIdentity[] {
    const result: PendingBodyIdentity[] = [];
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.ownerKeys.includes(ownerKey)) result.push({ noteRef: entry.noteRef, sourceKey: null, revision: this.journal.revision });
    }
    for (const candidate of this.listRecovery(ownerKey)) {
      if (candidate.noteRef) result.push({ noteRef: candidate.noteRef, sourceKey: candidate.key, revision: candidate.revision });
    }
    return result;
  }

  closeView(noteRef: string, viewId: string): void {
    this.bodies.get(noteRef)?.histories.delete(viewId);
    this.bodies.get(noteRef)?.observers.delete(viewId);
  }
  observeBodyAcknowledgement(noteRef: string, viewId: string, callback: ((ack: BodyAck) => void | Promise<void>) | undefined): void {
    const body = this.state(noteRef);
    if (callback) body.observers.set(viewId, callback);
    else body.observers.delete(viewId);
  }

  private history(body: BodyRuntime, viewId: string): { undo: HistoryItem[]; redo: HistoryItem[]; group: number } {
    let history = body.histories.get(viewId);
    if (!history) { history = { undo: [], redo: [], group: 0 }; body.histories.set(viewId, history); }
    return history;
  }
  boundary(noteRef: string, viewId: string): void { this.history(this.state(noteRef), viewId).group += 1; }
  selection(noteRef: string, viewId: string, _selection: NoteBodySelection): void { this.boundary(noteRef, viewId); }

  edit(noteRef: string, viewId: string, edit: NoteBodyEdit): boolean {
    const body = this.state(noteRef);
    if (!sameBody(body.body, edit.before)) return false;
    if (sameBody(edit.before, edit.after)) return true;
    const history = this.history(body, viewId);
    const last = history.undo.at(-1);
    if (edit.source === "input" && last?.source === "input" && last.group === history.group && sameBody(last.after, edit.before)) {
      last.after = edit.after;
      last.selectionAfter = edit.selectionAfter;
    } else {
      history.undo.push({ ...edit, group: history.group });
    }
    history.redo = [];
    if (edit.source !== "input") history.group += 1;
    for (const [otherView, otherHistory] of body.histories) {
      if (otherView !== viewId) { otherHistory.undo = []; otherHistory.redo = []; otherHistory.group += 1; }
    }
    this.acceptBody(noteRef, edit.after);
    return true;
  }

  undo(noteRef: string, viewId: string): NoteBodySelection | null {
    const body = this.state(noteRef);
    const history = this.history(body, viewId);
    const item = history.undo.pop();
    if (!item || !sameBody(body.body, item.after)) return null;
    history.redo.push(item); history.group += 1;
    this.acceptBody(noteRef, item.before);
    return item.selectionBefore;
  }
  redo(noteRef: string, viewId: string): NoteBodySelection | null {
    const body = this.state(noteRef);
    const history = this.history(body, viewId);
    const item = history.redo.pop();
    if (!item || !sameBody(body.body, item.before)) return null;
    history.undo.push(item); history.group += 1;
    this.acceptBody(noteRef, item.after);
    return item.selectionAfter;
  }

  private acceptBody(noteRef: string, value: NoteBodyValue): void {
    const body = this.state(noteRef);
    body.body = value; body.revision += 1;
    const existing = body.entry;
    const entry: BodyEntry = existing ?? {
      ownerKey: body.ownerKey, ownerKeys: [...body.ownerKeys], noteRef, desired: value, desiredRevision: 0,
      acknowledged: body.version === null ? null : { body: body.snapshot.document.body, version: body.version },
      submitted: null, sequence: ++this.sequence, paused: null, heldForStructure: false,
    };
    entry.desired = value; entry.desiredRevision = body.revision;
    if (!entry.submitted && (entry.acknowledged === null && !noteBodyHasContent(value) || entry.acknowledged !== null && sameBody(value, entry.acknowledged.body))) {
      body.entry = null;
      delete this.journal.entries[noteRef];
      this.clearTimers(body);
      this.removeCleanJournal();
      this.snapshot(body, "clean", true);
      return;
    }
    if (!existing) { body.entry = entry; this.journal.entries[noteRef] = entry; }
    const retained = this.retain();
    const status: WritingStatus = !retained ? "storage_failed"
      : entry.paused === "network" ? "network_failed"
      : entry.paused === "conflict" ? "conflict"
      : entry.paused === "server" ? "server_failed"
      : entry.paused === "storage" ? "storage_failed"
      : "dirty";
    this.snapshot(body, status, retained);
    this.schedule(noteRef);
  }

  retainInitialBody(noteRef: string): boolean {
    const runtime = this.state(noteRef);
    if (runtime.entry) {
      const retained = this.retain();
      this.snapshot(runtime, retained ? "dirty" : "storage_failed", retained);
      return retained;
    }
    if (runtime.version !== null || !noteBodyHasContent(runtime.body)) return false;
    const entry: BodyEntry = {
      ownerKey: runtime.ownerKey, ownerKeys: [...runtime.ownerKeys], noteRef,
      desired: runtime.body, desiredRevision: runtime.revision,
      acknowledged: null, submitted: null, sequence: ++this.sequence,
      paused: null, heldForStructure: false,
    };
    runtime.entry = entry;
    this.journal.entries[noteRef] = entry;
    const retained = this.retain();
    this.snapshot(runtime, retained ? "dirty" : "storage_failed", retained);
    return retained;
  }

  stageStructuralBody(noteRef: string, next: NoteBodyValue): void {
    const runtime = this.state(noteRef);
    for (const history of runtime.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
    if (!sameBody(runtime.body, next)) this.acceptBody(noteRef, next);
    if (runtime.entry) {
      runtime.entry.heldForStructure = true;
      runtime.ready = false;
      this.clearTimers(runtime);
      const retained = this.retain();
      this.snapshot(runtime, retained ? "dirty" : "storage_failed", retained);
    }
  }

  private clearTimers(body: BodyRuntime): void {
    if (body.idleTimer !== null) window.clearTimeout(body.idleTimer);
    if (body.maxTimer !== null) window.clearTimeout(body.maxTimer);
    body.idleTimer = null; body.maxTimer = null;
  }
  private schedule(noteRef: string): void {
    const body = this.state(noteRef);
    if (body.idleTimer !== null) window.clearTimeout(body.idleTimer);
    body.idleTimer = window.setTimeout(() => this.flush(noteRef), IDLE_MS);
    if (body.maxTimer === null) body.maxTimer = window.setTimeout(() => this.flush(noteRef), MAX_MS);
  }
  flush(noteRef?: string): void {
    if (noteRef) { const body = this.state(noteRef); this.clearTimers(body); body.ready = true; }
    else for (const body of this.bodies.values()) { this.clearTimers(body); body.ready = true; }
    this.pump();
  }

  enqueueOperation(input: { ownerKey: string; key: string; intent: unknown } & OperationCallbacks): { id: string; retained: boolean } {
    const id = createRandomId();
    const entry: OperationEntry = { id, ownerKey: input.ownerKey, key: input.key, intent: JSON.parse(JSON.stringify(input.intent)) as unknown, request: null, sequence: ++this.sequence, paused: null };
    this.journal.operations.push(entry);
    this.operations.set(id, { prepare: input.prepare, onAck: input.onAck, onError: input.onError });
    const retained = this.retain();
    if (!retained) entry.paused = "storage";
    else this.pump();
    return { id, retained };
  }
  pendingOperations(ownerKey: string): ReadonlyArray<Pick<OperationEntry, "id" | "key" | "intent" | "request" | "paused">> {
    return this.journal.operations.filter((entry) => entry.ownerKey === ownerKey).map(({ id, key, intent, request, paused }) => ({ id, key, intent: JSON.parse(JSON.stringify(intent)) as unknown, request, paused }));
  }
  attachOperation(id: string, callbacks: OperationCallbacks): void {
    if (!this.journal.operations.some((entry) => entry.id === id)) throw new Error("pending writing operation does not exist");
    this.operations.set(id, callbacks); this.pump();
  }
  replaceOperation(id: string, intent: unknown): boolean {
    const entry = this.journal.operations.find((value) => value.id === id);
    if (!entry || entry.request || this.active === id) return false;
    entry.intent = JSON.parse(JSON.stringify(intent)) as unknown;
    const retained = this.retain();
    if (!retained) { entry.paused = "storage"; this.operations.get(id)?.onError?.(new WritingStorageError()); }
    return retained;
  }
  acknowledgeExternalBody(noteRef: string, ack: BodyAck): void {
    const runtime = this.bodies.get(noteRef);
    if (!runtime) return;
    if (runtime.version !== null && ack.version < runtime.version) return;
    runtime.version = ack.version;
    runtime.awaitExternalCreation = false;
    if (!runtime.entry) {
      if (!sameBody(runtime.body, ack.body)) { runtime.body = ack.body; runtime.revision += 1;
        for (const history of runtime.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
      }
      this.snapshot(runtime, "clean", true);
      return;
    }
    const entry = runtime.entry;
    if (entry.submitted) throw new Error("external body acknowledgement overtook a submitted body");
    entry.acknowledged = ack;
    entry.heldForStructure = false;
    if (sameBody(entry.desired, ack.body)) {
      runtime.entry = null; delete this.journal.entries[noteRef];
      this.removeCleanJournal(); this.snapshot(runtime, "saved", true);
    } else {
      const retained = this.retain();
      runtime.ready = true;
      this.snapshot(runtime, retained ? "dirty" : "storage_failed", retained);
    }
  }

  private pump(): void {
    if (this.active || this.blocked) return;
    const candidates: Array<{ key: string; sequence: number; body?: BodyEntry; operation?: OperationEntry }> = [];
    for (const entry of Object.values(this.journal.entries)) {
      const runtime = this.bodies.get(entry.noteRef);
      if (runtime && (runtime.ready && !runtime.awaitExternalCreation && !entry.heldForStructure || entry.submitted) && (entry.acknowledged !== null || runtime.adapter || entry.submitted) && entry.paused !== "conflict" && entry.paused !== "server" && entry.paused !== "storage") candidates.push({ key: entry.noteRef, sequence: entry.sequence, body: entry });
    }
    for (const operation of this.journal.operations) {
      if (operation.paused !== "conflict" && operation.paused !== "server" && operation.paused !== "storage") candidates.push({ key: operation.id, sequence: operation.sequence, operation });
    }
    candidates.sort((a, b) => a.sequence - b.sequence);
    const candidate = candidates[0];
    if (!candidate) return;
    if (candidate.body) {
      const entry = candidate.body;
      const runtime = this.bodies.get(entry.noteRef);
      if (!runtime || (entry.acknowledged === null && !runtime.adapter && !entry.submitted)) return;
      if (!entry.submitted) {
        if (entry.acknowledged === null && !noteBodyHasContent(entry.desired)) {
          runtime.entry = null; delete this.journal.entries[entry.noteRef];
          this.removeCleanJournal(); this.snapshot(runtime, "clean", true);
          this.pump(); return;
        }
        const clientMutationId = createRandomId();
        const expectedBody: ExpectedBody = entry.acknowledged === null ? { kind: "absent" } : { kind: "version", version: entry.acknowledged.version };
        let request: FrozenRequest;
        try {
          request = expectedBody.kind === "absent"
            ? runtime.adapter!.prepare({ body: entry.desired, expectedBody, clientMutationId })
            : { path: `/api/resource-items/${encodeURIComponent(entry.noteRef)}/body` as ApiPath, method: "PATCH", body: JSON.stringify({ client_mutation_id: clientMutationId, base_versions: [{ ref: entry.noteRef, lane: "body", version: expectedBody.version }], body_pm_json: entry.desired.bodyPmJson }) };
        } catch (error) {
          entry.paused = "server";
          this.retain();
          this.snapshot(runtime, "server_failed", runtime.snapshot.localRetained);
          runtime.onError?.(error);
          this.pump(); return;
        }
        entry.submitted = { request, clientMutationId, body: entry.desired, revision: entry.desiredRevision, expectedBody };
        runtime.submittedObservers = null; runtime.submittedAdapterObserver = null;
        const retained = this.retain();
        if (!retained) {
          entry.paused = "storage";
          this.snapshot(runtime, "storage_failed", false);
          this.pump(); return;
        }
        if (!runtime.snapshot.localRetained) this.snapshot(runtime, "dirty", true);
      }
      if (runtime.submittedObservers === null) {
        runtime.submittedObservers = new Map(runtime.observers);
        runtime.submittedAdapterObserver = runtime.adapter?.onAcknowledge ?? null;
      }
      this.active = entry.noteRef;
      runtime.ready = false;
      runtime.lease ??= runtime.onMutationStarted?.() ?? null;
      this.snapshot(runtime, runtime.snapshot.localRetained ? "saving" : "storage_failed", runtime.snapshot.localRetained);
      void this.execute(entry.submitted.request).then(async (data) => {
        const submitted = entry.submitted!;
        let ack: BodyAck;
        try {
          ack = submitted.expectedBody.kind === "absent"
            ? runtime.adapter!.acknowledge(data)
            : this.acknowledgeCanonicalBody(data);
        } catch (error) {
          throw new WritingUnknownOutcomeError(error);
        }
        entry.acknowledged = ack;
        runtime.version = ack.version;
        entry.submitted = null;
        entry.paused = null;
        if (entry.desiredRevision === submitted.revision) {
          runtime.entry = null;
          delete this.journal.entries[entry.noteRef];
          this.removeCleanJournal();
          this.snapshot(runtime, "saved", true);
        } else {
          entry.sequence = ++this.sequence;
          runtime.ready = !entry.heldForStructure;
          const retained = this.retain();
          const localRetained = retained || runtime.snapshot.localRetained;
          this.snapshot(runtime, localRetained ? "dirty" : "storage_failed", localRetained);
        }
        const lease = runtime.lease; runtime.lease = null;
        try { await lease?.committed(); } catch (error) { runtime.onError?.(error); }
        const observers = new Set(runtime.submittedObservers?.values() ?? []);
        for (const observer of runtime.observers.values()) observers.add(observer);
        if (runtime.submittedAdapterObserver) observers.add(runtime.submittedAdapterObserver);
        runtime.submittedObservers = null; runtime.submittedAdapterObserver = null;
        for (const observer of observers) {
          void Promise.resolve().then(() => observer(ack)).catch((error: unknown) => runtime.onError?.(error));
        }
      }).catch((error: unknown) => this.failBody(entry, runtime, error)).finally(() => {
        this.active = null; this.pump();
      });
      return;
    }
    const operation = candidate.operation!;
    const callbacks = this.operations.get(operation.id);
    if (!callbacks) return;
    if (!operation.request) {
      try {
        operation.request = callbacks.prepare(operation.intent);
        if (!this.retain()) {
          operation.paused = "storage";
          callbacks.onError?.(new WritingStorageError());
          this.pump(); return;
        }
      } catch (error) {
        operation.paused = "server";
        this.retain(); callbacks.onError?.(error);
        this.pump(); return;
      }
    }
    this.active = operation.id;
    void this.execute(operation.request).then((data) => {
      try {
        callbacks.onAck(data);
      } catch (error) {
        // The server committed; exact replay must repair the owner's projection before successors run.
        operation.paused = "network";
        this.blocked = operation.id;
        this.retain();
        callbacks.onError?.(new WritingUnknownOutcomeError(error));
        return;
      }
      this.journal.operations = this.journal.operations.filter((entry) => entry.id !== operation.id);
      this.operations.delete(operation.id);
      this.removeCleanJournal();
    }).catch((error: unknown) => {
      operation.paused = this.failureKind(error);
      if (operation.paused === "network") this.blocked = operation.id;
      this.retain(); callbacks.onError?.(error);
    }).finally(() => { this.active = null; this.pump(); });
  }

  private async execute(request: FrozenRequest): Promise<unknown> {
    try {
      const result = await apiFetch<{ data: unknown } | undefined>(request.path, { method: request.method, body: request.body });
      return result?.data;
    } catch (error) {
      if (isApiError(error) && error.code === "E_INVALID_RESPONSE" && error.status >= 200 && error.status < 300) {
        throw new WritingUnknownOutcomeError(error);
      }
      throw error;
    }
  }
  private failBody(entry: BodyEntry, runtime: BodyRuntime, error: unknown): void {
    const kind = this.failureKind(error);
    entry.paused = kind;
    if (kind === "network") this.blocked = entry.noteRef;
    const retained = this.retain();
    this.snapshot(runtime, retained ? kind === "network" ? "network_failed" : kind === "conflict" ? "conflict" : "server_failed" : "storage_failed", retained);
    // A paused request retains its exact bytes, not the mounted action slot.
    // Retry reacquires a current owner's lease before replaying those bytes.
    runtime.lease?.failed(); runtime.lease = null;
    runtime.onError?.(error);
    if (kind === "conflict") void this.refreshConflict(entry.noteRef).catch((refreshError: unknown) => runtime.onError?.(refreshError));
  }
  private failureKind(error: unknown): "network" | "conflict" | "server" {
    if (isApiError(error)) {
      if (error.code === "E_RESOURCE_CONFLICT") return "conflict";
      return error.status >= 400 && error.status < 500 && error.code !== "E_NETWORK" && error.code !== "E_INVALID_RESPONSE"
        ? "server" : "network";
    }
    // A request was already sent. An undecodable success or local acknowledgement
    // defect cannot prove noncommit; only an explicit 4xx response can.
    return "network";
  }
  private acknowledgeCanonicalBody(data: unknown): BodyAck {
    const value = expectRecord(data, "note body response");
    const item = expectRecord(value.item, "note body response item");
    const versions = expectRecord(item.versionByLane, "note body version");
    return { body: decodeNoteBodyValue(value.bodyPmJson, value.bodyText, "note body response"), version: expectInteger(versions.body, "note body version") };
  }
  async refreshConflict(noteRef: string): Promise<void> {
    const runtime = this.state(noteRef);
    if (runtime.entry?.paused !== "conflict") return;
    const noteId = noteRef.startsWith("note_block:") ? noteRef.slice("note_block:".length) : null;
    if (!noteId) throw new TypeError("conflicted body has no canonical note id");
    const response = await apiFetch<{ data: unknown }>(`/api/notes/blocks/${encodeURIComponent(noteId)}`);
    const data = expectRecord(response.data, "conflicted note");
    const versions = expectRecord(data.versionByLane, "conflicted note versions");
    runtime.version = expectInteger(versions.body, "conflicted note body version");
    if (expectString(data.id, "conflicted note id") !== noteId) throw new TypeError("conflicted note identity changed");
    if (runtime.entry?.paused !== "conflict") return;
    runtime.remote = decodeNoteBodyValue(data.bodyPmJson, data.bodyText, "conflicted note");
    this.snapshot(runtime, "conflict", runtime.snapshot.localRetained);
  }
  reapply(noteRef: string): boolean {
    const runtime = this.state(noteRef);
    const entry = runtime.entry;
    if (!entry || entry.paused !== "conflict" || !runtime.remote || runtime.version === null) return false;
    for (const history of runtime.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
    entry.acknowledged = { body: runtime.remote, version: runtime.version };
    entry.submitted = null; entry.paused = null; entry.sequence = ++this.sequence;
    runtime.submittedObservers = null; runtime.submittedAdapterObserver = null;
    runtime.ready = true; runtime.remote = null;
    const retained = this.retain();
    this.snapshot(runtime, retained ? "dirty" : "storage_failed", retained);
    this.pump();
    return true;
  }
  retry(key: string): boolean {
    if (this.active === key) return false;
    const body = this.bodies.get(key);
    if (body?.entry && body.entry.paused && body.entry.paused !== "conflict") {
      if (body.entry.paused === "storage" && !this.retain()) { this.snapshot(body, "storage_failed", false); return false; }
      body.entry.paused = null; body.ready = true;
      const retained = this.retain();
      if (!retained) body.entry.paused = "storage";
      this.snapshot(body, retained ? "dirty" : "storage_failed", retained);
      if (!retained) return false;
      if (this.blocked === key) this.blocked = null;
      this.pump();
      return body.entry.paused !== "storage";
    }
    const operation = this.journal.operations.find((entry) => entry.id === key);
    if (!operation || !operation.paused || operation.paused === "conflict") return false;
    if (operation.paused === "storage" && !this.retain()) return false;
    operation.paused = null;
    if (!this.retain()) { operation.paused = "storage"; return false; }
    if (this.blocked === key) this.blocked = null;
    this.pump();
    return operation.paused !== "storage";
  }

  listRecovery(ownerKey?: string): RecoveryCandidate[] {
    const results: RecoveryCandidate[] = [];
    if (typeof window === "undefined") return results;
    try {
      const storage = window.localStorage;
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(`${PREFIX}${this.accountId}:`) || key === this.key()) continue;
        const raw = storage.getItem(key);
        if (raw === null) continue;
        try {
          const journal = parseJournal(raw, this.accountId);
          for (const entry of Object.values(journal.entries)) {
            if (ownerKey && !entry.ownerKeys.includes(ownerKey)) continue;
            if (this.journal.adoptedSources.some((source) => source.key === key && source.revision === journal.revision && source.entryId === entry.noteRef)) continue;
            results.push({ key, revision: journal.revision, ownerKey: entry.ownerKey, noteRef: entry.noteRef, operationId: null, raw, corrupt: false });
          }
          for (const operation of journal.operations) {
            if (ownerKey && operation.ownerKey !== ownerKey) continue;
            if (this.journal.adoptedSources.some((source) => source.key === key && source.revision === journal.revision && source.entryId === operation.id)) continue;
            results.push({ key, revision: journal.revision, ownerKey: operation.ownerKey, noteRef: null, operationId: operation.id, raw, corrupt: false });
          }
        } catch {
          results.push({ key, revision: null, ownerKey: null, noteRef: null, operationId: null, raw, corrupt: true });
        }
      }
    } catch {
      throw new WritingStorageError();
    }
    return results;
  }
  exportRaw(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  currentJournalKey(): string { return this.key(); }
  exportCurrentRaw(): string { return JSON.stringify(this.journal); }
  recover(noteRef: string, sourceKey: string, sourceRevision: number): boolean {
    const raw = this.exportRaw(sourceKey);
    if (raw === null) return false;
    let source: Journal;
    try { source = parseJournal(raw, this.accountId); } catch { return false; }
    if (source.revision !== sourceRevision) return false;
    const entry = source.entries[noteRef];
    const runtime = this.bodies.get(noteRef);
    if (!entry || !runtime || runtime.entry) return false;
    const adopted = { ...entry, ownerKeys: [...new Set([...entry.ownerKeys, ...runtime.ownerKeys])], acknowledged: entry.acknowledged ?? (runtime.version === null ? null : { body: runtime.body, version: runtime.version }) };
    adopted.sequence = adopted.submitted ? 0 : ++this.sequence;
    if (adopted.submitted && adopted.paused !== "conflict" && adopted.paused !== "server" && adopted.paused !== "storage") this.blocked = noteRef;
    runtime.entry = adopted; runtime.body = adopted.desired; runtime.revision += 1;
    for (const history of runtime.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
    this.journal.entries[noteRef] = adopted;
    this.journal.adoptedSources.push({ key: sourceKey, revision: sourceRevision, entryId: noteRef });
    if (!this.retain()) {
      delete this.journal.entries[noteRef]; this.journal.adoptedSources.pop(); runtime.entry = null;
      if (this.blocked === noteRef) this.blocked = null;
      this.snapshot(runtime, "storage_failed", false);
      return false;
    }
    runtime.ready = false;
    this.snapshot(runtime, "recovered", true, true);
    return true;
  }
  recoverOperation(sourceKey: string, sourceRevision: number, operationId: string): boolean {
    const raw = this.exportRaw(sourceKey);
    if (raw === null) return false;
    let source: Journal;
    try { source = parseJournal(raw, this.accountId); } catch { return false; }
    if (source.revision !== sourceRevision || this.journal.operations.some((entry) => entry.id === operationId)) return false;
    const operation = source.operations.find((entry) => entry.id === operationId);
    if (!operation) return false;
    this.journal.operations.push({ ...operation, sequence: operation.request ? 0 : ++this.sequence });
    if (operation.request && operation.paused !== "conflict" && operation.paused !== "server" && operation.paused !== "storage") this.blocked = operationId;
    this.journal.adoptedSources.push({ key: sourceKey, revision: sourceRevision, entryId: operationId });
    if (!this.retain()) { this.journal.operations.pop(); this.journal.adoptedSources.pop(); if (this.blocked === operationId) this.blocked = null; return false; }
    return true;
  }
  discardOperation(id: string): boolean {
    const operation = this.journal.operations.find((entry) => entry.id === id);
    if (!operation || this.active === id || (operation.request && (operation.paused === "network" || operation.paused === null))) return false;
    const previous = this.journal.operations;
    this.journal.operations = previous.filter((entry) => entry.id !== id);
    if (!this.removeCleanJournal()) { this.journal.operations = previous; return false; }
    this.operations.delete(id);
    return true;
  }
  discard(noteRef: string): boolean {
    const runtime = this.state(noteRef);
    const entry = runtime.entry;
    if (!entry || this.active === noteRef ||
      (entry.submitted && entry.paused !== "conflict" && entry.paused !== "server") ||
      (entry.paused === "conflict" && runtime.remote === null)) return false;
    delete this.journal.entries[noteRef];
    if (!this.removeCleanJournal()) {
      this.journal.entries[noteRef] = entry;
      this.snapshot(runtime, "storage_failed", runtime.snapshot.localRetained);
      return false;
    }
    runtime.body = entry.paused === "conflict" && runtime.remote
      ? runtime.remote
      : entry.acknowledged?.body ?? runtime.initialBody;
    runtime.entry = null; runtime.remote = null; runtime.submittedObservers = null; runtime.submittedAdapterObserver = null; runtime.revision += 1;
    runtime.ready = false; this.clearTimers(runtime);
    for (const history of runtime.histories.values()) { history.undo = []; history.redo = []; history.group += 1; }
    this.snapshot(runtime, "clean", true);
    return true;
  }

  discardSource(key: string, revision: number): boolean {
    const raw = this.exportRaw(key);
    if (raw === null) return false;
    try {
      if (parseJournal(raw, this.accountId).revision !== revision) return false;
      window.localStorage.removeItem(key);
      return true;
    } catch { return false; }
  }
}
