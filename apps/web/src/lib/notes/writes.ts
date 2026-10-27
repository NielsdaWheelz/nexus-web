"use client";

/** One live account fifo. Admission freezes authored intent; named live predecessors
 * alone authorize sealing. All attempts reuse identical request bytes. Unknown
 * results block the suffix; definitive refusals reject dependents only. Account
 * teardown fences callbacks and abandons memory, without promising cancellation.
 * Creates retry their client uuid, updates their absolute value/version, deletes
 * their idempotent identity. There is no browser persistence or cross-tab lease.
 */
import { remoteReady, subscribeAdmission } from "@/lib/native/admission";
import { apiFetch, isApiError, isSameSystemApiDefect, outcomeUnknown, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { parseBody } from "./noteBody";

export type WriteState =
  | { kind: "queued" | "sending" }
  | { kind: "unconfirmed"; error: unknown }
  | { kind: "accepted"; ack: WritingAck }
  | { kind: "refused"; error: unknown }
  | { kind: "abandoned" };
export interface WriteHandle {
  readonly id: string;
  readonly settled: Promise<WritingAck>;
  read(): WriteState;
  subscribe(listener: () => void): () => void;
  retry(): void;
}
export type AuthoredValue = { kind: "body"; body_pm_json: BodyJson } | { kind: "title"; text: string };
export interface AuthoredSnapshot {
  readonly resource_ref: string;
  readonly revision: number;
  readonly value: AuthoredValue;
  readonly selection?: { anchor: number; head: number } | null;
}
export interface ConflictShown { readonly revision: number; readonly saved_version: number | string | null }
export class WritingDecisionError extends Error {}
export class WritingAbandonedError extends Error {}
type Dispatch = { kind: "sealed"; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: ApiPath; body_json: string | null; wire_revision: number };
export type WritingAck = Schema<"WritingAck">;
type CausalFacts = Pick<WritingAck, "identities" | "lanes" | "links" | "insertions" | "placements" | "deleted_refs"> & {
  notes: { id: string; body_version: number; body_pm_json: BodyJson }[];
  absolute_versions: { kind: "desired" | "initial_title"; ref: string; lane: "body" | "title"; from_version: number; version: number }[];
  local_note_bindings: { requested_id: string; canonical_id: string; version: number; body_pm_json: BodyJson;
    restore_intent_id: string; historical_body_matches: boolean }[];
};
export interface WritingBinding { from_ref: string; to_ref: string; retained?: { body_pm_json: BodyJson; version: number; historical_body_matches: boolean } }
export type BodyJson = Schema<"SetBody">["body_pm_json"];
export type WritingLane = "body" | "title" | "links" | "annotations" | "context";
export type LaneDependency =
  | { kind: "observed"; ref: string; lane: WritingLane; version: number }
  | { kind: "result"; write: WriteHandle; ref: string; lane: WritingLane; version: number };
/** An exact owned edge's source fence, never authority over an earlier position. */
export interface CreatedLinkSource {
  kind: "created_link";
  write: WriteHandle;
  requested_link_id: string;
  source_ref: string;
}
export type InsertionDependency = {
  kind: "insertion"; write: WriteHandle;
  requested_link_id: string; source_ref: string;
  version: number;
};
export type WritingPosition =
  | { after: string | null; expected_links_version: LaneDependency }
  | { after: string; predecessor: InsertionDependency };
export type RestoreNoteProof =
  | { kind: "pending"; write: WriteHandle; original_note_id: string }
  | { kind: "observed"; original_note_id: string; outcome:
      { kind: "deleted" } | { kind: "retained"; note: { id: string; body_pm_json: BodyJson; body_version: number } } };

type Command = Schema<"OutlineCommandsRequest">["commands"][number];
export type WritingCommand =
  | { kind: "restore_note"; removed_by: RestoreNoteProof;
      note_id: string; link_id: string; source: Schema<"InsertNote">["source"];
      body_pm_json: BodyJson; position: WritingPosition | null }
  | Omit<Schema<"SetBody">, "expected_version"> & { expected_version: LaneDependency }
  | Omit<Schema<"SetTitle">, "expected_version"> & { expected_version: LaneDependency }
  | Omit<Schema<"InsertNote">, "position"> & { position: WritingPosition | null }
  | Omit<Schema<"InsertLink">, "position"> & { position: WritingPosition | null }
  | Omit<Schema<"Move">, "expected_links_version"> & { expected_links_version: LaneDependency }
  | Omit<Schema<"Relink">, "position" | "expected_source_links_version"> & {
      position: WritingPosition | null; expected_source_links_version: LaneDependency | CreatedLinkSource;
    }
  | Omit<Schema<"Remove">, "expected_body_version" | "expected_links_version"> & { expected_body_version: LaneDependency | null; expected_links_version: LaneDependency | null }
  | Omit<Schema<"ConsumeNote">, "expected_body_version" | "expected_links_version"> & { expected_body_version: LaneDependency; expected_links_version: LaneDependency | null }
  | Omit<Schema<"Unlink">, "expected"> & { expected: { endpoint: string; links_version: LaneDependency | CreatedLinkSource } | null }
  | Extract<Command, { kind: "ensure_daily" }>;

export type WritingIntent =
  | { kind: "body"; policy: "autosave" | "explicit"; note_id: string; body_pm_json: BodyJson; expected: LaneDependency }
  | { kind: "title"; policy: "autosave" | "explicit"; page_id: string; title: string; expected: LaneDependency }
  | { kind: "page"; request: Schema<"CreatePageRequest"> }
  | { kind: "insert_note"; request: Extract<WritingCommand, { kind: "insert_note" }>; initial_title: string | null }
  | { kind: "capture"; local_date: string; request: Schema<"DailyCaptureRequest"> }
  | { kind: "passage"; media_id: string; request: Schema<"EnsureMediaHighlightRequest"> }
  | { kind: "attach_highlight"; highlight_id: string; request: Schema<"SetHighlightNoteRequest"> }
  | { kind: "detach_highlight"; highlight_id: string; note_id: string; link_id: string }
  | { kind: "highlight_update"; highlight_id: string; request: Schema<"UpdateHighlightRequest"> }
  | { kind: "highlight_delete"; highlight_id: string }
  | { kind: "highlight_note_delete"; highlight_id: string; request: Schema<"DeleteHighlightNoteRequest"> }
  | { kind: "outline"; commands: WritingCommand[] }
  | { kind: "resource_delete"; resource_kind: "page"; resource_id: string };

export type Publication = Extract<WritingIntent, { kind: "page" | "insert_note" | "capture" | "passage" | "attach_highlight" }>;

const REQUEST_DEADLINE_MS = 30_000;
const BODY_LIMIT = 4_500_000;
// justify-retry-schedule: browser writing permits long disconnection. Three attempts
// bound one automatic cycle; 1–30 s jitter avoids synchronized reconnect traffic.
// Explicit retry alone starts a new cycle; retry-after can lengthen this cadence.
const RETRY_POLICY = { attempts: 3, min_ms: 1_000, max_ms: 30_000 } as const;
const REJECTIONS = new Set([
  "E_FORBIDDEN", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND", "E_INVALID_REQUEST",
  "E_INVALID_KIND", "E_NOTE_CONFLICT", "E_RESOURCE_CONFLICT", "E_CONTEXT_CHANGED",
  "E_READER_CONTENT_CHANGED", "E_READER_STATE_CONFLICT", "E_MEDIA_NOT_READY",
  "E_MEDIA_NOT_FOUND", "E_MEDIA_DELETING", "E_HIGHLIGHT_INVALID_RANGE",
  "E_HIGHLIGHT_CONFLICT", "E_LINK_SELF", "E_LINK_CAPABILITY",
  "E_LINK_TARGET_AMBIGUOUS", "E_LINK_TARGET_STALE", "E_WRITING_DEPENDENCY_GONE",
  "E_WRITING_IDENTITY_REUSED", "E_WRITING_IDENTITY_CONFLICT",
]);
export function isWriteRejection(error: unknown): boolean {
  return error instanceof WritingDecisionError || (isApiError(error) && !isSameSystemApiDefect(error) && REJECTIONS.has(error.code));
}
interface Request {
  handle: WriteHandle;
  intent: WritingIntent;
  authored: readonly AuthoredSnapshot[];
  state: WriteState;
  listeners: Set<() => void>;
  resolve: (ack: WritingAck) => void;
  reject: (error: unknown) => void;
  dispatch: Dispatch | null;
  sealedIntent: WritingIntent | null;
  restored: CausalFacts["local_note_bindings"];
  attempts: number;
  uncertain: boolean;
  retryable: boolean;
  retryAt: number;
  generation: number;
}
const queue: Request[] = [];
const records = new WeakMap<WriteHandle, Request>();
const facts = new WeakMap<WriteHandle, CausalFacts>();
const admissions = new Set<(write: WriteHandle, snapshots: readonly AuthoredSnapshot[]) => void>();
const acknowledgements = new Set<(ack: WritingAck, write: WriteHandle) => void>();
const bindings = new Set<(value: readonly WritingBinding[]) => void>();
const listeners = new Set<() => void>();
let state: { account_id: string | null; paused: boolean; pending: readonly WriteHandle[]; generation: number } = { account_id: null, paused: true, pending: [], generation: 0 };
let generation = 0;
let runningGeneration: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let active: AbortController | null = null;
function emit(callbacks: Iterable<() => void>): void {
  for (const callback of [...callbacks]) { try { callback(); } catch (error) { reportError(error); } }
}
function publish(): void {
  state = { ...state, pending: queue.map(row => row.handle) }; emit(listeners);
}
function transition(row: Request, next: WriteState): void { row.state = next; emit(row.listeners); publish(); }
export function readWriting() { return state; }
export function writingAccount(): string | null { return state.account_id; }
export function subscribeWriting(listener: () => void): () => void { listeners.add(listener); return () => void listeners.delete(listener); }
export function subscribeWritingAcknowledgements(listener: (ack: WritingAck, write: WriteHandle) => void): () => void { acknowledgements.add(listener); return () => void acknowledgements.delete(listener); }
export function subscribeWritingBindings(listener: (value: readonly WritingBinding[]) => void): () => void { bindings.add(listener); return () => void bindings.delete(listener); }
export function subscribeWritingAdmissions(listener: (write: WriteHandle, snapshots: readonly AuthoredSnapshot[]) => void): () => void { admissions.add(listener); return () => void admissions.delete(listener); }
export function provenTextVersion(write: WriteHandle, ref: string, lane: "body" | "title", from: number): number | null { return facts.get(write)?.absolute_versions.find(fact => fact.kind === "desired" && fact.ref === ref && fact.lane === lane && fact.from_version === from)?.version ?? null; }
export function isTextPredecessor(write: WriteHandle, predecessor: WriteHandle, ref: string, lane: "body" | "title"): boolean {
  const row = records.get(write); if (!row || row.generation !== generation) return false;
  return dependencies(row.intent).some(dependency => dependency.ref === ref && dependency.lane === lane &&
    (dependency.write === predecessor || isTextPredecessor(dependency.write, predecessor, ref, lane)));
}
export function canRetryWriting(write: WriteHandle): boolean { const row = records.get(write); return row !== undefined && row.generation === generation && row.state.kind === "unconfirmed" && row.retryable; }
export function hasUnsettledWriting(): boolean { return queue.length > 0; }
export function startWritingRuntime(account_id: string): number {
  if (state.account_id === account_id) return generation;
  stopWritingRuntime(); state = { account_id, paused: false, pending: [], generation }; publish(); nudgeWrites(); return generation;
}
export function stopWritingRuntime(expectedGeneration?: number): void {
  if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
  generation += 1; active?.abort(); active = null;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const abandoned = queue.splice(0);
  state = { account_id: null, paused: true, pending: [], generation };
  for (const row of abandoned) { row.state = { kind: "abandoned" }; row.reject(new WritingAbandonedError("writing account ended")); emit(row.listeners); }
  publish();
}
export function pauseWriting(): void {
  state = { ...state, paused: true };
  if (timer !== null) { clearTimeout(timer); timer = null; }
  publish();
}
export function resumeWriting(): void {
  if (state.account_id === null) return;
  state = { ...state, paused: false }; publish(); nudgeWrites();
}
function sameAuthoredValue(a: AuthoredValue, b: AuthoredValue): boolean {
  return a.kind === b.kind && (a.kind === "body" && b.kind === "body"
    ? JSON.stringify(parseBody(a.body_pm_json).body_pm_json) === JSON.stringify(parseBody(b.body_pm_json).body_pm_json)
    : a.kind === "title" && b.kind === "title" && a.text === b.text);
}
function dependencies(intent: WritingIntent): { write: WriteHandle; ref?: string; lane?: WritingLane }[] {
  const found: { write: WriteHandle; ref?: string; lane?: WritingLane }[] = [];
  const lane = (value: LaneDependency) => { if (value.kind === "result") found.push(value); };
  const source = (value: LaneDependency | CreatedLinkSource) => {
    if (value.kind === "created_link") found.push(value); else lane(value);
  };
  const position = (value: WritingPosition | null) => {
    if (value === null) return;
    if ("predecessor" in value) found.push(value.predecessor); else lane(value.expected_links_version);
  };
  if (intent.kind === "body" || intent.kind === "title") lane(intent.expected);
  if (intent.kind === "insert_note") position(intent.request.position);
  if (intent.kind === "outline") for (const command of intent.commands) {
    switch (command.kind) {
      case "set_body":
      case "set_title": lane(command.expected_version); break;
      case "insert_note":
      case "insert_link": position(command.position); break;
      case "restore_note": if (command.removed_by.kind === "pending") found.push(command.removed_by); position(command.position); break;
      case "move": lane(command.expected_links_version); break;
      case "relink": source(command.expected_source_links_version); position(command.position); break;
      case "ensure_daily": break;
      case "unlink": if (command.expected !== null) source(command.expected.links_version); break;
      case "remove": if (command.expected_body_version !== null) lane(command.expected_body_version); if (command.expected_links_version !== null) lane(command.expected_links_version); break;
      case "consume_note": lane(command.expected_body_version); if (command.expected_links_version !== null) lane(command.expected_links_version); break;
    }
  }
  return found;
}
function canonicalId(kind: string, id: string, ack: CausalFacts): string {
  if (kind === "note_block") {
    const binding = ack.local_note_bindings.find(item => item.requested_id === id);
    if (binding) return binding.canonical_id;
  }
  const identity = ack.identities.find(item => item.kind === kind && item.requested_id === id);
  if (identity?.state === "deleted") throw new WritingDecisionError("the preceding change refers to a deleted identity");
  return identity?.canonical_id ?? id;
}
function canonicalRef(ref: string, ack: CausalFacts): string {
  const at = ref.indexOf(":");
  return at < 0 ? ref : `${ref.slice(0, at)}:${canonicalId(ref.slice(0, at), ref.slice(at + 1), ack)}`;
}
function retainedBinding(restore_intent_id: string, command: Extract<WritingCommand, { kind: "restore_note" }>, note: CausalFacts["notes"][number]): CausalFacts["local_note_bindings"][number] {
  return { requested_id: command.note_id, canonical_id: note.id, version: note.body_version, body_pm_json: note.body_pm_json, restore_intent_id,
    historical_body_matches: sameAuthoredValue({ kind: "body", body_pm_json: parseBody(command.body_pm_json).body_pm_json },
      { kind: "body", body_pm_json: parseBody(note.body_pm_json).body_pm_json }) };
}
function restorationFacts(intent: WritingIntent, settled: string, facts: CausalFacts, restore_intent_id: string): CausalFacts {
  if (intent.kind !== "outline") return facts;
  const bindings = [...facts.local_note_bindings];
  for (const command of intent.commands) {
    if (command.kind !== "restore_note" || command.removed_by.kind !== "pending" || command.removed_by.write.id !== settled) continue;
    const original = command.removed_by.original_note_id;
    if (facts.deleted_refs.includes(`note_block:${original}`)) continue;
    const retained = facts.notes.find(note => note.id === original);
    if (!retained) throw new WritingDecisionError("the removed note has no acknowledged retention decision");
    if (!bindings.some(item => item.requested_id === command.note_id))
      bindings.push(retainedBinding(restore_intent_id, command, retained));
  }
  return { ...facts, local_note_bindings: bindings };
}
function resolveLane(value: LaneDependency, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): LaneDependency {
  const ref = canonicalRef(value.ref, ack);
  const binding = ack.local_note_bindings.find(item => value.ref === `note_block:${item.requested_id}`);
  if (binding && value.lane === "body" && !binding.historical_body_matches) throw new WritingDecisionError("the retained note differs; review both versions before saving");
  if (binding && value.lane === "body") value = { ...value, ref, version: binding.version };
  const fact = ack.lanes.find(item => item.ref === ref && item.lane === value.lane);
  if (value.kind === "result") {
    const absolute = ack.absolute_versions.find(item => item.ref === ref && item.lane === value.lane &&
      (item.from_version === value.version || item.version === value.version));
    if (value.write.id !== settled) {
      if (!causal?.has(value.write.id)) return { ...value, ref };
      if (absolute) return { ...value, ref, version: absolute.version };
      if (!fact || fact.version === value.version) return { ...value, ref };
      if (fact.checked_from_version !== value.version)
        throw new WritingDecisionError("the captured version was not proven by the preceding change");
      return { ...value, ref, version: fact.version };
    }
    if (absolute) return { kind: "observed", ref, lane: value.lane, version: absolute.version };
    if (!fact || (fact.version !== value.version && fact.checked_from_version !== value.version))
      throw new WritingDecisionError("the preceding change did not prove this version");
    return { kind: "observed", ref, lane: value.lane, version: fact.version };
  }
  // Observed authority belongs to the captured branch/view. A matching receipt
  // from another write cannot turn that independent observation into causality.
  return { ...value, ref };
}
/** Only the named producer can acknowledge this exact live edge. The returned
 * source version may fence its removal; it cannot validate a captured position. */
function resolveLinkSource(value: LaneDependency | CreatedLinkSource, edgeId: string, endpoint: string,
  settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null): LaneDependency | CreatedLinkSource {
  if (value.kind !== "created_link") return resolveLane(value, settled, ack, causal);
  if (value.write.id !== settled) return {...value, source_ref: canonicalRef(value.source_ref, ack)};
  const insertion = ack.insertions.find(item => item.requested_link_id === value.requested_link_id);
  const source = canonicalRef(value.source_ref, ack);
  const edge = insertion && ack.links.find(link => link.link_id === insertion.canonical_link_id);
  const lane = ack.lanes.find(item => item.ref === source && item.lane === "links");
  if (!insertion?.created || insertion.source_ref !== source || canonicalRef(endpoint, ack) !== source ||
      canonicalId("link", edgeId, ack) !== insertion.canonical_link_id || !edge ||
      (edge.source_ref !== source && edge.target_ref !== source) || !lane)
    throw new WritingDecisionError("the preceding change did not prove this live link source");
  return {kind: "observed", ref: source, lane: "links", version: lane.version};
}
function resolvePosition(value: WritingPosition | null, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): WritingPosition | null {
  if (value === null) return null;
  if (!("predecessor" in value)) return { ...value, expected_links_version: resolveLane(value.expected_links_version, settled, ack, causal) };
  const proof = value.predecessor;
  if (proof.write.id !== settled) {
    const source_ref = canonicalRef(proof.source_ref, ack);
    if (!causal?.has(proof.write.id)) return { ...value, predecessor: { ...proof, source_ref } };
    const lane = ack.lanes.find(item => item.ref === source_ref && item.lane === "links");
    if (lane && lane.version !== proof.version && lane.checked_from_version !== proof.version)
      throw new WritingDecisionError("the captured insertion version was not proven");
    return { ...value, predecessor: { ...proof, source_ref, version: lane?.version ?? proof.version } };
  }
  const insertion = ack.insertions.find(item => item.requested_link_id === proof.requested_link_id);
  if (!insertion) throw new WritingDecisionError("the preceding insertion was not acknowledged");
  const placement = ack.placements.find(item => item.endpoint === insertion.source_ref && item.link_id === insertion.canonical_link_id);
  const lane = ack.lanes.find(item => item.ref === insertion.source_ref && item.lane === "links");
  if (!placement || !lane || lane.checked_from_version !== proof.version ||
      insertion.source_ref !== canonicalRef(proof.source_ref, ack))
    throw new WritingDecisionError("the preceding insertion did not prove this placement");
  return {
    after: value.after === proof.requested_link_id ? insertion.canonical_link_id : value.after,
    expected_links_version: { kind: "observed", ref: insertion.source_ref, lane: "links", version: lane.version },
  };
}
function resolveSource(source: Schema<"InsertLink">["source"], ack: CausalFacts): Schema<"InsertLink">["source"] {
  switch (source.kind) {
    case "resource": return { ...source, ref: canonicalRef(source.ref, ack) };
    case "daily_page": return { ...source, page_id: canonicalId("page", source.page_id, ack) };
    case "fragment_selection":
    case "pdf_selection": return { ...source, highlight_id: canonicalId("highlight", source.highlight_id, ack) };
    case "passage": return source;
  }
}
function resolveCommand(command: WritingCommand, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): WritingCommand {
  switch (command.kind) {
    case "restore_note": {
      if (command.removed_by.kind === "observed" || command.removed_by.write.id !== settled) return { ...command, source: resolveSource(command.source, ack), position: resolvePosition(command.position, settled, ack, causal) };
      const original = command.removed_by.original_note_id;
      const source = resolveSource(command.source, ack);
      const position = resolvePosition(command.position, settled, ack, causal);
      if (ack.deleted_refs.includes(`note_block:${original}`))
        return { kind: "insert_note", note_id: command.note_id, link_id: command.link_id, source, position, body_pm_json: command.body_pm_json };
      if (ack.notes.some(note => note.id === original))
        return { kind: "insert_link", source, position, link_id: command.link_id, target: { kind: "resource", ref: `note_block:${original}` }, require_created: true };
      throw new WritingDecisionError("the removed note has no acknowledged retention decision");
    }
    case "set_body": return { ...command, note_id: canonicalId("note_block", command.note_id, ack), expected_version: resolveLane(command.expected_version, settled, ack, causal) };
    case "set_title": return { ...command, page_id: canonicalId("page", command.page_id, ack), expected_version: resolveLane(command.expected_version, settled, ack, causal) };
    case "ensure_daily": return { ...command, page_id: canonicalId("page", command.page_id, ack) };
    case "insert_note": return { ...command, note_id: canonicalId("note_block", command.note_id, ack), link_id: canonicalId("link", command.link_id, ack), source: resolveSource(command.source, ack), position: resolvePosition(command.position, settled, ack, causal) };
    case "insert_link": return { ...command, link_id: canonicalId("link", command.link_id, ack), source: resolveSource(command.source, ack), target: command.target.kind === "resource" ? { ...command.target, ref: canonicalRef(command.target.ref, ack) } : command.target, position: resolvePosition(command.position, settled, ack, causal) };
    case "move": return { ...command, endpoint: canonicalRef(command.endpoint, ack), edge_id: canonicalId("link", command.edge_id, ack), after: command.after === null ? null : canonicalId("link", command.after, ack), expected_links_version: resolveLane(command.expected_links_version, settled, ack, causal) };
    case "relink": return { ...command, endpoint: canonicalRef(command.endpoint, ack), link_id: canonicalId("link", command.link_id, ack), destination: canonicalRef(command.destination, ack), new_link_id: canonicalId("link", command.new_link_id, ack), expected_source_links_version: resolveLinkSource(command.expected_source_links_version, command.link_id, command.endpoint, settled, ack, causal), position: resolvePosition(command.position, settled, ack, causal) };
    case "unlink": return { ...command, link_id: canonicalId("link", command.link_id, ack), expected: command.expected === null ? null : { endpoint: canonicalRef(command.expected.endpoint, ack), links_version: resolveLinkSource(command.expected.links_version, command.link_id, command.expected.endpoint, settled, ack, causal) } };
    case "remove": return { ...command, endpoint: canonicalRef(command.endpoint, ack), link_id: canonicalId("link", command.link_id, ack), expected_body_version: command.expected_body_version === null ? null : resolveLane(command.expected_body_version, settled, ack, causal), expected_links_version: command.expected_links_version === null ? null : resolveLane(command.expected_links_version, settled, ack, causal) };
    case "consume_note": return { ...command, endpoint: canonicalRef(command.endpoint, ack), link_id: canonicalId("link", command.link_id, ack), expected_body_version: resolveLane(command.expected_body_version, settled, ack, causal), expected_links_version: command.expected_links_version === null ? null : resolveLane(command.expected_links_version, settled, ack, causal) };
  }
}
function resolveIntent(intent: WritingIntent, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): WritingIntent {
  switch (intent.kind) {
    case "body": return { ...intent, note_id: canonicalId("note_block", intent.note_id, ack), expected: resolveLane(intent.expected, settled, ack, causal) };
    case "title": return { ...intent, page_id: canonicalId("page", intent.page_id, ack), expected: resolveLane(intent.expected, settled, ack, causal) };
    case "outline": return { ...intent, commands: intent.commands.map(command => resolveCommand(command, settled, ack, causal)) };
    case "insert_note": {
      const request = resolveCommand(intent.request, settled, ack, causal);
      if (request.kind !== "insert_note") throw new Error("insert-note result changed kind");
      return { ...intent, request };
    }
    case "page":
    case "capture":
    case "passage": return intent;
    case "attach_highlight": return { ...intent, highlight_id: canonicalId("highlight", intent.highlight_id, ack) };
    case "detach_highlight": return { ...intent, highlight_id: canonicalId("highlight", intent.highlight_id, ack), note_id: canonicalId("note_block", intent.note_id, ack), link_id: canonicalId("link", intent.link_id, ack) };
    case "highlight_update":
    case "highlight_delete":
    case "highlight_note_delete": return { ...intent, highlight_id: canonicalId("highlight", intent.highlight_id, ack) };
    case "resource_delete": return { ...intent, resource_id: canonicalId(intent.resource_kind, intent.resource_id, ack) };
  }
}
function version(value: LaneDependency | CreatedLinkSource): number {
  if (value.kind !== "observed") throw new WritingDecisionError("the preceding change still needs acknowledgement");
  return value.version;
}
function position(value: WritingPosition | null): Schema<"Position"> | null {
  if (value === null) return null;
  if ("predecessor" in value) throw new WritingDecisionError("the preceding insertion still needs acknowledgement");
  return { after: value.after, expected_links_version: version(value.expected_links_version) };
}
function command(value: WritingCommand): Schema<"OutlineCommandsRequest">["commands"][number] {
  switch (value.kind) {
    case "restore_note": throw new WritingDecisionError("the removed note still needs its acknowledged retention decision");
    case "set_body":
    case "set_title": return { ...value, expected_version: version(value.expected_version) };
    case "insert_note":
    case "insert_link": return { ...value, position: position(value.position) };
    case "move": return { ...value, expected_links_version: version(value.expected_links_version) };
    case "relink": return { ...value, position: position(value.position), expected_source_links_version: version(value.expected_source_links_version) };
    case "remove": return { ...value, expected_body_version: value.expected_body_version === null ? null : version(value.expected_body_version), expected_links_version: value.expected_links_version === null ? null : version(value.expected_links_version) };
    case "consume_note": return { ...value, expected_body_version: version(value.expected_body_version), expected_links_version: value.expected_links_version === null ? null : version(value.expected_links_version) };
    case "ensure_daily": return value;
    case "unlink": return { ...value, expected: value.expected === null ? null : { endpoint: value.expected.endpoint, links_version: version(value.expected.links_version) } };
  }
}
function freeze(intent: WritingIntent): Dispatch {
  let method: "POST" | "PUT" | "PATCH" | "DELETE";
  let path: ApiPath;
  let body: unknown = null;
  switch (intent.kind) {
    case "body":
      method = "POST"; path = "/api/resource-graph/commands";
      body = { commands: [{ kind: "set_body", note_id: intent.note_id, body_pm_json: intent.body_pm_json, expected_version: version(intent.expected) }] }; break;
    case "title":
      method = "POST"; path = "/api/resource-graph/commands";
      body = { commands: [{ kind: "set_title", page_id: intent.page_id, title: intent.title, expected_version: version(intent.expected) }] }; break;
    case "outline": method = "POST"; path = "/api/resource-graph/commands"; body = { commands: intent.commands.map(command) }; break;
    case "insert_note": {
      method = "POST"; path = "/api/resource-graph/commands";
      const commands: Schema<"OutlineCommandsRequest">["commands"] = [command(intent.request)];
      if (intent.initial_title !== null) {
        if (intent.request.source.kind !== "daily_page") throw new WritingDecisionError("an initial daily title needs its captured date and page");
        commands.push({ kind: "set_title", page_id: intent.request.source.page_id, title: intent.initial_title, expected_version: 1 });
      }
      body = { commands }; break;
    }
    case "page": method = "POST"; path = "/api/notes/pages"; body = intent.request; break;
    case "capture": method = "POST"; path = `/api/notes/daily/${encodeURIComponent(intent.local_date)}/captures`; body = intent.request; break;
    case "passage": method = "POST"; path = `/api/media/${intent.media_id}/highlights`; body = intent.request; break;
    case "attach_highlight": method = "PUT"; path = `/api/highlights/${intent.highlight_id}/note`; body = intent.request; break;
    case "detach_highlight": method = "DELETE"; path = `/api/highlights/${intent.highlight_id}/note/${intent.note_id}?link_id=${intent.link_id}`; break;
    case "highlight_update": method = "PATCH"; path = `/api/highlights/${intent.highlight_id}`; body = intent.request; break;
    case "highlight_delete": method = "DELETE"; path = `/api/highlights/${intent.highlight_id}`; break;
    case "highlight_note_delete": method = "POST"; path = `/api/highlights/${intent.highlight_id}/note/delete`; body = intent.request; break;
    case "resource_delete": method = "DELETE"; path = `/api/notes/pages/${intent.resource_id}`; break;
  }
  return { kind: "sealed", method, path, body_json: body === null ? null : JSON.stringify(body), wire_revision: WIRE_REVISION };
}
function touchedLane(intent: WritingIntent, ref: string, lane: WritingLane): boolean {
  if (intent.kind === "insert_note") return touchedLane({ kind: "outline", commands: [intent.request] }, ref, lane);
  if (intent.kind === "body") return lane === "body" && ref === `note_block:${intent.note_id}`;
  if (intent.kind === "title") return lane === "title" && ref === `page:${intent.page_id}`;
  if (intent.kind === "capture") return lane === "body" && ref === `note_block:${intent.request.note_id}`;
  if (intent.kind === "attach_highlight") return lane === "body" && ref === `note_block:${intent.request.note_id}`;
  if (intent.kind === "passage") return lane === "body" && intent.request.initial_note !== null && ref === `note_block:${intent.request.initial_note.note_id}`;
  if (intent.kind === "page") return (lane === "title" || lane === "links") && ref === `page:${intent.request.id}` ||
    lane === "body" && intent.request.initial_item.kind === "note" && ref === `note_block:${intent.request.initial_item.note_id}`;
  if (intent.kind !== "outline") return false;
  return intent.commands.some(command => {
    switch (command.kind) {
      case "set_body": return lane === "body" && ref === `note_block:${command.note_id}`;
      case "set_title": return lane === "title" && ref === `page:${command.page_id}`;
      case "ensure_daily": return lane === "links" && ref === `page:${command.page_id}`;
      case "insert_note":
      case "restore_note":
      case "insert_link": {
        const source = command.source;
        const sourceRef = source.kind === "resource" ? source.ref : source.kind === "daily_page" ? `page:${source.page_id}` : source.kind === "fragment_selection" || source.kind === "pdf_selection" ? `highlight:${source.highlight_id}` : null;
        return lane === "links" && ref === sourceRef || source.kind === "daily_page" && lane === "title" && ref === sourceRef || (command.kind === "insert_note" || command.kind === "restore_note") && lane === "body" && ref === `note_block:${command.note_id}`;
      }
      case "move": return lane === "links" && ref === command.endpoint;
      case "relink": return lane === "links" && (ref === command.endpoint || ref === command.destination);
      case "remove":
      case "consume_note": return lane === "links" && ref === command.endpoint;
      case "unlink": return false;
    }
  });
}

export function captureLane(ref: string, lane: WritingLane, version: number): LaneDependency {
  const preceding = queue.findLast(row => touchedLane(row.intent, ref, lane));
  return preceding ? { kind: "result", write: preceding.handle, ref, lane, version } : { kind: "observed", ref, lane, version };
}
export function creationDependency(ref: string, lane: "body" | "title"): LaneDependency | null {
  const row = queue.find(row => ["page", "insert_note", "capture", "passage", "attach_highlight", "outline"].includes(row.intent.kind) && touchedLane(row.intent, ref, lane));
  return row ? { kind: "result", write: row.handle, ref, lane, version: 1 } : null;
}
function cloneIntent(intent: WritingIntent): WritingIntent {
  // Handles are capabilities, not JSON. Copy all authored containers while retaining
  // the exact predecessor object; callers cannot change admitted text or position.
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (records.has(value as WriteHandle)) return value; // justify-type-assertion: weak-map identity narrows live capabilities.
    if (Array.isArray(value)) return value.map(clone);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  };
  return clone(intent) as WritingIntent; // justify-type-assertion: structural clone preserves the typed input shape.
}
export function admitWriting(intent: WritingIntent, authored: readonly AuthoredSnapshot[] = []): WriteHandle {
  if (state.account_id === null || state.paused) throw new WritingDecisionError("writing is paused");
  let resolve!: (ack: WritingAck) => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<WritingAck>((yes, no) => { resolve = yes; reject = no; });
  // A handle can outlive its presenter; an abandoned/refused result is still
  // observable by its owner without producing an unhandled promise rejection.
  void settled.catch(() => undefined); // justify-ignore-error: the original promise remains rejected for its live owner.
  const handle: WriteHandle = {
    id: crypto.randomUUID(), settled,
    read: () => row.state,
    subscribe(listener) { row.listeners.add(listener); return () => void row.listeners.delete(listener); },
    retry() {
      if (row.state.kind !== "unconfirmed" || !row.retryable || row.generation !== generation) return;
      row.attempts = 0; row.retryAt = 0; transition(row, { kind: "queued" }); nudgeWrites();
    },
  };
  const row: Request = { handle, intent: cloneIntent(intent), authored: structuredClone(authored), state: { kind: "queued" }, listeners: new Set(),
    resolve, reject, dispatch: null, sealedIntent: null, restored: [], attempts: 0, uncertain: false, retryable: true, retryAt: 0, generation };
  records.set(handle, row); queue.push(row);
  for (const listener of [...admissions]) { try { listener(handle, row.authored.filter(snapshot => touchedLane(row.intent, snapshot.resource_ref, snapshot.value.kind === "title" ? "title" : "body"))); } catch (error) { reportError(error); } }
  publish(); queueMicrotask(nudgeWrites); return handle;
}
function refuse(row: Request, error: unknown): void {
  const at = queue.indexOf(row); if (at >= 0) queue.splice(at, 1);
  row.reject(error); transition(row, { kind: "refused", error });
}
function seal(row: Request): void {
  let intent = row.intent;
  const visited = new Set<string>();
  const ancestors = new Map<WriteHandle, Set<string>>();
  function ancestry(write: WriteHandle): Set<string> {
    const known = ancestors.get(write); if (known) return known;
    const found = new Set<string>(); ancestors.set(write, found);
    const predecessor = records.get(write);
    if (!predecessor || predecessor.generation !== generation) throw new WritingDecisionError("the preceding change belongs to another account lifetime");
    for (const dependency of dependencies(predecessor.intent)) {
      found.add(dependency.write.id); for (const id of ancestry(dependency.write)) found.add(id);
    }
    return found;
  }
  for (const dependency of dependencies(intent)) ancestry(dependency.write);
  function apply(write: WriteHandle): void {
    if (visited.has(write.id)) return;
    const predecessor = records.get(write);
    if (!predecessor || predecessor.generation !== generation) throw new WritingDecisionError("the preceding change belongs to another account lifetime");
    for (const dependency of dependencies(predecessor.intent)) apply(dependency.write);
    const result = write.read();
    if (result.kind !== "accepted") throw new WritingDecisionError("the preceding change was not accepted");
    const accepted = facts.get(write);
    if (!accepted) throw new Error("accepted writing has no canonical proof");
    const proof = restorationFacts(intent, write.id, accepted, row.handle.id);
    const causal = new Set([...ancestors].filter(([, previous]) => previous.has(write.id)).map(([handle]) => handle.id));
    for (const binding of proof.local_note_bindings) if (binding.restore_intent_id === row.handle.id && !row.restored.some(value => value.requested_id === binding.requested_id)) row.restored.push(binding);
    intent = resolveIntent(intent, write.id, proof, causal);
    visited.add(write.id);
  }
  for (const dependency of dependencies(intent)) apply(dependency.write);
  // An observed retained-note inverse can be admitted after its remove settled.
  if (intent.kind === "outline") intent = { ...intent, commands: intent.commands.map(command => {
    if (command.kind !== "restore_note" || command.removed_by.kind !== "observed") return command;
    const outcome = command.removed_by.outcome;
    if (outcome.kind === "deleted") return { kind: "insert_note", note_id: command.note_id, link_id: command.link_id, source: command.source, position: command.position, body_pm_json: command.body_pm_json };
    row.restored.push(retainedBinding(row.handle.id, command, { id: outcome.note.id, body_pm_json: outcome.note.body_pm_json, body_version: outcome.note.body_version }));
    return { kind: "insert_link", source: command.source, position: command.position, link_id: command.link_id, target: { kind: "resource", ref: `note_block:${outcome.note.id}` }, require_created: true };
  }) };
  const dispatch = freeze(intent);
  if (new TextEncoder().encode(dispatch.body_json ?? "").length > BODY_LIMIT) throw new WritingDecisionError("this change is too large to save");
  row.sealedIntent = intent; row.dispatch = dispatch;
  if (row.restored.length > 0) {
    const aliases: WritingBinding[] = row.restored.map(binding => ({ from_ref: `note_block:${binding.requested_id}`, to_ref: `note_block:${binding.canonical_id}`, retained: { body_pm_json: binding.body_pm_json, version: binding.version, historical_body_matches: binding.historical_body_matches } }));
    for (const listener of [...bindings]) { try { listener(aliases); } catch (error) { reportError(error); } }
  }
}
function acknowledgementFacts(row: Request, ack: WritingAck): CausalFacts {
  const result: CausalFacts = { ...ack, notes: ack.notes, absolute_versions: [], local_note_bindings: row.restored };
  const body = (id: string, desired: BodyJson, from: number) => {
    if (ack.identities.some(identity => identity.kind === "note_block" && identity.requested_id === id && identity.state === "deleted")) return;
    const ref = canonicalRef(`note_block:${id}`, result);
    const note = ack.notes.find(note => `note_block:${note.id}` === ref);
    if (note && sameAuthoredValue({ kind: "body", body_pm_json: desired }, { kind: "body", body_pm_json: note.body_pm_json })) result.absolute_versions.push({ kind: "desired", ref, lane: "body", from_version: from, version: note.body_version });
  };
  const title = (id: string, desired: string, from: number) => {
    if (ack.identities.some(identity => identity.kind === "page" && identity.requested_id === id && identity.state === "deleted")) return;
    const ref = canonicalRef(`page:${id}`, result);
    const page = ack.pages.find(page => `page:${page.id}` === ref);
    if (page?.title === desired) result.absolute_versions.push({ kind: "desired", ref, lane: "title", from_version: from, version: page.title_version });
  };
  const value = row.sealedIntent!;
  if (value.kind === "body") body(value.note_id, value.body_pm_json, value.expected.version);
  if (value.kind === "title") title(value.page_id, value.title, value.expected.version);
  if (value.kind === "page") {
    title(value.request.id, value.request.title, 1);
    if (value.request.initial_item.kind === "note") body(value.request.initial_item.note_id, value.request.initial_item.body_pm_json, 1);
  }
  if (value.kind === "attach_highlight") body(value.request.note_id, value.request.body_pm_json, value.request.expected.kind === "version" ? value.request.expected.version : 1);
  if (value.kind === "passage" && value.request.initial_note !== null) body(value.request.initial_note.note_id, value.request.initial_note.body_pm_json, 1);
  if (value.kind === "capture") {
    const content = value.request.text.split("\n").flatMap((line, index) => [
      ...(index > 0 ? [{ type: "hard_break" }] : []), ...(line ? [{ type: "text", text: line }] : []),
    ]);
    body(value.request.note_id, parseBody({ type: "paragraph", content }).body_pm_json, 1);
  }
  const commands = value.kind === "outline" ? value.commands : value.kind === "insert_note" ? [value.request] : [];
  for (const command of commands) {
    if (command.kind === "set_body") body(command.note_id, command.body_pm_json, command.expected_version.version);
    if (command.kind === "set_title") title(command.page_id, command.title, command.expected_version.version);
    if (command.kind === "insert_note") body(command.note_id, command.body_pm_json, 1);
  }
  if (value.kind === "insert_note" && value.request.source.kind === "daily_page") {
    if (value.initial_title !== null) title(value.request.source.page_id, value.initial_title, 1);
    else {
      const ref = canonicalRef(`page:${value.request.source.page_id}`, result);
      const page = ack.pages.find(page => `page:${page.id}` === ref);
      if (page?.title_version === 1) result.absolute_versions.push({ kind: "initial_title", ref, lane: "title", from_version: 1, version: 1 });
    }
  }
  for (const binding of row.restored) if (binding.historical_body_matches) body(binding.canonical_id, binding.body_pm_json, binding.version);
  return result;
}
async function attempt(row: Request): Promise<void> {
  if (row.dispatch === null) {
    try { seal(row); } catch (error) { if (error instanceof WritingDecisionError) { refuse(row, error); return; } throw error; }
  }
  const dispatch = row.dispatch!;
  const controller = new AbortController(); active = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_DEADLINE_MS);
  row.attempts += 1; transition(row, { kind: "sending" });
  let ack: WritingAck;
  try {
    const reply = await apiFetch<ApiJson<"/resource-graph/commands", "post">>(dispatch.path, { method: dispatch.method, body: dispatch.body_json, signal: controller.signal });
    ack = reply.data;
  } catch (error) {
    if (row.generation !== generation) return;
    const transient = outcomeUnknown(error) || (isApiError(error) && error.code === "E_RATE_LIMITED");
    const authOrWire = isApiError(error) && (error.status === 401 || error.code === "E_WIRE_MISMATCH");
    if (authOrWire) { row.uncertain = true; row.retryable = false; pauseWriting(); handleUnauthenticatedApiError(error); transition(row, { kind: "unconfirmed", error }); return; }
    if (isWriteRejection(error)) {
      if (!row.uncertain) { refuse(row, error); return; }
      row.retryable = false; transition(row, { kind: "unconfirmed", error }); return;
    }
    if (!transient && !timedOut) throw error;
    row.uncertain = true;
    if (row.attempts >= RETRY_POLICY.attempts) { transition(row, { kind: "unconfirmed", error }); return; }
    const backoff = Math.min(RETRY_POLICY.max_ms, RETRY_POLICY.min_ms * 2 ** (row.attempts - 1));
    row.retryAt = Date.now() + Math.max(isApiError(error) ? error.retryAfterMs ?? 0 : 0, RETRY_POLICY.min_ms, Math.round(backoff * (0.5 + Math.random() * 0.5)));
    transition(row, { kind: "queued" }); return;
  } finally { clearTimeout(timeout); if (active === controller) active = null; }
  if (row.generation !== generation) return;
  // Acceptance is terminal before any callback. Callback defects are isolated;
  // even a broken presenter cannot resend an accepted mutation or stop the fifo.
  row.state = { kind: "accepted", ack };
  try {
    facts.set(row.handle, acknowledgementFacts(row, ack));
    const aliases = ack.identities.filter(item => item.state !== "deleted" && item.requested_id !== item.canonical_id).map(item => ({ from_ref: `${item.kind}:${item.requested_id}`, to_ref: `${item.kind}:${item.canonical_id}` }));
    for (const listener of [...bindings]) { try { listener(aliases); } catch (error) { reportError(error); } }
    for (const listener of [...acknowledgements]) { try { listener(ack, row.handle); } catch (error) { reportError(error); } }
  } catch (error) { pauseWriting(); reportError(error); }
  finally {
    row.resolve(ack); const at = queue.indexOf(row); if (at >= 0) queue.splice(at, 1); emit(row.listeners); publish();
  }
}
async function pump(): Promise<void> {
  if (runningGeneration === generation || state.paused || state.account_id === null || !remoteReady() || (typeof navigator !== "undefined" && !navigator.onLine)) return;
  const captured = generation; runningGeneration = captured;
  try {
    while (captured === generation && !state.paused && remoteReady() && (typeof navigator === "undefined" || navigator.onLine)) {
      const row = queue[0];
      if (!row || row.state.kind === "unconfirmed") break;
      const failed = dependencies(row.intent).find(value => ["refused", "abandoned"].includes(value.write.read().kind));
      if (failed) { refuse(row, new WritingDecisionError("the preceding change was refused")); continue; }
      if (row.retryAt > Date.now()) break;
      await attempt(row);
    }
  } catch (error) {
    // justify-defect: unclassified same-system failures violate the typed writer
    // contract. Stop delivery and report; never call them connectivity failures.
    if (captured === generation) { pauseWriting(); reportError(error); }
  } finally {
    if (runningGeneration === captured) runningGeneration = null;
    const next = queue[0];
    if (captured === generation && !state.paused && remoteReady() && (typeof navigator === "undefined" || navigator.onLine) && next?.state.kind === "queued" && next.retryAt > Date.now()) timer = setTimeout(nudgeWrites, next.retryAt - Date.now());
    if (captured !== generation) nudgeWrites();
  }
}
export function nudgeWrites(): void { if (timer !== null) { clearTimeout(timer); timer = null; } void pump(); }
subscribeAdmission(() => { if (!remoteReady() && timer !== null) { clearTimeout(timer); timer = null; } else nudgeWrites(); });
if (typeof window !== "undefined") {
  window.addEventListener("online", nudgeWrites);
  window.addEventListener("offline", () => { if (timer !== null) { clearTimeout(timer); timer = null; } });
}
