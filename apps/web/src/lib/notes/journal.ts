"use client";

/**
 * Account-scoped authoring journal. Draft branches belong to exclusive web locks;
 * checkpoints and admitted work commit together with strict indexeddb durability.
 * A fresh UUID belongs synchronously to its leased runtime; every durable write
 * waits for that branch's lock. Existing branches require a granted claim.
 * Only authored values, their exact bases/context and delivery facts persist.
 * Acknowledgements merge bases and dependencies, never a newer authored revision.
 * Requests retry their sealed bytes; local intent ids never enter the wire.
 * An acknowledged outbox row retains the exact outcome until its live origin
 * consumes it. An independent observer lock lets another runtime prune outcomes
 * only after that origin is gone. These terminal rows never drain or retry.
 * Causal facts live only with real authored branches and unresolved consumers;
 * retained note bodies prove the exact base when undo relinks a surviving note.
 * Observed lanes stay at their captured version. Result lanes advance only on
 * their named predecessor or a proven ancestor in the current outbox graph.
 */
import type { Schema } from "@/lib/api/wire";
import type { ApiPath } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { Passage } from "@/lib/documentReader/DocumentReader";
import { parseBody } from "./noteBody";

export type WritingAck = Schema<"WritingAck">;
type CausalFacts = Pick<WritingAck, "identities" | "lanes" | "insertions" | "placements" | "deleted_refs"> & {
  notes: { id: string; body_version: number; body_pm_json: BodyJson }[];
  local_note_bindings: { requested_id: string; canonical_id: string; version: number; body_pm_json: BodyJson }[];
};
export interface WritingBinding { from_ref: string; to_ref: string }
export type BodyJson = Schema<"SetBody">["body_pm_json"];
export type WritingLane = "body" | "title" | "links" | "annotations" | "context";
export type LaneDependency =
  | { kind: "observed"; ref: string; lane: WritingLane; version: number }
  | { kind: "result"; intent_id: string; draft_id: string | null; ref: string; lane: WritingLane; version: number };
export type InsertionDependency = {
  kind: "insertion"; intent_id: string; draft_id: string | null;
  requested_link_id: string; source_ref: string;
  version: number;
};
export type WritingPosition =
  | { after: string | null; expected_links_version: LaneDependency }
  | { after: string; predecessor: InsertionDependency };
export type RestoreNoteProof =
  | { kind: "pending"; intent_id: string; draft_id: string | null; original_note_id: string }
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
      position: WritingPosition | null; expected_source_links_version: LaneDependency;
    }
  | Omit<Schema<"Remove">, "expected_body_version" | "expected_links_version"> & { expected_body_version: LaneDependency | null; expected_links_version: LaneDependency | null }
  | Omit<Schema<"ConsumeNote">, "expected_body_version" | "expected_links_version"> & { expected_body_version: LaneDependency; expected_links_version: LaneDependency | null }
  | Omit<Schema<"Unlink">, "expected"> & { expected: { endpoint: string; links_version: LaneDependency } | null }
  | Extract<Command, { kind: "ensure_daily" }>;

export type WritingIntent =
  | { kind: "body"; policy: "autosave" | "explicit"; note_id: string; body_pm_json: BodyJson; expected: LaneDependency }
  | { kind: "title"; policy: "autosave" | "explicit"; page_id: string; title: string; expected: LaneDependency }
  | { kind: "page"; request: Schema<"CreatePageRequest"> }
  | { kind: "insert_note"; request: Extract<WritingCommand, { kind: "insert_note" }>; initial_title: string | null }
  | { kind: "capture"; local_date: string; request: Schema<"DailyCaptureRequest"> }
  | { kind: "passage"; media_id: string; request: Schema<"EnsureMediaHighlightRequest"> }
  | { kind: "attach_highlight"; highlight_id: string; request: Schema<"SetHighlightNoteRequest"> }
  | { kind: "attach_link"; link_id: string; request: Schema<"SetLinkNoteRequest"> }
  | { kind: "detach_highlight"; highlight_id: string; note_id: string; link_id: string }
  | { kind: "detach_link"; link_id: string; note_id: string; source_link_id: string; target_link_id: string }
  | { kind: "highlight_update"; highlight_id: string; request: Schema<"UpdateHighlightRequest"> }
  | { kind: "highlight_delete"; highlight_id: string }
  | { kind: "highlight_note_delete"; highlight_id: string; request: Schema<"DeleteHighlightNoteRequest"> }
  | { kind: "outline"; commands: WritingCommand[] }
  | { kind: "resource_delete"; resource_kind: "page"; resource_id: string };

export type Publication = Extract<WritingIntent, { kind: "page" | "insert_note" | "capture" | "passage" | "attach_highlight" | "attach_link" }>;
export type DraftContext =
  | { kind: "composer"; resource_ref: string; publication: Extract<Publication, { kind: "insert_note" }> }
  | { kind: "body"; resource_ref: string; publication: Publication | null }
  | { kind: "title"; resource_ref: string; publication: Extract<Publication, { kind: "page" | "insert_note" }> | null }
  | { kind: "capture"; local_date: string; note_id: string; link_id: string }
  | { kind: "passage"; media_id: string; resource_ref: string;
      passage: Passage & { quote: string };
      source: Schema<"LinkFragmentSelectionSource"> | Schema<"LinkPdfSelectionSource">;
      publication: Extract<Publication, { kind: "passage" | "attach_highlight" }> }
  | { kind: "reference"; source: Schema<"InsertLink">["source"]; position: WritingPosition | null; resource_ref: string | null };

export type DraftValue =
  | { kind: "body"; body_pm_json: BodyJson }
  | { kind: "title"; text: string }
  | { kind: "capture"; text: string }
  | { kind: "reference"; raw: string; base_body_pm_json: BodyJson };
export type DraftSelection = { anchor: number; head: number } | null;
export type DraftBase = { value: DraftValue; version: number | string } | null;
export interface DraftConflict {
  reason: string;
  saved_value: DraftValue | null;
  saved_version: number | string | null;
  other_draft_id: string | null;
}
export interface DraftSnapshot {
  draft_id: string;
  resource_ref: string | null;
  context: DraftContext;
  value: DraftValue;
  base: DraftBase;
  revision: number;
  selection: DraftSelection;
  conflict: DraftConflict | null;
  updated_at: number;
  /** Facts retained only by this branch and its unresolved causal consumers. */
  results: { intent_id: string; ack: CausalFacts }[];
}
export interface DraftHandle {
  /** May change after the owner removes a wholly acknowledged checkpoint. */
  draft_id: string;
}
export interface AuthoredSnapshot {
  draft_id: string;
  revision: number;
  value: DraftValue;
  selection: DraftSelection;
  conflict: DraftConflict | null;
}
export interface ReferenceConsumption { readonly draft_id: string; readonly revision: number }
export type Dispatch =
  | { kind: "unsealed" }
  | { kind: "sealed"; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: ApiPath; body_json: string | null; wire_revision: number };
export interface OutboxRow {
  sequence: number | null;
  intent_id: string;
  origin_runtime: string;
  acknowledged: WritingAck | null;
  intent: WritingIntent;
  authored: { draft_id: string; revision: number; value: DraftValue }[];
  dispatch: Dispatch;
  blocked: { code: string; request_id: string | null; current: unknown } | null;
  retry_at: number | null;
  uncertain: boolean;
  first_admitted_at: number;
  dispatch_after: number;
}
export interface RecoveryEnvelope {
  schema_revision: number;
  recovery_label: string;
  recovery_text: string;
  payload: unknown;
}
export interface WritingSnapshot {
  account_id: string | null;
  drafts: readonly DraftSnapshot[];
  outbox: readonly OutboxRow[];
  incompatible: readonly RecoveryEnvelope[];
  storage_error: string | null;
  paused: boolean;
  persistent: boolean | null;
}
export type SignOutResult =
  | { kind: "ready" }
  | { kind: "other_tabs" }
  | { kind: "needs_resolution" }
  | { kind: "needs_download_receipt" }
  | { kind: "cancelled" };
export interface WritingRuntimeToken { readonly account_id: string; readonly generation: number }

const SCHEMA_REVISION = 1;
const AUTOSAVE_IDLE_MS = 250;
const AUTOSAVE_MAX_MS = 2_000;
const CONTEXT_DEPENDENCY_INDEXES = ["position_predecessor", "position_lane", "publication_predecessor", "publication_lane"];
const drafts = new Map<string, DraftSnapshot>();
const durableRevisions = new Map<string, number>();
const handles = new Map<string, DraftHandle>();
const branchUsers = new Map<string, number>();
const cleanBranches = new Set<string>();
const cleaningBranches = new Set<string>();
const branchReady = new Map<string, Promise<void>>();
const draftListeners = new Map<string, Set<() => void>>();
const listeners = new Set<() => void>();
const acknowledgements = new Set<(ack: WritingAck) => void>();
const bindingListeners = new Set<(bindings: readonly WritingBinding[]) => void>();
const releases = new Map<string, () => void>();
const pendingAdmissions = new Map<string, OutboxRow>();
const pendingReferenceConsumes = new Map<string, { reference: ReferenceConsumption; body_draft_id: string; body_revision: number }>();
const terminalResults = new Map<string, OutboxRow>();
const consumingResults = new Set<string>();
const publishedResults = new Set<string>();
const admittedObservers = new Set<string>();
const admissionWaiters = new Map<string, {
  resolve: (ack: WritingAck) => void; reject: (error: unknown) => void;
}[]>();
let state: WritingSnapshot = { account_id: null, drafts: [], outbox: [], incompatible: [], storage_error: null, paused: true, persistent: null };
let database: IDBDatabase | null = null;
let channel: BroadcastChannel | null = null;
let admissionStopped = true;
let epoch = 0;
let runtimeGeneration = 0;
let pending: Promise<void> = Promise.resolve();
let releaseRuntime: (() => void) | null = null;
let releaseObserver: (() => void) | null = null;
let runtimeId: string | null = null;
let releaseSignOut: (() => void) | null = null;
let releaseExclusive: (() => void) | null = null;
let verifyAccount: (() => Promise<string | null>) | null = null;
let attempt: AbortController | null = null;
let attemptFinished: Promise<void> = Promise.resolve();
let signOutReview: { choice: "sync" | "download" | "discard"; fingerprint: string } | null = null;
let lastExport: { generation: number; fingerprint: string } | null = null;

function emit(callbacks: Iterable<() => void>): void {
  for (const callback of callbacks) {
    try { callback(); } catch (error) { reportError(error); }
  }
}
function publish(id: string | null = null): void {
  state = { ...state, drafts: [...drafts.values()] };
  if (id !== null) emit(draftListeners.get(id) ?? []);
  emit(listeners);
}
function invalidate(id: string, revision: number): void {
  channel?.postMessage({ account_id: state.account_id, id, revision });
}
function storageFailure(error: unknown): void {
  state = { ...state, storage_error: error instanceof Error ? error.message : String(error),
    outbox: state.outbox.map(row => row.dispatch.kind === "sealed" ? { ...row, uncertain: true } : row) };
  publish();
}
export class WritingDecisionError extends Error {}
function runLocal<T>(work: () => Promise<T>): Promise<T> {
  const generation = epoch;
  const result = pending.then(async () => {
    if (generation !== epoch) throw new Error("writing runtime changed");
    if (state.storage_error !== null) throw new Error(state.storage_error);
    try { return await work(); }
    catch (error) { if (!(error instanceof WritingDecisionError)) storageFailure(error); throw error; }
  });
  pending = result.then(() => undefined, () => undefined);
  return result;
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
/** Callbacks await indexeddb requests only; external work cannot split a commit. */
export async function journalTransaction<T>(
  mode: IDBTransactionMode,
  work: (draftStore: IDBObjectStore, outboxStore: IDBObjectStore) => Promise<T>,
  opaqueDiscard = false,
): Promise<T> {
  if (database === null) throw new Error("writing journal is not open");
  if (database.version !== SCHEMA_REVISION && mode === "readwrite" && !opaqueDiscard)
    throw new Error("this writing journal requires its original application version");
  const tx = database.transaction(["drafts", "outbox"], mode, { durability: "strict" });
  return new Promise((resolve, reject) => {
    let value: T;
    let failure: unknown = null;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("writing commit aborted"));
    tx.onerror = () => { failure ??= tx.error; };
    void work(tx.objectStore("drafts"), tx.objectStore("outbox")).then(
      result => { value = result; },
      error => { failure = error; tx.abort(); },
    );
  });
}
function textOf(value: DraftValue): string {
  switch (value.kind) {
    case "body": return parseBody(value.body_pm_json).body_text;
    case "title":
    case "capture": return value.text;
    case "reference": return value.raw;
  }
}
function contextLabel(context: DraftContext): string {
  switch (context.kind) {
    case "body":
    case "title":
    case "composer": return context.resource_ref;
    case "capture": return `daily capture · ${context.local_date}`;
    case "passage": return `passage · media:${context.media_id}`;
    case "reference": return `reference · ${context.resource_ref ?? context.source.kind}`;
  }
}
function draftEnvelope(draft: DraftSnapshot): RecoveryEnvelope {
  return { schema_revision: SCHEMA_REVISION, recovery_label: contextLabel(draft.context), recovery_text: textOf(draft.value), payload: draft };
}
function outboxEnvelope(row: OutboxRow): RecoveryEnvelope & { authored_branch: string | null } {
  const { sequence, ...withoutSequence } = row;
  return { schema_revision: SCHEMA_REVISION, recovery_label: row.intent.kind, recovery_text: row.authored.map(item => textOf(item.value)).join("\n\n"),
    authored_branch: row.authored.length === 1 ? row.authored[0]!.draft_id : null, payload: sequence === null ? withoutSequence : row };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid writing journal object");
  // justify-type-assertion: the object check narrows the indexeddb boundary.
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("invalid writing journal string");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("invalid writing journal integer");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("invalid writing journal array");
  return value;
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row = object(value);
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key)))
    throw new TypeError("unsupported writing journal fields");
  return row;
}
function boolean(value: unknown): void { if (typeof value !== "boolean") throw new TypeError("invalid writing journal boolean"); }
function choice(value: unknown, values: readonly string[]): void { if (!values.includes(string(value))) throw new TypeError("unsupported writing journal variant"); }
function nullableString(value: unknown): void { if (value !== null) string(value); }
function body(value: unknown): void { parseBody(value); }
function color(value: unknown): void { choice(value, ["yellow", "green", "blue", "pink", "purple"]); }
function quads(value: unknown): void {
  for (const item of array(value)) {
    const quad = shape(item, ["x1", "x2", "x3", "x4", "y1", "y2", "y3", "y4"]);
    for (const coordinate of Object.values(quad)) if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) throw new TypeError("invalid passage geometry");
  }
}
function checkSource(value: unknown): void {
  const row = object(value);
  switch (row.kind) {
    case "resource": shape(row, ["kind", "ref"]); string(row.ref); break;
    case "passage": shape(row, ["kind", "candidate_ref"]); string(row.candidate_ref); break;
    case "daily_page": shape(row, ["kind", "local_date", "page_id"]); string(row.local_date); string(row.page_id); break;
    case "fragment_selection":
      shape(row, ["kind", "highlight_id", "fragment_id", "start_offset", "end_offset", "color", "expected_reader_generation"]);
      string(row.highlight_id); string(row.fragment_id); integer(row.start_offset); integer(row.end_offset); color(row.color); if (row.expected_reader_generation !== null) integer(row.expected_reader_generation); break;
    case "pdf_selection":
      shape(row, ["kind", "highlight_id", "media_id", "page_number", "quads", "color", "expected_reader_generation"], ["exact"]);
      string(row.highlight_id); string(row.media_id); integer(row.page_number); quads(row.quads); color(row.color); if (row.expected_reader_generation !== null) integer(row.expected_reader_generation); if (row.exact !== undefined) string(row.exact); break;
    default: throw new TypeError("unsupported writing source");
  }
}
function checkExpected(value: unknown, link: boolean): void {
  const row = object(value);
  if (row.kind === "version" || row.kind === "absent" && !link) {
    shape(row, ["kind", "version"]); integer(row.version);
  } else if (row.kind === "absent" && link) {
    shape(row, ["kind", "source_ref", "links_version"]); string(row.source_ref); integer(row.links_version);
  } else throw new TypeError("unsupported annotation expectation");
}
function envelope(value: unknown): RecoveryEnvelope {
  const row = object(value);
  integer(row.schema_revision); string(row.recovery_label); string(row.recovery_text);
  if (!("payload" in row)) throw new TypeError("missing writing journal payload");
  // justify-type-assertion: the stable header is checked; unsupported outer
  // fields and payload remain intact for opaque recovery export.
  return row as unknown as RecoveryEnvelope;
}
function decodeValue(value: unknown): DraftValue {
  const row = object(value);
  switch (row.kind) {
    case "body": shape(row, ["kind", "body_pm_json"]); return { kind: "body", body_pm_json: parseBody(row.body_pm_json).body_pm_json };
    case "title": shape(row, ["kind", "text"]); return { kind: "title", text: string(row.text) };
    case "capture": shape(row, ["kind", "text"]); return { kind: "capture", text: string(row.text) };
    case "reference": shape(row, ["kind", "raw", "base_body_pm_json"]); return { kind: "reference", raw: string(row.raw), base_body_pm_json: parseBody(row.base_body_pm_json).body_pm_json };
    default: throw new TypeError("unsupported writing value");
  }
}
function checkDependency(value: unknown): void {
  const row = object(value);
  if (row.kind !== "observed" && row.kind !== "result") throw new TypeError("unsupported writing dependency");
  shape(row, row.kind === "observed" ? ["kind", "ref", "lane", "version"] : ["kind", "intent_id", "draft_id", "ref", "lane", "version"]);
  string(row.ref);
  if (!["body", "title", "links", "annotations", "context"].includes(string(row.lane))) throw new TypeError("unsupported writing lane");
  if (row.kind === "observed") integer(row.version);
  else { string(row.intent_id); if (row.draft_id !== null) string(row.draft_id); integer(row.version); }
}
function checkPosition(value: unknown): void {
  if (value === null) return;
  const row = object(value);
  if (row.after !== null) string(row.after);
  if ("predecessor" in row) {
    shape(row, ["after", "predecessor"]);
    const proof = shape(row.predecessor, ["kind", "intent_id", "draft_id", "requested_link_id", "source_ref", "version"]);
    if (proof.kind !== "insertion") throw new TypeError("unsupported insertion dependency");
    string(proof.intent_id); if (proof.draft_id !== null) string(proof.draft_id); string(proof.requested_link_id); string(proof.source_ref); integer(proof.version);
  } else { shape(row, ["after", "expected_links_version"]); checkDependency(row.expected_links_version); }
}
function checkCommand(value: unknown): void {
  const row = object(value);
  switch (row.kind) {
    case "set_body": shape(row, ["kind", "note_id", "body_pm_json", "expected_version"]); string(row.note_id); body(row.body_pm_json); checkDependency(row.expected_version); break;
    case "set_title": shape(row, ["kind", "page_id", "title", "expected_version"]); string(row.page_id); string(row.title); checkDependency(row.expected_version); break;
    case "insert_note": shape(row, ["kind", "note_id", "link_id", "source", "body_pm_json", "position"]); string(row.note_id); string(row.link_id); checkSource(row.source); body(row.body_pm_json); checkPosition(row.position); break;
    case "restore_note": {
      shape(row, ["kind", "removed_by", "note_id", "link_id", "source", "body_pm_json", "position"]);
      const predecessor = object(row.removed_by);
      if (predecessor.kind === "pending") {
        shape(predecessor, ["kind", "intent_id", "draft_id", "original_note_id"]);
        string(predecessor.intent_id); nullableString(predecessor.draft_id);
      } else if (predecessor.kind === "observed") {
        shape(predecessor, ["kind", "original_note_id", "outcome"]);
        const outcome = object(predecessor.outcome);
        if (outcome.kind === "deleted") shape(outcome, ["kind"]);
        else if (outcome.kind === "retained") {
          shape(outcome, ["kind", "note"]); const note = shape(outcome.note, ["id", "body_pm_json", "body_version"]);
          string(note.id); body(note.body_pm_json); integer(note.body_version);
        } else throw new TypeError("unsupported observed removal outcome");
      } else throw new TypeError("unsupported removal proof");
      string(predecessor.original_note_id);
      string(row.note_id); string(row.link_id); checkSource(row.source); body(row.body_pm_json); checkPosition(row.position); break;
    }
    case "insert_link": shape(row, ["kind", "link_id", "source", "target", "position", "require_created"]); string(row.link_id); checkSource(row.source); checkSource(row.target); choice(object(row.target).kind, ["resource", "passage"]); checkPosition(row.position); boolean(row.require_created); break;
    case "move": shape(row, ["kind", "endpoint", "edge_id", "after", "expected_links_version"]); string(row.endpoint); string(row.edge_id); nullableString(row.after); checkDependency(row.expected_links_version); break;
    case "relink": shape(row, ["kind", "endpoint", "link_id", "destination", "new_link_id", "position", "expected_source_links_version"]); string(row.endpoint); string(row.link_id); string(row.destination); string(row.new_link_id); checkPosition(row.position); checkDependency(row.expected_source_links_version); break;
    case "ensure_daily": shape(row, ["kind", "local_date", "page_id"]); string(row.local_date); string(row.page_id); break;
    case "unlink": shape(row, ["kind", "link_id", "require_unannotated", "expected"]); string(row.link_id); boolean(row.require_unannotated); if (row.expected !== null) { const expected = shape(row.expected, ["endpoint", "links_version"]); string(expected.endpoint); checkDependency(expected.links_version); } break;
    case "remove":
    case "consume_note": shape(row, ["kind", "endpoint", "link_id", "expected_body_version", "expected_links_version"]); string(row.endpoint); string(row.link_id); if (row.expected_body_version !== null || row.kind === "consume_note") checkDependency(row.expected_body_version); if (row.expected_links_version !== null) checkDependency(row.expected_links_version); break;
    default: throw new TypeError("unsupported writing command");
  }
}
function checkIntent(value: unknown): void {
  const row = object(value);
  switch (row.kind) {
    case "body": shape(row, ["kind", "policy", "note_id", "body_pm_json", "expected"]); choice(row.policy, ["autosave", "explicit"]); string(row.note_id); body(row.body_pm_json); checkDependency(row.expected); break;
    case "title": shape(row, ["kind", "policy", "page_id", "title", "expected"]); choice(row.policy, ["autosave", "explicit"]); string(row.page_id); string(row.title); checkDependency(row.expected); break;
    case "outline": shape(row, ["kind", "commands"]); for (const command of array(row.commands)) checkCommand(command); break;
    case "page": {
      shape(row, ["kind", "request"]);
      const request = shape(row.request, ["id", "title", "initial_item"]);
      string(request.id); string(request.title);
      const initial = object(request.initial_item);
      if (initial.kind === "note") { shape(initial, ["kind", "note_id", "link_id", "body_pm_json"]); string(initial.note_id); string(initial.link_id); body(initial.body_pm_json); }
      else if (initial.kind === "resource") { shape(initial, ["kind", "link_id", "target"]); string(initial.link_id); checkSource(initial.target); choice(object(initial.target).kind, ["resource", "passage"]); }
      else throw new TypeError("unsupported initial page item");
      break;
    }
    case "capture": { shape(row, ["kind", "local_date", "request"]); string(row.local_date); const request = shape(row.request, ["note_id", "link_id", "text"]); string(request.note_id); string(request.link_id); string(request.text); break; }
    case "insert_note": {
      shape(row, ["kind", "request", "initial_title"]); checkCommand(row.request); if (object(row.request).kind !== "insert_note") throw new TypeError("unsupported note publication"); nullableString(row.initial_title); break;
    }
    case "passage": {
      shape(row, ["kind", "media_id", "request"]); string(row.media_id);
      const request = shape(row.request, ["id", "anchor", "color", "expected_reader_generation", "initial_note"]);
      string(request.id); color(request.color); integer(request.expected_reader_generation);
      const anchor = object(request.anchor);
      if (anchor.kind === "text") { shape(anchor, ["kind", "unit_id", "start_offset", "end_offset"]); string(anchor.unit_id); integer(anchor.start_offset); integer(anchor.end_offset); }
      else if (anchor.kind === "pdf") { shape(anchor, ["kind", "page_number", "quads"], ["exact"]); integer(anchor.page_number); quads(anchor.quads); if (anchor.exact !== undefined) string(anchor.exact); }
      else throw new TypeError("unsupported passage anchor");
      if (request.initial_note !== null) { const initial = shape(request.initial_note, ["note_id", "link_id", "body_pm_json"]); string(initial.note_id); string(initial.link_id); body(initial.body_pm_json); }
      break;
    }
    case "attach_highlight": { shape(row, ["kind", "highlight_id", "request"]); string(row.highlight_id); const request = shape(row.request, ["note_id", "link_id", "body_pm_json", "expected"]); string(request.note_id); string(request.link_id); body(request.body_pm_json); checkExpected(request.expected, false); break; }
    case "attach_link": { shape(row, ["kind", "link_id", "request"]); string(row.link_id); const request = shape(row.request, ["note_id", "source_link_id", "target_link_id", "body_pm_json", "expected"]); string(request.note_id); string(request.source_link_id); string(request.target_link_id); body(request.body_pm_json); checkExpected(request.expected, true); break; }
    case "detach_highlight": shape(row, ["kind", "highlight_id", "note_id", "link_id"]); string(row.highlight_id); string(row.note_id); string(row.link_id); break;
    case "detach_link": shape(row, ["kind", "link_id", "note_id", "source_link_id", "target_link_id"]); string(row.link_id); string(row.note_id); string(row.source_link_id); string(row.target_link_id); break;
    case "highlight_update": {
      shape(row, ["kind", "highlight_id", "request"]); string(row.highlight_id);
      const request = shape(row.request, ["expected_version"], ["color", "exact", "anchor", "expected_reader_generation"]);
      string(request.expected_version); if (request.color !== undefined && request.color !== null) color(request.color); if (request.exact !== undefined) nullableString(request.exact);
      if (request.expected_reader_generation !== undefined && request.expected_reader_generation !== null) integer(request.expected_reader_generation);
      if (request.anchor !== undefined && request.anchor !== null) {
        const anchor = object(request.anchor);
        if (anchor.type === "fragment_offsets") { shape(anchor, ["type", "unit_id", "start_offset", "end_offset"]); string(anchor.unit_id); integer(anchor.start_offset); integer(anchor.end_offset); }
        else if (anchor.type === "pdf_page_geometry") { shape(anchor, ["type", "page_number", "quads"]); integer(anchor.page_number); quads(anchor.quads); }
        else throw new TypeError("unsupported highlight update anchor");
      }
      break;
    }
    case "highlight_delete": shape(row, ["kind", "highlight_id"]); string(row.highlight_id); break;
    case "highlight_note_delete": { shape(row, ["kind", "highlight_id", "request"]); string(row.highlight_id); const request = shape(row.request, ["note_id", "expected_version"]); string(request.note_id); integer(request.expected_version); break; }
    case "resource_delete": shape(row, ["kind", "resource_kind", "resource_id"]); string(row.resource_id); if (row.resource_kind !== "page") throw new TypeError("unsupported resource deletion"); break;
    default: throw new TypeError("unsupported writing intent");
  }
}
function checkContext(value: unknown): void {
  const row = object(value);
  switch (row.kind) {
    case "composer": shape(row, ["kind", "resource_ref", "publication"]); string(row.resource_ref); checkIntent(row.publication); choice(object(row.publication).kind, ["insert_note"]); break;
    case "body":
    case "title": shape(row, ["kind", "resource_ref", "publication"]); string(row.resource_ref); if (row.publication !== null) { checkIntent(row.publication); choice(object(row.publication).kind, row.kind === "title" ? ["page", "insert_note"] : ["page", "insert_note", "capture", "passage", "attach_highlight", "attach_link"]); } break;
    case "capture": shape(row, ["kind", "local_date", "note_id", "link_id"]); string(row.local_date); string(row.note_id); string(row.link_id); break;
    case "passage": {
      shape(row, ["kind", "media_id", "resource_ref", "publication", "passage", "source"]);
      string(row.media_id); string(row.resource_ref); checkIntent(row.publication); choice(object(row.publication).kind, ["passage", "attach_highlight"]); checkSource(row.source); choice(object(row.source).kind, ["fragment_selection", "pdf_selection"]);
      const passage = shape(row.passage, ["identity", "quote", "anchor"]); string(passage.identity); string(passage.quote);
      const anchor = object(passage.anchor);
      if (anchor.kind === "text") { shape(anchor, ["kind", "unit", "start", "end"]); string(anchor.unit); integer(anchor.start); integer(anchor.end); }
      else if (anchor.kind === "pdf") { shape(anchor, ["kind", "page", "quads"]); integer(anchor.page); quads(anchor.quads); }
      else throw new TypeError("unsupported visual passage anchor"); break;
    }
    case "reference": shape(row, ["kind", "source", "position", "resource_ref"]); checkSource(row.source); checkPosition(row.position); nullableString(row.resource_ref); break;
    default: throw new TypeError("unsupported draft context");
  }
}
function checkFacts(value: unknown): void {
  const facts = shape(value, ["identities", "lanes", "insertions", "placements", "deleted_refs", "notes", "local_note_bindings"]);
  for (const value of array(facts.identities)) {
    const row = shape(value, ["kind", "requested_id", "canonical_id", "state"]);
    choice(row.kind, ["page", "note_block", "highlight", "link"]); string(row.requested_id); string(row.canonical_id); choice(row.state, ["live", "deleted"]);
  }
  for (const value of array(facts.lanes)) {
    const row = shape(value, ["ref", "lane", "before_version", "version", "checked_from_version"]);
    string(row.ref); choice(row.lane, ["body", "title", "links", "annotations", "context"]); integer(row.version);
    if (row.before_version !== null) integer(row.before_version);
    if (row.checked_from_version !== null) integer(row.checked_from_version);
  }
  for (const value of array(facts.insertions)) {
    const row = shape(value, ["requested_link_id", "source_ref", "canonical_link_id", "created"]);
    string(row.requested_link_id); string(row.source_ref); string(row.canonical_link_id); boolean(row.created);
  }
  for (const value of array(facts.placements)) {
    const row = shape(value, ["endpoint", "link_id", "after_link_id"]);
    string(row.endpoint); string(row.link_id); nullableString(row.after_link_id);
  }
  for (const value of array(facts.deleted_refs)) string(value);
  for (const value of array(facts.notes)) { const row = shape(value, ["id", "body_version", "body_pm_json"]); string(row.id); integer(row.body_version); body(row.body_pm_json); }
  for (const value of array(facts.local_note_bindings)) {
    const row = shape(value, ["requested_id", "canonical_id", "version", "body_pm_json"]);
    string(row.requested_id); string(row.canonical_id); integer(row.version); body(row.body_pm_json);
  }
}
function checkAcknowledgement(value: unknown): void {
  const ack = shape(value, ["identities", "notes", "pages", "highlights", "links", "insertions", "placements", "removed_link_ids", "deleted_refs", "lanes"]);
  checkFacts({ identities: ack.identities, lanes: ack.lanes, insertions: ack.insertions, placements: ack.placements, deleted_refs: ack.deleted_refs,
    notes: array(ack.notes).map(value => { const note = object(value); return { id: note.id, body_version: note.body_version, body_pm_json: note.body_pm_json }; }), local_note_bindings: [] });
  for (const value of array(ack.notes)) { const note = shape(value, ["id", "body_pm_json", "body_text", "body_version"]); body(note.body_pm_json); string(note.body_text); }
  for (const value of array(ack.pages)) { const page = shape(value, ["id", "title", "title_version", "daily_date"]); string(page.id); string(page.title); integer(page.title_version); nullableString(page.daily_date); }
  for (const value of array(ack.links)) { const link = shape(value, ["link_id", "source_ref", "target_ref", "origin"]); string(link.link_id); string(link.source_ref); string(link.target_ref); string(link.origin); }
  for (const value of array(ack.removed_link_ids)) string(value);
  for (const value of array(ack.highlights)) {
    const highlight = shape(value, ["id", "version", "anchor", "color", "exact", "prefix", "suffix", "created_at", "updated_at", "author_user_id"]);
    for (const key of ["id", "version", "exact", "prefix", "suffix", "created_at", "updated_at", "author_user_id"]) string(highlight[key]);
    color(highlight.color);
    const anchor = object(highlight.anchor);
    if (anchor.type === "fragment_offsets") { shape(anchor, ["type", "media_id", "fragment_id", "start_offset", "end_offset"]); string(anchor.media_id); nullableString(anchor.fragment_id); if (anchor.start_offset !== null) integer(anchor.start_offset); if (anchor.end_offset !== null) integer(anchor.end_offset); }
    else if (anchor.type === "pdf_page_geometry") { shape(anchor, ["type", "media_id", "page_number", "quads"]); string(anchor.media_id); integer(anchor.page_number); quads(anchor.quads); }
    else throw new TypeError("unsupported acknowledged highlight anchor");
  }
}
function decodeDraft(value: unknown): DraftSnapshot {
  const row = shape(value, ["draft_id", "resource_ref", "context", "value", "base", "revision", "selection", "conflict", "updated_at", "results"]);
  string(row.draft_id); integer(row.revision); integer(row.updated_at);
  if (row.resource_ref !== null) string(row.resource_ref);
  checkContext(row.context); row.value = decodeValue(row.value);
  if (row.base !== null) {
    const base = shape(row.base, ["value", "version"]); base.value = decodeValue(base.value);
    if (typeof base.version !== "string") integer(base.version);
  }
  if (row.selection !== null) {
    const selection = shape(row.selection, ["anchor", "head"]); integer(selection.anchor); integer(selection.head);
  }
  if (row.conflict !== null) {
    const conflict = shape(row.conflict, ["reason", "saved_value", "saved_version", "other_draft_id"]); string(conflict.reason);
    if (conflict.saved_value !== null) conflict.saved_value = decodeValue(conflict.saved_value);
    if (conflict.saved_version !== null && typeof conflict.saved_version !== "string") integer(conflict.saved_version);
    if (conflict.other_draft_id !== null) string(conflict.other_draft_id);
  }
  for (const result of array(row.results)) { const fact = shape(result, ["intent_id", "ack"]); string(fact.intent_id); checkFacts(fact.ack); }
  // justify-type-assertion: the versioned persisted boundary validates discriminants,
  // scalar ownership fields and rich values before exposing the current payload.
  return row as unknown as DraftSnapshot;
}
function decodeOutbox(value: unknown): OutboxRow {
  const row = shape(value, ["sequence", "intent_id", "origin_runtime", "acknowledged", "intent", "authored", "dispatch", "blocked", "retry_at", "uncertain", "first_admitted_at", "dispatch_after"]);
  string(row.origin_runtime);
  if (row.sequence !== null) integer(row.sequence);
  const dispatch = object(row.dispatch);
  if (dispatch.kind === "sealed") {
    shape(dispatch, ["kind", "method", "path", "body_json", "wire_revision"]);
    if (integer(dispatch.wire_revision) !== WIRE_REVISION) throw new TypeError("incompatible sealed wire revision");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(string(dispatch.method))) throw new TypeError("unsupported writing method");
    if (!string(dispatch.path).startsWith("/api/")) throw new TypeError("invalid writing path");
    if (dispatch.body_json !== null) string(dispatch.body_json);
  } else if (dispatch.kind !== "unsealed") throw new TypeError("unsupported writing dispatch");
  else shape(dispatch, ["kind"]);
  string(row.intent_id); checkIntent(row.intent);
  if (row.acknowledged !== null) checkAcknowledgement(row.acknowledged);
  for (const authored of array(row.authored)) {
    const item = shape(authored, ["draft_id", "revision", "value"]); string(item.draft_id); integer(item.revision); item.value = decodeValue(item.value);
  }
  if (row.blocked !== null) { const blocked = shape(row.blocked, ["code", "request_id", "current"]); string(blocked.code); nullableString(blocked.request_id); }
  if (typeof row.uncertain !== "boolean") throw new TypeError("invalid writing uncertainty");
  if (row.retry_at !== null) integer(row.retry_at);
  integer(row.first_admitted_at); integer(row.dispatch_after);
  // justify-type-assertion: the versioned outbox boundary checks its closed variants,
  // timing/identity fields and every authored rich body above.
  return row as unknown as OutboxRow;
}
export function readWriting(): WritingSnapshot { return state; }
export function subscribeWriting(listener: () => void): () => void {
  listeners.add(listener); return () => void listeners.delete(listener);
}
export function subscribeWritingAcknowledgements(listener: (ack: WritingAck) => void): () => void {
  acknowledgements.add(listener); return () => void acknowledgements.delete(listener);
}
export function subscribeWritingBindings(listener: (bindings: readonly WritingBinding[]) => void): () => void {
  bindingListeners.add(listener); return () => void bindingListeners.delete(listener);
}
function publishBindings(facts: CausalFacts): void {
  if (facts.local_note_bindings.length === 0) return;
  const bindings = facts.local_note_bindings.map(item => ({ from_ref: `note_block:${item.requested_id}`, to_ref: `note_block:${item.canonical_id}` }));
  for (const listener of bindingListeners) {
    try { listener(bindings); } catch (error) { reportError(error); }
  }
}
export function readDraft(id: string): DraftSnapshot | undefined { return drafts.get(id); }
export function snapshotDraft(handle: DraftHandle): AuthoredSnapshot {
  const draft = drafts.get(handle.draft_id);
  // justify-defect: only an opened branch supplies an authoring handle.
  if (!draft || handles.get(handle.draft_id) !== handle) throw new Error("draft handle is no longer open");
  return { draft_id: draft.draft_id, revision: draft.revision, value: draft.value, selection: draft.selection, conflict: draft.conflict };
}
export function subscribeDraft(id: string, listener: () => void): () => void {
  let scoped = draftListeners.get(id);
  if (!scoped) { scoped = new Set(); draftListeners.set(id, scoped); }
  scoped.add(listener); return () => { scoped.delete(listener); if (!scoped.size) draftListeners.delete(id); };
}

async function lock(name: string, mode: LockMode, available = false): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    void navigator.locks.request(name, { mode, ...(available ? { ifAvailable: true } : {}) }, async granted => {
      if (!granted) { resolve(null); return; }
      await new Promise<void>(release => { resolve(release); });
    }).catch(reject);
  });
}
function lockName(suffix: string): string {
  if (state.account_id === null) throw new Error("writing account is not active");
  return `nexus-writing:${state.account_id}:${suffix}`;
}
function canonicalConflictBase(conflict: DraftConflict | null): { value: DraftValue; version: number } | null {
  return conflict !== null && conflict.other_draft_id === null && conflict.reason !== "another local draft differs" &&
    conflict.saved_value !== null && typeof conflict.saved_version === "number"
    ? { value: conflict.saved_value, version: conflict.saved_version } : null;
}
function adoptDraft(saved: DraftSnapshot): void {
  durableRevisions.set(saved.draft_id, saved.revision);
  const local = drafts.get(saved.draft_id);
  const comparison = canonicalConflictBase(saved.conflict);
  const localComparison = canonicalConflictBase(local?.conflict ?? null);
  let localVersion = typeof local?.base?.version === "number" ? local.base.version : null;
  if (localComparison !== null && (localVersion === null || localComparison.version > localVersion)) localVersion = localComparison.version;
  const conflict = local?.conflict === null || local?.conflict === undefined ? saved.conflict
    : comparison !== null && (localVersion === null || comparison.version > localVersion) ? saved.conflict : local.conflict;
  drafts.set(saved.draft_id, local && releases.has(saved.draft_id) && local.revision > saved.revision
    ? { ...saved, value: local.value, revision: local.revision, selection: local.selection, conflict, updated_at: local.updated_at }
    : saved);
  if (local?.resource_ref !== saved.resource_ref) for (const result of saved.results) {
    const bindings = result.ack.local_note_bindings.filter(binding => local?.resource_ref === `note_block:${binding.requested_id}` && saved.resource_ref === `note_block:${binding.canonical_id}`);
    if (bindings.length > 0) publishBindings({ ...result.ack, local_note_bindings: bindings });
  }
}
function settleObservedRefusals(): void {
  for (const id of admittedObservers) {
    if (!admissionWaiters.has(id)) { admittedObservers.delete(id); continue; }
    const row = state.outbox.find(row => row.intent_id === id);
    if (row?.blocked !== null && row?.blocked !== undefined && !row.uncertain || !row && !pendingAdmissions.has(id) && !terminalResults.has(id)) {
      const error = new WritingDecisionError(row?.blocked?.code ?? "delivery stopped; review your writing");
      for (const waiter of admissionWaiters.get(id) ?? []) waiter.reject(error);
      admissionWaiters.delete(id); admittedObservers.delete(id);
    }
  }
}
async function consumeAcknowledgement(row: OutboxRow): Promise<void> {
  if (row.acknowledged === null || consumingResults.has(row.intent_id)) return;
  consumingResults.add(row.intent_id);
  const generation = epoch;
  try {
    if (row.origin_runtime === runtimeId) {
      if (!publishedResults.has(row.intent_id)) {
        publishedResults.add(row.intent_id);
        for (const waiter of admissionWaiters.get(row.intent_id) ?? []) waiter.resolve(row.acknowledged);
        admissionWaiters.delete(row.intent_id); admittedObservers.delete(row.intent_id);
        for (const listener of acknowledgements) {
          try { listener(row.acknowledged); } catch (error) { reportError(error); }
        }
      }
      await deleteTerminal(row, generation);
    } else {
      await navigator.locks.request(lockName(`observer:${row.origin_runtime}`), { ifAvailable: true }, async granted => {
        if (granted) await deleteTerminal(row, generation);
      });
    }
  } finally { consumingResults.delete(row.intent_id); }
}
async function deleteTerminal(row: OutboxRow, generation: number): Promise<void> {
  if (generation !== epoch) return;
  await journalTransaction("readwrite", async (_drafts, outbox) => {
    const raw = await request(outbox.index("intent_id").get(row.intent_id));
    if (raw === undefined) return;
    const current = decodeOutbox(envelope(raw).payload);
    if (current.acknowledged !== null && current.sequence !== null) await request(outbox.delete(current.sequence));
  });
  terminalResults.delete(row.intent_id);
  publishedResults.delete(row.intent_id);
  for (const authored of row.authored) void cleanupAcknowledgedDraft(authored.draft_id);
}
async function refreshEntry(id: string): Promise<void> {
  if (id === "*") { await refreshJournal(); return; }
  const generation = epoch;
  const [draftRaw, outboxRaw] = await journalTransaction("readonly", async (draftStore, outboxStore) =>
    Promise.all([request(draftStore.get(id)), request(outboxStore.index("intent_id").get(id))]));
  if (generation !== epoch) return;
  if (draftRaw !== undefined) {
    const outer = envelope(draftRaw);
    if (outer.schema_revision !== SCHEMA_REVISION) { await refreshJournal(); return; }
    try { adoptDraft(decodeDraft(outer.payload)); }
    catch (error) { if (!(error instanceof TypeError)) throw error; await refreshJournal(); return; }
    publish(id);
  } else if (outboxRaw !== undefined) {
    const outer = envelope(outboxRaw);
    if (outer.schema_revision !== SCHEMA_REVISION) { await refreshJournal(); return; }
    let row: OutboxRow;
    try { row = decodeOutbox(outer.payload); }
    catch (error) { if (!(error instanceof TypeError)) throw error; await refreshJournal(); return; }
    if (row.acknowledged !== null) {
      terminalResults.set(row.intent_id, row);
      state = { ...state, outbox: state.outbox.filter(item => item.intent_id !== row.intent_id) };
      await refreshJournal(); return;
    }
    state = { ...state, outbox: [...state.outbox.filter(item => item.sequence !== row.sequence), row].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) };
    publish();
    settleObservedRefusals();
  } else {
    state = { ...state, outbox: state.outbox.filter(row => row.intent_id !== id) };
    if (!releases.has(id)) { drafts.delete(id); durableRevisions.delete(id); }
    publish(id);
    settleObservedRefusals();
  }
}
export async function refreshJournal(): Promise<void> {
  const generation = epoch;
  const [storedDrafts, storedOutbox] = await journalTransaction("readonly", async (draftStore, outboxStore) =>
    Promise.all([request(draftStore.getAll()), request(outboxStore.getAll())]));
  if (generation !== epoch) return;
  const incompatible: RecoveryEnvelope[] = [];
  const foundDrafts = new Set<string>();
  for (const raw of storedDrafts) {
    const outer = envelope(raw);
    if (outer.schema_revision !== SCHEMA_REVISION || database?.version !== SCHEMA_REVISION) { incompatible.push(outer); continue; }
    let saved: DraftSnapshot;
    try { saved = decodeDraft(outer.payload); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      incompatible.push(outer); continue;
    }
    foundDrafts.add(saved.draft_id);
    adoptDraft(saved);
  }
  for (const id of drafts.keys())
    if (!foundDrafts.has(id) && !releases.has(id) && durableRevisions.has(id)) {
      drafts.delete(id); durableRevisions.delete(id); emit(draftListeners.get(id) ?? []);
    } else if (foundDrafts.has(id)) emit(draftListeners.get(id) ?? []);
  const outbox: OutboxRow[] = [];
  for (const raw of storedOutbox) {
    const outer = envelope(raw);
    if (outer.schema_revision !== SCHEMA_REVISION || database?.version !== SCHEMA_REVISION) { incompatible.push(outer); continue; }
    try {
      const row = decodeOutbox(outer.payload);
      if (row.acknowledged === null) outbox.push(row); else terminalResults.set(row.intent_id, row);
    }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      incompatible.push(outer);
    }
  }
  state = { ...state, outbox, incompatible };
  publish();
  for (const row of terminalResults.values()) await consumeAcknowledgement(row);
  settleObservedRefusals();
  for (const id of foundDrafts) void cleanupAcknowledgedDraft(id);
}
function openJournal(account_id: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(`nexus-writing:${account_id}`);
    let blocked = false;
    opening.onupgradeneeded = () => {
      const db = opening.result;
      const drafts = db.createObjectStore("drafts", { keyPath: "payload.draft_id" });
      drafts.createIndex("position_predecessor", "payload.context.position.predecessor.intent_id");
      drafts.createIndex("position_lane", "payload.context.position.expected_links_version.intent_id");
      drafts.createIndex("publication_predecessor", "payload.context.publication.request.position.predecessor.intent_id");
      drafts.createIndex("publication_lane", "payload.context.publication.request.position.expected_links_version.intent_id");
      const outbox = db.createObjectStore("outbox", { keyPath: "payload.sequence", autoIncrement: true });
      outbox.createIndex("intent_id", "payload.intent_id", { unique: true });
      outbox.createIndex("field", ["payload.intent.kind", "authored_branch"]);
    };
    opening.onsuccess = () => { if (blocked) opening.result.close(); else resolve(opening.result); };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => { blocked = true; reject(new Error("close the other writing tabs before opening this journal")); };
  });
}
function watchJournalVersion(db: IDBDatabase): void {
  const generation = epoch;
  db.onversionchange = () => {
    if (generation !== epoch) return;
    admissionStopped = true; state = { ...state, paused: true }; db.close(); database = null; publish();
  };
}
function openJournalChannel(account_id: string): void {
  channel = new BroadcastChannel(`nexus-writing:${account_id}`);
  channel.onmessage = event => {
    const value = object(event.data);
    const id = value.id;
    if (value.account_id === account_id && typeof id === "string" && typeof value.revision === "number")
      void pending.then(() => refreshEntry(id)).catch(storageFailure);
  };
}
export async function startWritingRuntime(account_id: string, authenticatedAccount: () => Promise<string | null>): Promise<void> {
  if (state.account_id === account_id && database !== null) return;
  await stopWritingRuntime();
  state = { ...state, account_id, paused: true, storage_error: null };
  verifyAccount = authenticatedAccount;
  const starting = epoch;
  let authenticated = false;
  let ownLease: (() => void) | null = null;
  let opened: IDBDatabase | null = null;
  const gate = await lock(`nexus-writing:${account_id}:signout`, "shared");
  try {
    if (starting !== epoch) throw new WritingDecisionError("writing account changed");
    ownLease = await lock(`nexus-writing:${account_id}:runtime`, "shared");
    if (starting !== epoch) throw new WritingDecisionError("writing account changed");
    releaseRuntime = ownLease;
    const verified = await authenticatedAccount();
    if (starting !== epoch || verified !== account_id) throw new WritingDecisionError("authenticated writing account changed");
    authenticated = true;
    const observerId = crypto.randomUUID();
    const observerRelease = await lock(`nexus-writing:${account_id}:observer:${observerId}`, "exclusive");
    if (starting !== epoch) { observerRelease?.(); throw new WritingDecisionError("writing account changed"); }
    runtimeId = observerId; releaseObserver = observerRelease;
    opened = await openJournal(account_id);
    if (starting !== epoch) throw new WritingDecisionError("writing account changed");
    database = opened;
    const generation = epoch;
    watchJournalVersion(database);
    await refreshJournal();
    if (starting !== epoch) throw new WritingDecisionError("writing account changed");
    openJournalChannel(account_id);
    admissionStopped = false; state = { ...state, paused: false }; publish();
    void navigator.storage.persist().then(persistent => { if (generation === epoch) { state = { ...state, persistent }; publish(); } }).catch(storageFailure);
  } catch (error) {
    if (starting !== epoch) { opened?.close(); ownLease?.(); throw error; }
    if (!authenticated) { ownLease?.(); releaseRuntime = null; throw error; }
    // Storage can fail while the authenticated account still owns authored
    // memory. Keep its lease and memory/export path; never fall back to sending.
    admissionStopped = false; state = { ...state, paused: false }; storageFailure(error);
  } finally { gate?.(); }
}
export async function stopWritingRuntime(): Promise<void> {
  admissionStopped = true;
  attempt?.abort();
  await attemptFinished;
  await pending;
  epoch += 1;
  runtimeGeneration += 1;
  for (const release of releases.values()) release();
  releases.clear(); releaseRuntime?.(); releaseRuntime = null;
  releaseExclusive?.(); releaseExclusive = null; releaseSignOut?.(); releaseSignOut = null;
  releaseObserver?.(); releaseObserver = null; runtimeId = null;
  channel?.close(); channel = null; database?.close(); database = null;
  drafts.clear(); durableRevisions.clear(); handles.clear(); pendingAdmissions.clear(); pendingReferenceConsumes.clear(); admissionWaiters.clear();
  branchUsers.clear();
  terminalResults.clear(); consumingResults.clear(); publishedResults.clear();
  admittedObservers.clear(); lastExport = null;
  cleanBranches.clear(); cleaningBranches.clear(); branchReady.clear();
  verifyAccount = null;
  state = { account_id: null, drafts: [], outbox: [], incompatible: [], storage_error: null, paused: true, persistent: null };
  publish();
}
export function pauseWriting(): void {
  admissionStopped = true; state = { ...state, paused: true }; attempt?.abort(); publish();
}
export async function resumeWriting(): Promise<void> {
  if (verifyAccount === null || await verifyAccount() !== state.account_id) return;
  admissionStopped = false; state = { ...state, paused: false }; publish();
}
function ownsDraft(handle: DraftHandle): boolean {
  return handles.get(handle.draft_id) === handle && (releases.has(handle.draft_id) || branchReady.has(handle.draft_id));
}
/** A new branch UUID belongs to this leased runtime before its lock grants. */
export function openFreshDraft(context: DraftContext, initial_value: DraftValue, base: DraftBase = null): DraftHandle {
  assertAdmission();
  if (releaseRuntime === null) throw new WritingDecisionError("the writing runtime has no account lease");
  const token = writingRuntimeToken();
  const id = crypto.randomUUID();
  const handle = { draft_id: id };
  drafts.set(id, { draft_id: id, resource_ref: context.kind === "capture" ? null : context.resource_ref,
    context, value: initial_value, base, revision: 0, selection: null, conflict: null, updated_at: Date.now(), results: [] });
  handles.set(id, handle); branchUsers.set(id, 1);
  const ready = lock(`nexus-writing:${token.account_id}:draft:${id}`, "exclusive").then(release => {
    if (release === null) throw new Error("new draft lock was not granted");
    try { assertWritingRuntimeToken(token); }
    catch (error) { release(); throw error; }
    releases.set(id, release); branchReady.delete(id);
  });
  branchReady.set(id, ready); void ready.catch(() => undefined);
  publish(id); return handle;
}
export async function openDraft(
  context: DraftContext, initial_value: DraftValue, base: DraftBase,
  recover_draft_id: string | null = null,
): Promise<DraftHandle> {
  if (admissionStopped || state.account_id === null) throw new Error("writing is paused");
  if (recover_draft_id === null) return openFreshDraft(context, initial_value, base);
  const token = writingRuntimeToken();
  if (handles.has(recover_draft_id)) {
    const handle = handles.get(recover_draft_id)!;
    branchUsers.set(recover_draft_id, (branchUsers.get(recover_draft_id) ?? 1) + 1); return handle;
  }
  const id = recover_draft_id;
  let release: (() => void) | null = null;
  let installed = false;
  try {
    release = await lock(`nexus-writing:${token.account_id}:draft:${id}`, "exclusive", true);
    assertWritingRuntimeToken(token);
    if (release === null) {
      const recovered = drafts.get(id);
      const fork = openFreshDraft(recovered?.context ?? context, recovered?.value ?? initial_value, recovered?.base ?? base);
      if (recovered) {
        drafts.set(fork.draft_id, { ...recovered, draft_id: fork.draft_id, conflict: { reason: "another tab owns the original draft", saved_value: recovered.value, saved_version: recovered.base?.version ?? null, other_draft_id: id } });
        publish(fork.draft_id);
      }
      return fork;
    }
    if (admissionStopped) throw new Error("writing is paused");
    releases.set(id, release);
    if (database !== null) {
      try { await refreshEntry(id); }
      catch (error) { assertWritingRuntimeToken(token); storageFailure(error); }
      assertWritingRuntimeToken(token);
    }
    if (!drafts.has(id)) return openFreshDraft(context, initial_value, base);
    const handle = { draft_id: id }; handles.set(id, handle); branchUsers.set(id, 1); publish(id);
    installed = true;
    return handle;
  } finally {
    if (!installed) { release?.(); if (releases.get(id) === release) releases.delete(id); }
  }
}
/** Recovery review claims ownership without silently creating a second branch. */
export async function claimDraft(id: string): Promise<DraftHandle | null> {
  const token = writingRuntimeToken();
  const existing = handles.get(id);
  if (existing) { await branchReady.get(id); assertWritingRuntimeToken(token); }
  if (existing && releases.has(id)) {
    branchUsers.set(id, (branchUsers.get(id) ?? 1) + 1); return existing;
  }
  const release = await lock(`nexus-writing:${token.account_id}:draft:${id}`, "exclusive", true);
  let installed = false;
  try {
    assertWritingRuntimeToken(token);
    if (release === null) return null;
    try { if (database !== null) await refreshEntry(id); }
    catch (error) { assertWritingRuntimeToken(token); storageFailure(error); }
    assertWritingRuntimeToken(token);
    if (!drafts.has(id)) return null;
    releases.set(id, release); branchUsers.set(id, 1);
    const handle = { draft_id: id }; handles.set(id, handle); installed = true; return handle;
  } finally { if (!installed) release?.(); }
}
export async function releaseDraft(handle: DraftHandle): Promise<void> {
  if (handles.get(handle.draft_id) !== handle) return;
  await pending; await branchReady.get(handle.draft_id);
  if (handles.get(handle.draft_id) !== handle) return;
  const users = branchUsers.get(handle.draft_id) ?? 0;
  if (users > 1) { branchUsers.set(handle.draft_id, users - 1); return; }
  branchUsers.delete(handle.draft_id); handles.delete(handle.draft_id);
  releases.get(handle.draft_id)?.(); releases.delete(handle.draft_id);
}
/** Replace an untouched memory seed when the user first captures its authority. */
export function resetDraftSeed(handle: DraftHandle, context: DraftContext, value: DraftValue, base: DraftBase): void {
  assertAdmission();
  const draft = drafts.get(handle.draft_id);
  if (!draft || !ownsDraft(handle) || draft.revision !== 0 || durableRevisions.has(handle.draft_id) ||
      [...state.outbox, ...pendingAdmissions.values()].some(row => row.authored.some(item => item.draft_id === handle.draft_id)))
    throw new WritingDecisionError("this draft already contains authored work");
  const resource_ref = context.kind === "capture" ? null : context.resource_ref;
  drafts.set(handle.draft_id, { ...draft, resource_ref, context, value, base }); publish(handle.draft_id);
}
export function updateDraftContext(handle: DraftHandle, context: DraftContext): Promise<void> {
  assertAdmission();
  const current = drafts.get(handle.draft_id);
  if (!current || !ownsDraft(handle)) throw new Error("draft branch is not owned");
  drafts.set(handle.draft_id, { ...current, context });
  if (!durableRevisions.has(handle.draft_id)) return Promise.resolve();
  return runLocal(async () => {
    const saved = await journalTransaction("readwrite", async draftStore => {
      const raw = await request(draftStore.get(handle.draft_id));
      if (raw === undefined) return null;
      const row = decodeDraft(envelope(raw).payload);
      let resolved = context;
      for (const result of row.results) resolved = resolveContext(resolved, result.intent_id, result.ack);
      const next = { ...row, context: resolved };
      await request(draftStore.put(draftEnvelope(next))); return next;
    });
    if (saved !== null) { adoptDraft(saved); publish(saved.draft_id); invalidate(saved.draft_id, saved.revision); }
  });
}
function assertAdmission(): void {
  if (admissionStopped || state.account_id === null) throw new Error("writing is paused");
}
function rememberReferenceConsumption(reference: ReferenceConsumption | null, snapshots: AuthoredSnapshot[]): void {
  if (reference === null) return;
  const body = snapshots.find(snapshot => snapshot.value.kind === "body");
  if (!body) throw new WritingDecisionError("literal text must checkpoint its replacement body");
  pendingReferenceConsumes.set(reference.draft_id, { reference, body_draft_id: body.draft_id, body_revision: body.revision });
}
async function consumeReference(draftStore: IDBObjectStore, outboxStore: IDBObjectStore, reference: ReferenceConsumption | null): Promise<void> {
  if (reference === null) return;
  const memory = drafts.get(reference.draft_id);
  if (!memory || !releases.has(reference.draft_id) || memory.context.kind !== "reference" || memory.revision !== reference.revision)
    throw new WritingDecisionError("the reference draft changed; its raw text is still kept");
  const raw = await request(draftStore.get(reference.draft_id));
  if (raw !== undefined) {
    const saved = decodeDraft(envelope(raw).payload);
    if (saved.context.kind !== "reference" || saved.revision !== reference.revision)
      throw new WritingDecisionError("the reference draft changed; its raw text is still kept");
  }
  for (const raw of await request(outboxStore.getAll())) {
    const row = decodeOutbox(envelope(raw).payload);
    if (row.authored.some(item => item.draft_id === reference.draft_id))
      throw new WritingDecisionError("resolve the pending reference insertion before keeping literal text");
  }
  if (drafts.get(reference.draft_id)?.revision !== reference.revision)
    throw new WritingDecisionError("the reference draft changed; its raw text is still kept");
  await request(draftStore.delete(reference.draft_id));
}
function finishReferenceConsumption(reference: ReferenceConsumption | null): void {
  if (reference === null) return;
  const current = drafts.get(reference.draft_id);
  durableRevisions.delete(reference.draft_id);
  if (current?.revision === reference.revision && current.value.kind === "reference") {
    drafts.set(reference.draft_id, { ...current, revision: 0, value: { ...current.value, raw: "" }, base: null, selection: null, conflict: null, results: [] });
    cleanBranches.add(reference.draft_id);
  }
  if (pendingReferenceConsumes.get(reference.draft_id)?.reference.revision === reference.revision) pendingReferenceConsumes.delete(reference.draft_id);
  invalidate(reference.draft_id, reference.revision); publish(reference.draft_id);
}
function rowFor(intent_id: string, intent: WritingIntent, authored: AuthoredSnapshot[]): OutboxRow {
  const now = Date.now();
  const autosave = (intent.kind === "body" || intent.kind === "title") && intent.policy === "autosave";
  if (runtimeId === null) throw new WritingDecisionError("writing runtime is not active");
  return { sequence: null, intent_id, origin_runtime: runtimeId, acknowledged: null, intent, authored: authored.map(item => ({ draft_id: item.draft_id, revision: item.revision, value: item.value })),
    dispatch: { kind: "unsealed" }, blocked: null, retry_at: null, uncertain: false,
    first_admitted_at: now, dispatch_after: autosave ? now + AUTOSAVE_IDLE_MS : now };
}
async function putDraftSnapshot(store: IDBObjectStore, snapshot: AuthoredSnapshot): Promise<DraftSnapshot> {
  const memory = drafts.get(snapshot.draft_id);
  if (!memory) throw new Error("authored draft is not open");
  const raw = await request(store.get(snapshot.draft_id));
  const current = raw === undefined ? null : decodeDraft(envelope(raw).payload);
  if (current !== null && current.revision > snapshot.revision) return current;
  const merged = { ...(current ?? memory), value: snapshot.value, revision: snapshot.revision, selection: snapshot.selection, conflict: current?.conflict ?? snapshot.conflict, updated_at: memory.updated_at };
  await request(store.put(draftEnvelope(merged)));
  return merged;
}
function dependencies(intent: WritingIntent): { intent_id: string; draft_id: string | null }[] {
  const found: { intent_id: string; draft_id: string | null }[] = [];
  const lane = (value: LaneDependency) => { if (value.kind === "result") found.push(value); };
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
      case "relink": lane(command.expected_source_links_version); position(command.position); break;
      case "ensure_daily": break;
      case "unlink": if (command.expected !== null) lane(command.expected.links_version); break;
      case "remove": if (command.expected_body_version !== null) lane(command.expected_body_version); if (command.expected_links_version !== null) lane(command.expected_links_version); break;
      case "consume_note": lane(command.expected_body_version); if (command.expected_links_version !== null) lane(command.expected_links_version); break;
    }
  }
  return found;
}
async function putAdmission(draftStore: IDBObjectStore, outboxStore: IDBObjectStore, row: OutboxRow, authored: AuthoredSnapshot[]): Promise<{ saved: DraftSnapshot[]; replaced: string | null; facts: CausalFacts[] }> {
  const saved: DraftSnapshot[] = [];
  const adopted: CausalFacts[] = [];
  if (row.intent.kind === "outline") {
    const bindings: CausalFacts["local_note_bindings"] = [];
    row.intent = { ...row.intent, commands: row.intent.commands.map((command): WritingCommand => {
      if (command.kind !== "restore_note" || command.removed_by.kind !== "observed") return command;
      const proof = command.removed_by;
      if (proof.outcome.kind === "deleted") return { kind: "insert_note", note_id: command.note_id, link_id: command.link_id, source: command.source, position: command.position, body_pm_json: command.body_pm_json };
      const note = proof.outcome.note;
      if (note.id !== proof.original_note_id) throw new WritingDecisionError("the retained note proof names another resource");
      bindings.push({ requested_id: command.note_id, canonical_id: note.id, version: note.body_version, body_pm_json: note.body_pm_json });
      return { kind: "insert_link", source: command.source, position: command.position, link_id: command.link_id, target: { kind: "resource", ref: `note_block:${note.id}` }, require_created: true };
    }) };
    if (bindings.length > 0) adopted.push({ identities: [], lanes: [], insertions: [], placements: [], deleted_refs: [], notes: [], local_note_bindings: bindings });
  }
  for (const snapshot of authored) saved.push(await putDraftSnapshot(draftStore, snapshot));
  for (const draft of saved) {
    if (draft.conflict !== null) throw new WritingDecisionError("review this draft's conflict before submitting another change");
    // Absolute text successors may use this branch's already acknowledged base.
    // Only its own settlement writes this disk base; server reads cannot rebase it.
    if ((row.intent.kind === "body" || row.intent.kind === "title") && row.intent.expected.kind === "observed" && typeof draft.base?.version === "number" &&
        draft.resource_ref === (row.intent.kind === "body" ? `note_block:${row.intent.note_id}` : `page:${row.intent.page_id}`) && draft.results.length > 0)
      row.intent = { ...row.intent, expected: { ...row.intent.expected, version: draft.base.version } };
  }
  for (const dependency of dependencies(row.intent)) {
    const predecessor = await request(outboxStore.index("intent_id").get(dependency.intent_id));
    if (predecessor !== undefined) {
      const prior = decodeOutbox(envelope(predecessor).payload);
      if (prior.acknowledged !== null) {
        const facts: CausalFacts = { identities: prior.acknowledged.identities, lanes: prior.acknowledged.lanes, insertions: prior.acknowledged.insertions, placements: prior.acknowledged.placements,
          deleted_refs: prior.acknowledged.deleted_refs, notes: prior.acknowledged.notes.map(note => ({ id: note.id, body_version: note.body_version, body_pm_json: note.body_pm_json })), local_note_bindings: [] };
        const restored = restorationFacts(row.intent, dependency.intent_id, facts);
        row.intent = resolveIntent(row.intent, dependency.intent_id, restored); adopted.push(restored); continue;
      }
      if (prior.blocked === null) continue;
    }
    const raw = dependency.draft_id === null ? undefined : await request(draftStore.get(dependency.draft_id));
    const proof = raw === undefined ? null : decodeDraft(envelope(raw).payload).results.find(item => item.intent_id === dependency.intent_id);
    if (!proof) throw new WritingDecisionError("the preceding change needs review before this change can be submitted");
    const facts = restorationFacts(row.intent, dependency.intent_id, proof.ack);
    row.intent = resolveIntent(row.intent, dependency.intent_id, facts);
    adopted.push(facts);
  }
  for (let index = 0; index < saved.length; index++) {
    let next = saved[index]!;
    for (const facts of adopted) {
      const bound = bindDraft(next, facts);
      if (bound.resource_ref !== next.resource_ref)
        next = { ...bound, results: [...bound.results, { intent_id: row.intent_id, ack: facts }] };
      else next = bound;
    }
    if (next !== saved[index]) { saved[index] = next; await request(draftStore.put(draftEnvelope(next))); }
  }
  const autosave = (row.intent.kind === "body" || row.intent.kind === "title") && row.intent.policy === "autosave";
  const candidates = autosave && authored.length === 1
    ? await request(outboxStore.index("field").getAll([row.intent.kind, authored[0]!.draft_id])) : [];
  const tail = await request(outboxStore.openKeyCursor(null, "prev"));
  // Coalescing only the fifo tail proves no later intent already depends on it.
  // The field index also separates independent branches of the same resource.
  let previous = candidates.map(raw => decodeOutbox(envelope(raw).payload)).findLast(item =>
    item.sequence === tail?.primaryKey && item.dispatch.kind === "unsealed" && item.blocked === null &&
    item.acknowledged === null &&
    item.authored.length === 1 && item.authored[0]!.draft_id === authored[0]!.draft_id &&
    (item.intent.kind === "body" || item.intent.kind === "title") && item.intent.policy === "autosave");
  if (previous !== undefined) {
    for (const index of CONTEXT_DEPENDENCY_INDEXES) if (await request(draftStore.index(index).count(previous.intent_id)) > 0) {
      previous = undefined; break;
    }
  }
  if (previous) {
    // A complete same-branch text snapshot subsumes the unsealed tail. Its
    // replacement inherits that tail's actual predecessor, rather than keeping
    // a dependency on the very row this transaction replaces.
    if ((row.intent.kind === "body" || row.intent.kind === "title") &&
        (previous.intent.kind === "body" || previous.intent.kind === "title") &&
        row.intent.expected.kind === "result" && row.intent.expected.intent_id === previous.intent_id)
      row.intent = { ...row.intent, expected: previous.intent.expected };
    row.sequence = previous.sequence;
    row.first_admitted_at = previous.first_admitted_at;
    row.dispatch_after = Math.min(Date.now() + AUTOSAVE_IDLE_MS, row.first_admitted_at + AUTOSAVE_MAX_MS);
  } else if (!autosave) {
    for (const raw of await request(outboxStore.getAll())) {
      const previous = decodeOutbox(envelope(raw).payload);
      if (previous.blocked === null && previous.dispatch_after > Date.now())
        await request(outboxStore.put(outboxEnvelope({ ...previous, dispatch_after: Date.now() })));
    }
  }
  const key = await request(outboxStore.put(outboxEnvelope(row)));
  if (typeof key !== "number") throw new Error("outbox sequence is not numeric");
  row.sequence = key;
  // The generated key is inserted at the store's nested key path before commit.
  return { saved, replaced: previous?.intent_id ?? null, facts: adopted };
}
export function admitWriting(intent: WritingIntent, authored: AuthoredSnapshot[] | Promise<AuthoredSnapshot[]>, consumed_reference: ReferenceConsumption | null = null): { intent_id: string; durable: Promise<void>; settled: Promise<WritingAck> } {
  assertAdmission();
  const id = crypto.randomUUID();
  const row = rowFor(id, structuredClone(intent), []);
  pendingAdmissions.set(id, row);
  let resolveSettled!: (ack: WritingAck) => void;
  let rejectSettled!: (error: unknown) => void;
  const settled = new Promise<WritingAck>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  // A retained intent can outlive every caller; unobserved settlement is legitimate.
  void settled.catch(() => undefined);
  admissionWaiters.set(id, [{ resolve: resolveSettled, reject: rejectSettled }]);
  const snapshotsReady = Promise.resolve(authored).then(value => {
    const snapshots = structuredClone(value);
    row.authored = snapshots.map(item => ({ draft_id: item.draft_id, revision: item.revision, value: item.value }));
    rememberReferenceConsumption(consumed_reference, snapshots);
    return snapshots;
  });
  // Memory-only admission still owns its carried snapshots. Freeze/export and a
  // later storage retry must wait for them even when indexeddb is unavailable.
  pending = Promise.all([pending, snapshotsReady]).then(() => undefined, () => undefined);
  const durable = runLocal(async () => {
    const snapshots = await snapshotsReady;
    for (const snapshot of snapshots) await branchReady.get(snapshot.draft_id);
    if (consumed_reference !== null) await branchReady.get(consumed_reference.draft_id);
    let committed: Awaited<ReturnType<typeof putAdmission>>;
    try { committed = await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const committed = await putAdmission(draftStore, outboxStore, row, snapshots);
      await consumeReference(draftStore, outboxStore, consumed_reference); return committed;
    }); }
    catch (error) {
      if (!(error instanceof WritingDecisionError)) throw error;
      const kept = await journalTransaction("readwrite", async draftStore => {
        const kept: DraftSnapshot[] = [];
        for (const snapshot of snapshots) {
          const saved = await putDraftSnapshot(draftStore, snapshot);
          const next = { ...saved, conflict: saved.conflict ?? { reason: error.message, saved_value: null, saved_version: null, other_draft_id: null } };
          await request(draftStore.put(draftEnvelope(next))); kept.push(next);
        }
        return kept;
      });
      pendingAdmissions.delete(id);
      if (consumed_reference !== null && pendingReferenceConsumes.get(consumed_reference.draft_id)?.reference.revision === consumed_reference.revision)
        pendingReferenceConsumes.delete(consumed_reference.draft_id);
      for (const saved of kept) { adoptDraft(saved); invalidate(saved.draft_id, saved.revision); emit(draftListeners.get(saved.draft_id) ?? []); }
      for (const waiter of admissionWaiters.get(id) ?? []) waiter.reject(error);
      admissionWaiters.delete(id); publish(); throw error;
    }
    pendingAdmissions.delete(id);
    finishReferenceConsumption(consumed_reference);
    admittedObservers.add(id);
    if (committed.replaced !== null) {
      admissionWaiters.set(id, [...(admissionWaiters.get(committed.replaced) ?? []), ...(admissionWaiters.get(id) ?? [])]);
      admissionWaiters.delete(committed.replaced);
      admittedObservers.delete(committed.replaced);
    }
    for (const saved of committed.saved) adoptDraft(saved);
    state = { ...state, outbox: [...state.outbox.filter(item => item.sequence !== row.sequence), row].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) };
    for (const saved of committed.saved) emit(draftListeners.get(saved.draft_id) ?? []);
    for (const item of snapshots) invalidate(item.draft_id, item.revision);
    invalidate(id, row.sequence ?? 0); publish();
  });
  void durable.catch(() => undefined);
  return { intent_id: id, durable, settled };
}
export function observeWritingIntent(intent_id: string): { intent_id: string; durable: Promise<void>; settled: Promise<WritingAck> } {
  if (state.outbox.some(row => row.intent_id === intent_id) || terminalResults.has(intent_id)) admittedObservers.add(intent_id);
  const settled = new Promise<WritingAck>((resolve, reject) => {
    admissionWaiters.set(intent_id, [...(admissionWaiters.get(intent_id) ?? []), { resolve, reject }]);
  });
  void settled.catch(() => undefined);
  return { intent_id, durable: pending, settled };
}
export function checkpoint(
  handle: DraftHandle, expected_revision: number, value: DraftValue,
  selection: DraftSelection, intent: WritingIntent | null = null, local_conflict: DraftConflict | null = null,
  consumed_reference: ReferenceConsumption | null = null,
): Promise<void> {
  assertAdmission();
  const current = drafts.get(handle.draft_id);
  if (!current || !ownsDraft(handle)) throw new Error("draft branch is not owned");
  if (current.revision !== expected_revision) throw new Error("draft revision changed");
  const snapshot = stageDraft(handle, value, selection, local_conflict);
  if (intent !== null) return admitWriting(intent, [snapshot], consumed_reference).durable;
  rememberReferenceConsumption(consumed_reference, [snapshot]);
  const durable = runLocal(async () => {
    await branchReady.get(snapshot.draft_id);
    if (consumed_reference !== null) await branchReady.get(consumed_reference.draft_id);
    const saved = await journalTransaction("readwrite", async (store, outbox) => {
      const saved = await putDraftSnapshot(store, snapshot); await consumeReference(store, outbox, consumed_reference); return saved;
    });
    adoptDraft(saved);
    finishReferenceConsumption(consumed_reference);
    invalidate(snapshot.draft_id, snapshot.revision); publish(snapshot.draft_id);
    void cleanupAcknowledgedDraft(snapshot.draft_id);
  });
  return durable.catch(error => {
    if (error instanceof WritingDecisionError && consumed_reference !== null && pendingReferenceConsumes.get(consumed_reference.draft_id)?.reference.revision === consumed_reference.revision)
      pendingReferenceConsumes.delete(consumed_reference.draft_id);
    throw error;
  });
}
/** Stage a carried structural snapshot; its admitting transaction owns durability. */
export function stageDraft(handle: DraftHandle, value: DraftValue, selection: DraftSelection, local_conflict: DraftConflict | null = null): AuthoredSnapshot {
  assertAdmission();
  if (!ownsDraft(handle)) throw new WritingDecisionError("the authoring branch is no longer owned");
  renewCleanBranch(handle);
  const current = drafts.get(handle.draft_id);
  if (!current || !ownsDraft(handle)) throw new Error("draft branch is not owned");
  drafts.set(handle.draft_id, { ...current, value, revision: current.revision + 1, selection, conflict: current.conflict ?? local_conflict, updated_at: Date.now() });
  publish(handle.draft_id); return snapshotDraft(handle);
}
export function draftIsDurable(id: string): boolean {
  const draft = drafts.get(id);
  return draft !== undefined && (durableRevisions.get(id) === draft.revision || draft.base !== null && sameDraftValue(draft.value, draft.base.value) && draft.conflict === null);
}
/** A discarded owner keeps a clean seed until its next edit renews the branch. */
export function draftIsCleanSeed(id: string): boolean {
  return cleanBranches.has(id) && drafts.get(id)?.revision === 0;
}
async function cleanupAcknowledgedDraft(id: string): Promise<void> {
  await pending;
  const before = drafts.get(id);
  if (!before || before.base === null || before.conflict !== null || !sameDraftValue(before.value, before.base.value) || !durableRevisions.has(id) || cleaningBranches.has(id) || state.storage_error !== null || state.incompatible.length > 0) return;
  cleaningBranches.add(id);
  let orphanRelease: (() => void) | null = null;
  try {
    if (!releases.has(id)) {
      orphanRelease = await lock(lockName(`draft:${id}`), "exclusive", true);
      if (orphanRelease === null) return;
    }
    const removed = await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const raw = await request(draftStore.get(id));
      if (raw === undefined) return false;
      const row = decodeDraft(envelope(raw).payload);
      const memory = drafts.get(id) ?? before;
      if (row.revision !== memory.revision || row.conflict !== null || row.base === null || memory.base === null || !sameDraftValue(memory.value, memory.base.value) || !sameDraftValue(row.value, row.base.value)) return false;
      for (const raw of await request(outboxStore.getAll())) {
        const pending = decodeOutbox(envelope(raw).payload);
        if (pending.authored.some(item => item.draft_id === id) || dependencies(pending.intent).some(item => item.draft_id === id)) return false;
      }
      for (const result of row.results) for (const index of CONTEXT_DEPENDENCY_INDEXES)
        if (await request(draftStore.index(index).count(result.intent_id)) > 0) return false;
      await request(draftStore.delete(id)); return true;
    });
    if (removed) {
      if (releases.has(id)) cleanBranches.add(id); else drafts.delete(id);
      durableRevisions.delete(id); invalidate(id, before.revision); publish(id);
    }
  } catch (error) { storageFailure(error); }
  finally { orphanRelease?.(); cleaningBranches.delete(id); }
}
function renewCleanBranch(handle: DraftHandle): void {
  const oldId = handle.draft_id;
  if (!cleanBranches.has(oldId) && !cleaningBranches.has(oldId)) return;
  const current = drafts.get(oldId);
  const releaseOld = releases.get(oldId);
  if (!current || !releaseOld) throw new Error("clean authoring branch is not owned");
  const id = crypto.randomUUID();
  handle.draft_id = id;
  drafts.delete(oldId); drafts.set(id, { ...current, draft_id: id, revision: 0, results: [] });
  handles.delete(oldId); handles.set(id, handle);
  branchUsers.set(id, branchUsers.get(oldId) ?? 1); branchUsers.delete(oldId);
  releases.delete(oldId); releases.set(id, releaseOld);
  const scoped = draftListeners.get(oldId);
  if (scoped) { draftListeners.delete(oldId); draftListeners.set(id, scoped); }
  cleanBranches.delete(oldId); durableRevisions.delete(oldId);
  const generation = epoch;
  const ready = lock(lockName(`draft:${id}`), "exclusive").then(release => {
    if (release === null) throw new Error("new draft lock was not granted");
    if (generation !== epoch) { release(); throw new WritingDecisionError("writing runtime changed"); }
    releases.set(id, release); releaseOld(); branchReady.delete(id);
  });
  branchReady.set(id, ready);
}
function touchedLane(intent: WritingIntent, ref: string, lane: WritingLane): boolean {
  if (intent.kind === "insert_note") return touchedLane({ kind: "outline", commands: [intent.request] }, ref, lane);
  if (intent.kind === "body") return lane === "body" && ref === `note_block:${intent.note_id}`;
  if (intent.kind === "title") return lane === "title" && ref === `page:${intent.page_id}`;
  if (intent.kind === "capture") return lane === "body" && ref === `note_block:${intent.request.note_id}`;
  if (intent.kind === "attach_highlight" || intent.kind === "attach_link") return lane === "body" && ref === `note_block:${intent.request.note_id}`;
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
export function creationDependency(ref: string, lane: "body" | "title"): LaneDependency | null {
  const row = [...state.outbox, ...pendingAdmissions.values()].find(row =>
    ["page", "insert_note", "capture", "passage", "attach_highlight", "attach_link", "outline"].includes(row.intent.kind) && touchedLane(row.intent, ref, lane));
  return row ? { kind: "result", intent_id: row.intent_id, draft_id: row.authored[0]?.draft_id ?? null, ref, lane, version: 1 } : null;
}
export function captureLane(ref: string, lane: WritingLane, version: number): LaneDependency {
  const rows = [...state.outbox, ...pendingAdmissions.values()];
  const preceding = rows.findLast(row => touchedLane(row.intent, ref, lane));
  return preceding ? { kind: "result", intent_id: preceding.intent_id, draft_id: preceding.authored[0]?.draft_id ?? null, ref, lane, version } : { kind: "observed", ref, lane, version };
}
export function draftDependency(handle: DraftHandle, lane: "body" | "title"): LaneDependency | null {
  if (handles.get(handle.draft_id) !== handle) return null;
  const draft = drafts.get(handle.draft_id);
  if (!draft || draft.resource_ref === null) return null;
  const rows = [...state.outbox, ...pendingAdmissions.values()];
  const preceding = rows.findLast(row => row.authored.some(item => item.draft_id === handle.draft_id) && touchedLane(row.intent, draft.resource_ref!, lane));
  if (preceding) return { kind: "result", intent_id: preceding.intent_id, draft_id: handle.draft_id, ref: draft.resource_ref, lane, version: typeof draft.base?.version === "number" ? draft.base.version : 1 };
  return typeof draft.base?.version === "number" ? { kind: "observed", ref: draft.resource_ref, lane, version: draft.base.version } : null;
}
export async function expediteDraft(handle: DraftHandle): Promise<void> {
  if (handles.get(handle.draft_id) !== handle) return;
  await runLocal(async () => {
    if (handles.get(handle.draft_id) !== handle) return;
    const rows = await journalTransaction("readwrite", async (_drafts, outbox) => {
      const rows = (await request(outbox.getAll())).map(raw => decodeOutbox(envelope(raw).payload));
      const last = rows.findLast(row => row.authored.some(item => item.draft_id === handle.draft_id));
      if (!last) return rows;
      for (const row of rows) if ((row.sequence ?? 0) <= (last.sequence ?? 0) && row.blocked === null) {
        row.dispatch_after = Date.now(); await request(outbox.put(outboxEnvelope(row)));
      }
      return rows;
    });
    state = { ...state, outbox: rows.filter(row => row.acknowledged === null) }; invalidate("*", Date.now()); publish();
  });
}
export async function retryWritingStorage(): Promise<void> {
  const token = writingRuntimeToken();
  state = { ...state, storage_error: null };
  await runLocal(async () => {
    await Promise.all(branchReady.values());
    if (database === null) {
      const opened = await openJournal(token.account_id);
      try { assertWritingRuntimeToken(token); } catch (error) { opened.close(); throw error; }
      database = opened; watchJournalVersion(opened);
    }
    if (channel === null) openJournalChannel(token.account_id);
    const committed = await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const committed: { id: string; result: Awaited<ReturnType<typeof putAdmission>> }[] = [];
      for (const draft of drafts.values()) if (releases.has(draft.draft_id) && (draft.revision > 0 || draft.conflict !== null))
        await putDraftSnapshot(draftStore, snapshotDraft(handles.get(draft.draft_id)!));
      for (const row of pendingAdmissions.values())
        committed.push({ id: row.intent_id, result: await putAdmission(draftStore, outboxStore, row, row.authored.map(item => ({ ...item, selection: drafts.get(item.draft_id)?.selection ?? null, conflict: drafts.get(item.draft_id)?.conflict ?? null }))) });
      for (const consumption of pendingReferenceConsumes.values()) {
        const bodyRaw = await request(draftStore.get(consumption.body_draft_id));
        if (bodyRaw === undefined || decodeDraft(envelope(bodyRaw).payload).revision < consumption.body_revision)
          throw new WritingDecisionError("checkpoint the literal replacement before discarding raw reference text");
        await consumeReference(draftStore, outboxStore, consumption.reference);
      }
      return committed;
    });
    for (const { id, result } of committed) {
      admittedObservers.add(id);
      if (result.replaced !== null) {
        admissionWaiters.set(id, [...(admissionWaiters.get(result.replaced) ?? []), ...(admissionWaiters.get(id) ?? [])]);
        admissionWaiters.delete(result.replaced); admittedObservers.delete(result.replaced);
      }
      for (const draft of result.saved) adoptDraft(draft);
    }
    pendingAdmissions.clear();
    for (const consumption of [...pendingReferenceConsumes.values()]) finishReferenceConsumption(consumption.reference);
    for (const draft of drafts.values()) if (draft.revision > 0) durableRevisions.set(draft.draft_id, draft.revision);
    invalidate("*", Date.now()); await refreshJournal();
  });
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
function restorationFacts(intent: WritingIntent, settled: string, facts: CausalFacts): CausalFacts {
  if (intent.kind !== "outline") return facts;
  const bindings = [...facts.local_note_bindings];
  for (const command of intent.commands) {
    if (command.kind !== "restore_note" || command.removed_by.kind !== "pending" || command.removed_by.intent_id !== settled) continue;
    const original = command.removed_by.original_note_id;
    if (facts.deleted_refs.includes(`note_block:${original}`)) continue;
    const retained = facts.notes.find(note => note.id === original);
    if (!retained) throw new WritingDecisionError("the removed note has no acknowledged retention decision");
    if (!bindings.some(item => item.requested_id === command.note_id))
      bindings.push({ requested_id: command.note_id, canonical_id: original, version: retained.body_version, body_pm_json: retained.body_pm_json });
  }
  return { ...facts, local_note_bindings: bindings };
}
function bindDraft(draft: DraftSnapshot, facts: CausalFacts): DraftSnapshot {
  const binding = facts.local_note_bindings.find(item => draft.resource_ref === `note_block:${item.requested_id}`);
  if (!binding) return draft;
  const value: DraftValue = { kind: "body", body_pm_json: parseBody(binding.body_pm_json).body_pm_json };
  return { ...draft, resource_ref: `note_block:${binding.canonical_id}`,
    context: resolveContext(draft.context, "", facts),
    base: { value, version: binding.version },
    conflict: sameDraftValue(draft.value, value) ? draft.conflict : { reason: "the retained note differs from the restored draft", saved_value: value, saved_version: binding.version, other_draft_id: null } };
}
function resolveLane(value: LaneDependency, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): LaneDependency {
  const ref = canonicalRef(value.ref, ack);
  const binding = ack.local_note_bindings.find(item => value.ref === `note_block:${item.requested_id}`);
  if (binding && value.lane === "body") value = { ...value, ref, version: binding.version };
  const fact = ack.lanes.find(item => item.ref === ref && item.lane === value.lane);
  if (value.kind === "result") {
    if (value.intent_id !== settled) {
      if (!causal?.has(value.intent_id)) return { ...value, ref };
      if (!fact || fact.version === value.version) return { ...value, ref };
      if (fact.checked_from_version !== value.version)
        throw new WritingDecisionError("the captured version was not proven by the preceding change");
      return { ...value, ref, version: fact.version };
    }
    if (!fact || (fact.version !== value.version && fact.checked_from_version !== value.version))
      throw new WritingDecisionError("the preceding change did not prove this version");
    return { kind: "observed", ref, lane: value.lane, version: fact.version };
  }
  // Observed authority belongs to the captured branch/view. A matching receipt
  // from another write cannot turn that independent observation into causality.
  return { ...value, ref };
}
function resolvePosition(value: WritingPosition | null, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): WritingPosition | null {
  if (value === null) return null;
  if (!("predecessor" in value)) return { ...value, expected_links_version: resolveLane(value.expected_links_version, settled, ack, causal) };
  const proof = value.predecessor;
  if (proof.intent_id !== settled) {
    const source_ref = canonicalRef(proof.source_ref, ack);
    if (!causal?.has(proof.intent_id)) return { ...value, predecessor: { ...proof, source_ref } };
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
      if (command.removed_by.kind === "observed" || command.removed_by.intent_id !== settled) return { ...command, source: resolveSource(command.source, ack), position: resolvePosition(command.position, settled, ack, causal) };
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
    case "relink": return { ...command, endpoint: canonicalRef(command.endpoint, ack), link_id: canonicalId("link", command.link_id, ack), destination: canonicalRef(command.destination, ack), new_link_id: canonicalId("link", command.new_link_id, ack), expected_source_links_version: resolveLane(command.expected_source_links_version, settled, ack, causal), position: resolvePosition(command.position, settled, ack, causal) };
    case "unlink": return { ...command, link_id: canonicalId("link", command.link_id, ack), expected: command.expected === null ? null : { endpoint: canonicalRef(command.expected.endpoint, ack), links_version: resolveLane(command.expected.links_version, settled, ack, causal) } };
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
    case "attach_link": return { ...intent, link_id: canonicalId("link", intent.link_id, ack) };
    case "detach_highlight": return { ...intent, highlight_id: canonicalId("highlight", intent.highlight_id, ack), note_id: canonicalId("note_block", intent.note_id, ack), link_id: canonicalId("link", intent.link_id, ack) };
    case "detach_link": return { ...intent, link_id: canonicalId("link", intent.link_id, ack), note_id: canonicalId("note_block", intent.note_id, ack), source_link_id: canonicalId("link", intent.source_link_id, ack), target_link_id: canonicalId("link", intent.target_link_id, ack) };
    case "highlight_update":
    case "highlight_delete":
    case "highlight_note_delete": return { ...intent, highlight_id: canonicalId("highlight", intent.highlight_id, ack) };
    case "resource_delete": return { ...intent, resource_id: canonicalId(intent.resource_kind, intent.resource_id, ack) };
  }
}
function resolveContext(context: DraftContext, settled: string, ack: CausalFacts, causal: ReadonlySet<string> | null = null): DraftContext {
  switch (context.kind) {
    case "composer": {
      const publication = resolveIntent(context.publication, settled, ack, causal);
      if (publication.kind !== "insert_note") throw new Error("composer publication changed kind");
      return { ...context, resource_ref: canonicalRef(context.resource_ref, ack), publication };
    }
    case "body":
    case "title": {
      const publication = context.publication === null ? null : resolveIntent(context.publication, settled, ack, causal);
      if (context.kind === "title") {
        if (publication !== null && publication.kind !== "page" && publication.kind !== "insert_note") throw new Error("title publication changed kind");
        return { ...context, resource_ref: canonicalRef(context.resource_ref, ack), publication };
      }
      if (publication !== null && !["page", "insert_note", "capture", "passage", "attach_highlight", "attach_link"].includes(publication.kind))
        throw new Error("body publication changed kind");
      // justify-type-assertion: resolveIntent preserves the publication discriminant.
      return { ...context, resource_ref: canonicalRef(context.resource_ref, ack), publication: publication as Publication | null };
    }
    case "capture": return { ...context, note_id: canonicalId("note_block", context.note_id, ack), link_id: canonicalId("link", context.link_id, ack) };
    case "passage": {
      const publication = resolveIntent(context.publication, settled, ack, causal);
      if (publication.kind !== "passage" && publication.kind !== "attach_highlight") throw new Error("passage publication changed kind");
      const source = resolveSource(context.source, ack);
      if (source.kind !== "fragment_selection" && source.kind !== "pdf_selection") throw new Error("passage source changed kind");
      return { ...context, resource_ref: canonicalRef(context.resource_ref, ack), publication, source };
    }
    case "reference": return { ...context, source: resolveSource(context.source, ack), position: resolvePosition(context.position, settled, ack, causal), resource_ref: context.resource_ref === null ? null : canonicalRef(context.resource_ref, ack) };
  }
}
export function sameDraftValue(a: DraftValue, b: DraftValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "body": return b.kind === "body" && JSON.stringify(a.body_pm_json) === JSON.stringify(b.body_pm_json);
    case "title": return b.kind === "title" && a.text === b.text;
    case "capture": return b.kind === "capture" && a.text === b.text;
    case "reference": return b.kind === "reference" && a.raw === b.raw && JSON.stringify(a.base_body_pm_json) === JSON.stringify(b.base_body_pm_json);
  }
}
export function draftOwnedHere(id: string): boolean { return releases.has(id); }
/** A read may refresh a clean memory seed; it never rebases authored work. */
export function adoptDraftRead(handle: DraftHandle, value: DraftValue, version: number): void {
  const current = drafts.get(handle.draft_id);
  if (!current || !ownsDraft(handle) || current.base === null || !sameDraftValue(current.value, current.base.value)) return;
  if (typeof current.base.version === "number" && version < current.base.version) return;
  drafts.set(handle.draft_id, { ...current, value, base: { value, version } }); publish(handle.draft_id);
}
function confirmedDraft(draft: DraftSnapshot, ack: WritingAck, facts: CausalFacts): { ref: string; base: NonNullable<DraftBase> } | null {
  let ref = draft.resource_ref;
  if (ref !== null) ref = canonicalRef(ref, facts);
  if (draft.context.kind === "capture") ref = `note_block:${canonicalId("note_block", draft.context.note_id, facts)}`;
  const note = ack.notes.find(item => `note_block:${item.id}` === ref);
  if (note) return { ref: `note_block:${note.id}`, base: { value: draft.value.kind === "capture" ? { kind: "capture", text: note.body_text } : { kind: "body", body_pm_json: parseBody(note.body_pm_json).body_pm_json }, version: note.body_version } };
  const page = ack.pages.find(item => `page:${item.id}` === ref);
  if (page && draft.value.kind === "title") return { ref: `page:${page.id}`, base: { value: { kind: "title", text: page.title }, version: page.title_version } };
  return null;
}
export async function updateOutbox(row: OutboxRow): Promise<OutboxRow | null> {
  const saved = await journalTransaction("readwrite", async (_drafts, outbox) => {
    const raw = await request(outbox.index("intent_id").get(row.intent_id));
    if (raw === undefined) return null;
    const current = decodeOutbox(envelope(raw).payload);
    if (current.acknowledged !== null) return null;
    // Admission can replace an unsealed autosave while a drainer waits for its
    // lock. Only this current row owns content; a stale snapshot owns no bytes.
    if (JSON.stringify(current.intent) !== JSON.stringify(row.intent)) return null;
    const dispatch = current.dispatch.kind === "sealed" ? current.dispatch : row.dispatch;
    const next = { ...current, dispatch, blocked: row.blocked, retry_at: row.retry_at, uncertain: row.uncertain, dispatch_after: row.dispatch_after };
    await request(outbox.put(outboxEnvelope(next))); return next;
  });
  if (saved !== null) {
    state = { ...state, outbox: state.outbox.map(item => item.intent_id === saved.intent_id ? saved : item) };
    invalidate(saved.intent_id, saved.sequence ?? 0); publish();
  }
  return saved;
}
function transitiveRows(rows: OutboxRow[], roots: Set<string>): void {
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) if (!roots.has(row.intent_id) && dependencies(row.intent).some(dep => roots.has(dep.intent_id))) {
      roots.add(row.intent_id); added = true;
    }
  }
}
export async function settleWriting(row: OutboxRow, ack: WritingAck): Promise<void> {
  const rejected = new Set<string>();
  const retainedConflicts = new Set<string>();
  let committedFacts: CausalFacts = { identities: ack.identities, lanes: ack.lanes, insertions: ack.insertions, placements: ack.placements,
    deleted_refs: ack.deleted_refs, notes: ack.notes.map(note => ({ id: note.id, body_version: note.body_version, body_pm_json: note.body_pm_json })), local_note_bindings: [] };
  await journalTransaction("readwrite", async (draftStore, outboxStore) => {
    const allRows = (await request(outboxStore.getAll())).map(raw => decodeOutbox(envelope(raw).payload));
    const allDrafts = (await request(draftStore.getAll())).map(raw => decodeDraft(envelope(raw).payload));
    const causal = new Set([row.intent_id]);
    transitiveRows(allRows, causal);
    const needed = new Set(allRows.flatMap(item => dependencies(item.intent).map(dep => dep.intent_id)));
    for (const next of allRows) {
      try { committedFacts = restorationFacts(next.intent, row.intent_id, committedFacts); }
      catch (error) { if (!(error instanceof WritingDecisionError)) throw error; rejected.add(next.intent_id); }
    }
    let differingCreate = false;
    for (const draft of allDrafts) {
      let next = bindDraft(draft, committedFacts);
      const locallyBound = committedFacts.local_note_bindings.some(binding => draft.resource_ref === `note_block:${binding.requested_id}` && next.resource_ref === `note_block:${binding.canonical_id}`);
      if (locallyBound && next.conflict !== null) retainedConflicts.add(draft.draft_id);
      try { next = { ...next, context: resolveContext(next.context, row.intent_id, committedFacts, causal), resource_ref: next.resource_ref === null ? null : canonicalRef(next.resource_ref, committedFacts) }; }
      catch (error) { next = { ...next, conflict: { reason: error instanceof Error ? error.message : String(error), saved_value: null, saved_version: null, other_draft_id: null } }; }
      const authored = row.authored.find(item => item.draft_id === draft.draft_id);
      if (authored) {
        let confirmed: ReturnType<typeof confirmedDraft> = null;
        try { confirmed = confirmedDraft(next, ack, committedFacts); }
        catch (error) {
          if (!(error instanceof WritingDecisionError)) throw error;
          next = { ...next, conflict: { reason: error.message, saved_value: null, saved_version: null, other_draft_id: null } };
          differingCreate = true;
        }
        if (authored.value.kind === "reference" && next.context.kind === "reference" && row.intent.kind === "outline") {
          const contextSource = next.context.source;
          const sourceRef = contextSource.kind === "resource" ? contextSource.ref : contextSource.kind === "daily_page" ? `page:${contextSource.page_id}` : contextSource.kind === "fragment_selection" || contextSource.kind === "pdf_selection" ? `highlight:${contextSource.highlight_id}` : null;
          const inserted = ack.insertions.find(item => item.source_ref === sourceRef && row.intent.kind === "outline" && row.intent.commands.some(command => (command.kind === "insert_link" || command.kind === "insert_note") && command.link_id === item.requested_link_id));
          const lane = inserted && ack.lanes.find(item => item.ref === inserted.source_ref && item.lane === "links");
          const placed = inserted && ack.placements.some(item => item.endpoint === inserted.source_ref && item.link_id === inserted.canonical_link_id);
          if (inserted && lane && placed) confirmed = { ref: inserted.source_ref, base: { value: authored.value, version: lane.version } };
        }
        if (confirmed) {
          const differs = !sameDraftValue(authored.value, confirmed.base.value);
          differingCreate ||= differs;
          next = { ...next, resource_ref: confirmed.ref, base: confirmed.base,
            conflict: differs ? { reason: "the saved version differs from this draft", saved_value: confirmed.base.value, saved_version: confirmed.base.version, other_draft_id: null } : next.conflict };
        }
      }
      if (authored || locallyBound)
        next = { ...next, results: [...next.results.filter(item => needed.has(item.intent_id)), { intent_id: row.intent_id, ack: committedFacts }] };
      if (ack.deleted_refs.includes(next.resource_ref ?? ""))
        next = { ...next, conflict: { reason: "this resource was deleted; your writing is kept", saved_value: null, saved_version: null, other_draft_id: null } };
      await request(draftStore.put(draftEnvelope(next)));
    }
    for (const next of allRows) {
      if (next.intent_id === row.intent_id || next.dispatch.kind === "sealed" || next.acknowledged !== null) continue;
      if (next.authored.some(authored => retainedConflicts.has(authored.draft_id)) &&
          !(next.intent.kind === "outline" && next.intent.commands.every(command => command.kind === "restore_note"))) {
        rejected.add(next.intent_id); continue;
      }
      if (differingCreate && dependencies(next.intent).some(dep => dep.intent_id === row.intent_id)) {
        rejected.add(next.intent_id); continue;
      }
      try {
        next.intent = resolveIntent(next.intent, row.intent_id, committedFacts, causal);
        await request(outboxStore.put(outboxEnvelope(next)));
      } catch (error) {
        rejected.add(next.intent_id);
        next.blocked = { code: "E_WRITING_PLACEMENT_REVIEW", request_id: null, current: error instanceof Error ? error.message : String(error) };
      }
    }
    transitiveRows(allRows, rejected);
    for (const next of allRows) if (rejected.has(next.intent_id))
      await request(outboxStore.put(outboxEnvelope({ ...next, blocked: { code: "E_WRITING_DEPENDENCY_REVIEW", request_id: null, current: null }, uncertain: false })));
    if (row.sequence === null) throw new Error("acknowledged intent has no sequence");
    await request(outboxStore.put(outboxEnvelope({ ...row, acknowledged: ack, blocked: null, retry_at: null, uncertain: false })));
  });
  invalidate("*", Date.now()); await refreshJournal();
  for (const id of rejected) {
    for (const waiter of admissionWaiters.get(id) ?? []) waiter.reject(new WritingDecisionError("the preceding change needs review"));
    admissionWaiters.delete(id);
  }
}
export async function parkWriting(row: OutboxRow, failure: { code: string; request_id: string | null; current: unknown }, definitive: boolean): Promise<void> {
  const blocked = new Set([row.intent_id]);
  await journalTransaction("readwrite", async (draftStore, outboxStore) => {
    const rows = (await request(outboxStore.getAll())).map(raw => decodeOutbox(envelope(raw).payload));
    if (definitive) transitiveRows(rows, blocked);
    for (const current of rows) if (blocked.has(current.intent_id))
      await request(outboxStore.put(outboxEnvelope({ ...current, blocked: failure, uncertain: !definitive })));
    for (const raw of await request(draftStore.getAll())) {
      const draft = decodeDraft(envelope(raw).payload);
      if (!rows.some(item => blocked.has(item.intent_id) && item.authored.some(authored => authored.draft_id === draft.draft_id))) continue;
      let saved_value: DraftValue | null = null;
      let saved_version: number | string | null = null;
      if (failure.current !== null && typeof failure.current === "object") {
        const saved = object(failure.current);
        if (saved.body_pm_json !== undefined && typeof saved.body_version === "number") {
          saved_value = { kind: "body", body_pm_json: parseBody(saved.body_pm_json).body_pm_json }; saved_version = saved.body_version;
        } else if (typeof saved.title === "string" && typeof saved.title_version === "number") {
          saved_value = { kind: "title", text: saved.title }; saved_version = saved.title_version;
        }
      }
      await request(draftStore.put(draftEnvelope({ ...draft, conflict: { reason: failure.code, saved_value, saved_version, other_draft_id: null } })));
    }
  });
  invalidate("*", Date.now()); await refreshJournal();
  if (definitive) for (const id of blocked) {
    for (const waiter of admissionWaiters.get(id) ?? []) waiter.reject(new WritingDecisionError(failure.code)); admissionWaiters.delete(id);
  }
}
export async function retryWriting(intent_id: string): Promise<void> {
  await runLocal(async () => {
    const row = state.outbox.find(item => item.intent_id === intent_id);
    if (!row) return;
    if (row.blocked !== null && !row.uncertain) return;
    await updateOutbox({ ...row, retry_at: null, blocked: null, dispatch_after: Date.now() });
  });
}
export async function retireWriting(intent_id: string): Promise<void> {
  const token = writingRuntimeToken();
  await navigator.locks.request(lockName("drain"), async () => {
    await pending;
    assertWritingRuntimeToken(token);
    await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const rows = (await request(outboxStore.getAll())).map(raw => decodeOutbox(envelope(raw).payload));
      const target = rows.find(row => row.intent_id === intent_id && row.acknowledged === null);
      if (!target || target.sequence === null) throw new WritingDecisionError("the change already settled; review the current writing");
      const sequence = target.sequence;
      const retired = target.uncertain
        ? new Set(rows.filter(row => row.acknowledged === null && row.sequence !== null && row.sequence >= sequence).map(row => row.intent_id))
        : new Set([intent_id]);
      transitiveRows(rows.filter(row => row.acknowledged === null), retired);
      for (const row of rows) if (retired.has(row.intent_id)) {
        if (row.sequence !== null) await request(outboxStore.delete(row.sequence));
        for (const authored of row.authored) {
          const raw = await request(draftStore.get(authored.draft_id));
          if (raw === undefined) continue;
          const draft = decodeDraft(envelope(raw).payload);
          await request(draftStore.put(draftEnvelope({ ...draft, conflict: { reason: "delivery stopped; an earlier attempt may still finish", saved_value: null, saved_version: null, other_draft_id: null }, results: [] })));
        }
      }
    });
    assertWritingRuntimeToken(token);
    invalidate("*", Date.now()); await refreshJournal();
  });
}
export interface DraftShown { readonly revision: number }
export async function discardDraft(handle: DraftHandle, shown: DraftShown, retained_base: DraftBase = null): Promise<void> {
  const token = writingRuntimeToken();
  if (!ownsDraft(handle)) throw new WritingDecisionError("another tab owns this draft");
  const retainCleanSeed = (current: DraftSnapshot) => {
    if (retained_base === null) { drafts.delete(handle.draft_id); return; }
    let base = retained_base;
    for (const candidate of [current.base, canonicalConflictBase(current.conflict)])
      if (candidate !== null && candidate.value.kind === base.value.kind && typeof candidate.version === "number" &&
        (typeof base.version !== "number" || candidate.version > base.version)) base = candidate;
    drafts.set(handle.draft_id, { ...current, value: base.value, base, revision: 0, selection: null, conflict: null, results: [] });
    cleanBranches.add(handle.draft_id);
  };
  await navigator.locks.request(lockName("drain"), async () => {
    assertWritingRuntimeToken(token);
    await pending; await branchReady.get(handle.draft_id);
    assertWritingRuntimeToken(token);
    const owned = drafts.get(handle.draft_id);
    if (!owned || handles.get(handle.draft_id) !== handle || owned.revision !== shown.revision || !releases.has(handle.draft_id))
      throw new WritingDecisionError("the draft changed; review its current contents before discarding");
    if (database === null) {
      if (durableRevisions.has(handle.draft_id) || state.outbox.some(row => row.authored.some(item => item.draft_id === handle.draft_id) || dependencies(row.intent).some(item => item.draft_id === handle.draft_id)))
        throw new WritingDecisionError("retry journal storage before discarding a durable draft");
      const rows = [...pendingAdmissions.values()];
      const removed = new Set(rows.filter(row => row.authored.some(item => item.draft_id === handle.draft_id)).map(row => row.intent_id));
      transitiveRows(rows, removed);
      if (rows.some(row => removed.has(row.intent_id) && (row.uncertain || row.dispatch.kind === "sealed")))
        throw new WritingDecisionError("stop the uncertain change explicitly before discarding this draft");
      for (const row of rows) if (removed.has(row.intent_id)) {
        pendingAdmissions.delete(row.intent_id);
        for (const waiter of admissionWaiters.get(row.intent_id) ?? []) waiter.reject(new WritingDecisionError("delivery stopped; the preceding draft was discarded"));
        admissionWaiters.delete(row.intent_id); admittedObservers.delete(row.intent_id);
        for (const authored of row.authored) if (authored.draft_id !== handle.draft_id) {
          const dependent = drafts.get(authored.draft_id);
          if (dependent) {
            drafts.set(dependent.draft_id, { ...dependent, conflict: { reason: "the preceding draft was discarded; review this writing", saved_value: null, saved_version: null, other_draft_id: null } });
            emit(draftListeners.get(dependent.draft_id) ?? []);
          }
        }
      }
      for (const [id, consumption] of pendingReferenceConsumes)
        if (id === handle.draft_id || consumption.body_draft_id === handle.draft_id) pendingReferenceConsumes.delete(id);
      retainCleanSeed(owned);
      publish(handle.draft_id); return;
    }
    await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const raw = await request(draftStore.get(handle.draft_id));
      if (raw !== undefined && decodeDraft(envelope(raw).payload).revision !== shown.revision || drafts.get(handle.draft_id)?.revision !== shown.revision)
        throw new WritingDecisionError("the draft changed; review its current contents before discarding");
      const rows = (await request(outboxStore.getAll())).map(raw => decodeOutbox(envelope(raw).payload));
      const removed = new Set(rows.filter(row => row.authored.some(item => item.draft_id === handle.draft_id)).map(row => row.intent_id));
      transitiveRows(rows, removed);
      if (rows.some(row => removed.has(row.intent_id) && (row.uncertain || row.dispatch.kind === "sealed")))
        throw new WritingDecisionError("stop the uncertain change explicitly before discarding this draft");
      for (const row of rows) if (removed.has(row.intent_id)) {
        if (row.sequence !== null) await request(outboxStore.delete(row.sequence));
        for (const authored of row.authored) if (authored.draft_id !== handle.draft_id) {
          const raw = await request(draftStore.get(authored.draft_id));
          if (raw !== undefined) {
            const draft = decodeDraft(envelope(raw).payload);
            await request(draftStore.put(draftEnvelope({ ...draft, conflict: { reason: "the preceding change was discarded; review this writing", saved_value: null, saved_version: null, other_draft_id: null } })));
          }
        }
      }
      if (drafts.get(handle.draft_id)?.revision !== shown.revision)
        throw new WritingDecisionError("the draft changed; review its current contents before discarding");
      await request(draftStore.delete(handle.draft_id));
    });
    assertWritingRuntimeToken(token);
    const current = drafts.get(handle.draft_id);
    if (current?.revision !== shown.revision)
      throw new WritingDecisionError("new input arrived during discard and is still kept");
    retainCleanSeed(current);
    durableRevisions.delete(handle.draft_id);
    for (const [id, consumption] of pendingReferenceConsumes)
      if (id === handle.draft_id || consumption.body_draft_id === handle.draft_id) pendingReferenceConsumes.delete(id);
    publish(handle.draft_id);
    invalidate("*", Date.now()); await refreshJournal();
  });
}
/** Explicit opaque discard; unsupported payloads never pass a current decoder. */
export async function discardIncompatible(): Promise<void> {
  const token = writingRuntimeToken();
  const result = await prepareSignOut(token, "download", false);
  if (result.kind === "other_tabs") throw new WritingDecisionError("close the other writing tabs before discarding incompatible work");
  try {
    await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      for (const store of [draftStore, outboxStore]) {
        await new Promise<void>((resolve, reject) => {
          const scan = store.openCursor();
          scan.onerror = () => reject(scan.error);
          scan.onsuccess = () => {
            const cursor = scan.result;
            if (cursor === null) { resolve(); return; }
            try {
              const outer = envelope(cursor.value);
              let compatible = outer.schema_revision === SCHEMA_REVISION && database?.version === SCHEMA_REVISION;
              if (compatible) {
                try { if (store.name === "drafts") decodeDraft(outer.payload); else decodeOutbox(outer.payload); }
                catch (error) { if (!(error instanceof TypeError)) throw error; compatible = false; }
              }
              if (!compatible) cursor.delete();
              cursor.continue();
            } catch (error) { reject(error); }
          };
        });
      }
    }, true);
    invalidate("*", Date.now()); await refreshJournal();
  } finally { await restoreRuntimeLease(token); }
}
export interface ConflictShown { readonly revision: number; readonly saved_version: number | string | null }
export async function resolveDraftConflict(handle: DraftHandle, decision: "mine" | "saved", shown: ConflictShown): Promise<void> {
  assertAdmission();
  await pending; await branchReady.get(handle.draft_id);
  const draft = drafts.get(handle.draft_id);
  if (!draft?.conflict || handles.get(handle.draft_id) !== handle || !releases.has(handle.draft_id)) throw new WritingDecisionError("the conflict changed; review the current comparison");
  if (draft.revision !== shown.revision || draft.conflict.saved_version !== shown.saved_version) throw new WritingDecisionError("the conflict changed; review the current comparison");
  const conflict = draft.conflict;
  if (conflict.saved_value === null || conflict.saved_version === null)
    throw new WritingDecisionError("review the saved resource before making a new decision");
  if (state.outbox.some(row => row.uncertain && row.authored.some(item => item.draft_id === draft.draft_id)))
    throw new WritingDecisionError("stop the uncertain change before making a new decision");
  const value = decision === "saved" ? conflict.saved_value : draft.value;
  // The decision changes the base/selected value of this already authored
  // revision. Only committed editor input advances its revision; newer input
  // must remain distinguishable while this transaction waits for indexeddb.
  const next = { ...draft, value, base: { value: conflict.saved_value, version: conflict.saved_version }, conflict: null };
  const intent: WritingIntent | null = decision === "mine" && draft.resource_ref !== null && typeof conflict.saved_version === "number"
    ? value.kind === "body" ? { kind: "body", policy: "explicit", note_id: draft.resource_ref.slice(draft.resource_ref.indexOf(":") + 1), body_pm_json: value.body_pm_json, expected: { kind: "observed", ref: draft.resource_ref, lane: "body", version: conflict.saved_version } }
      : value.kind === "title" ? { kind: "title", policy: "explicit", page_id: draft.resource_ref.slice(draft.resource_ref.indexOf(":") + 1), title: value.text, expected: { kind: "observed", ref: draft.resource_ref, lane: "title", version: conflict.saved_version } } : null
    : null;
  await runLocal(async () => {
    await journalTransaction("readwrite", async (draftStore, outboxStore) => {
      const raw = await request(draftStore.get(draft.draft_id));
      const current = raw === undefined ? draft : decodeDraft(envelope(raw).payload);
      if (current.revision !== shown.revision || current.conflict === null || current.conflict.saved_version !== shown.saved_version || current.conflict.saved_value === null || !sameDraftValue(current.conflict.saved_value, conflict.saved_value!)) throw new WritingDecisionError("the conflict changed; review the current comparison");
      for (const raw of await request(outboxStore.getAll())) {
        const row = decodeOutbox(envelope(raw).payload);
        if (row.blocked !== null && row.authored.some(item => item.draft_id === draft.draft_id) && row.sequence !== null)
          await request(outboxStore.delete(row.sequence));
      }
      await request(draftStore.put(draftEnvelope(next)));
      if (intent !== null) {
        const snapshot: AuthoredSnapshot = { draft_id: next.draft_id, revision: next.revision, value: next.value, selection: next.selection, conflict: null };
        const row = rowFor(crypto.randomUUID(), intent, [snapshot]);
        await putAdmission(draftStore, outboxStore, row, [snapshot]);
      }
    });
    adoptDraft(next); invalidate("*", Date.now()); await refreshJournal();
  });
}
export async function exportWriting(token: WritingRuntimeToken): Promise<Blob> {
  assertWritingRuntimeToken(token);
  await pending; await Promise.all(branchReady.values());
  assertWritingRuntimeToken(token);
  const blob = new Blob([JSON.stringify({
    schema_revision: SCHEMA_REVISION, account_id: state.account_id, exported_at: new Date().toISOString(),
    drafts: [...drafts.values()].filter(draft => draft.revision > 0 || durableRevisions.has(draft.draft_id)).map(draft => ({
      ...draftEnvelope(draft), durable_revision: durableRevisions.get(draft.draft_id) ?? null,
    })),
    outbox: state.outbox.map(outboxEnvelope), memory_outbox: [...pendingAdmissions.values()].map(outboxEnvelope), pending_literal_consumptions: [...pendingReferenceConsumes.values()],
    incompatible: state.incompatible,
  }, null, 2)], { type: "application/json" });
  lastExport = { generation: token.generation, fingerprint: signOutFingerprint() };
  return blob;
}
export function writingHasMemoryOnlyChanges(): boolean {
  return [...drafts.values()].some(draft => draft.revision > 0 && !draftIsDurable(draft.draft_id)) || pendingAdmissions.size > 0;
}
export function writingAccount(): string | null { return state.account_id; }
export function writingRuntimeToken(): WritingRuntimeToken {
  if (state.account_id === null) throw new WritingDecisionError("no writing account is active");
  return { account_id: state.account_id, generation: runtimeGeneration };
}
export function assertWritingRuntimeToken(token: WritingRuntimeToken): void {
  if (token.account_id !== state.account_id || token.generation !== runtimeGeneration)
    throw new WritingDecisionError("the writing account changed");
}
export async function runWritingAttempt(work: (signal: AbortSignal) => Promise<void>, signingOut = false): Promise<void> {
  if (signingOut && (releaseExclusive === null || releaseSignOut === null)) return;
  if ((admissionStopped && !signingOut) || state.storage_error !== null || state.incompatible.length > 0) return;
  const generation = epoch;
  let finished!: () => void;
  attemptFinished = new Promise(resolve => { finished = resolve; });
  const controller = new AbortController();
  attempt = controller;
  try {
    await navigator.locks.request(lockName("drain"), { signal: controller.signal }, async granted => {
      if (!granted || generation !== epoch) return;
      if ((admissionStopped && !signingOut) || state.storage_error !== null) return;
      await pending; await refreshJournal(); await work(controller.signal);
    });
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { attempt = null; finished(); }
}
export function failWritingStorage(error: unknown): void { storageFailure(error); }
async function restoreRuntimeLease(token: WritingRuntimeToken): Promise<void> {
  assertWritingRuntimeToken(token);
  signOutReview = null;
  releaseExclusive?.(); releaseExclusive = null;
  const release = await lock(`nexus-writing:${token.account_id}:runtime`, "shared");
  try { assertWritingRuntimeToken(token); } catch (error) { release?.(); throw error; }
  releaseRuntime = release;
  if (database !== null) watchJournalVersion(database);
  admissionStopped = false; state = { ...state, paused: false };
  releaseSignOut?.(); releaseSignOut = null; publish();
}
export async function prepareSignOut(
  token: WritingRuntimeToken, choice: "sync" | "download" | "discard" | "cancel", download_receipt = false,
): Promise<SignOutResult> {
  assertWritingRuntimeToken(token);
  if (choice === "cancel") {
    if (releaseSignOut !== null) await restoreRuntimeLease(token);
    return { kind: "cancelled" };
  }
  if (state.account_id === null) return { kind: "ready" };
  if (releaseSignOut === null) {
    const release = await lock(lockName("signout"), "exclusive");
    try { assertWritingRuntimeToken(token); } catch (error) { release?.(); throw error; }
    releaseSignOut = release;
  }
  admissionStopped = true; state = { ...state, paused: true }; publish();
  attempt?.abort(); await attemptFinished; await pending;
  await Promise.all(branchReady.values());
  assertWritingRuntimeToken(token);
  releaseRuntime?.(); releaseRuntime = null;
  if (releaseExclusive === null) {
    const release = await lock(lockName("runtime"), "exclusive", true);
    try { assertWritingRuntimeToken(token); } catch (error) { release?.(); throw error; }
    releaseExclusive = release;
  }
  if (releaseExclusive === null) { await restoreRuntimeLease(token); return { kind: "other_tabs" }; }
  if (database !== null) await refreshJournal();
  assertWritingRuntimeToken(token);
  if (choice === "download" && (!download_receipt || lastExport?.generation !== token.generation || lastExport.fingerprint !== signOutFingerprint())) return { kind: "needs_download_receipt" };
  if (choice === "sync") {
    if (state.outbox.length > 0 || writingHasMemoryOnlyChanges() || [...drafts.values()].some(draft => draft.conflict !== null || (draft.base === null ? draft.revision > 0 : !sameDraftValue(draft.value, draft.base.value))) || state.incompatible.length > 0)
      return { kind: "needs_resolution" };
  }
  signOutReview = { choice, fingerprint: signOutFingerprint() };
  return { kind: "ready" };
}
function signOutFingerprint(): string {
  return JSON.stringify([epoch, [...drafts.values()], state.outbox, [...pendingAdmissions.values()], [...pendingReferenceConsumes.values()], state.incompatible]);
}
/** Purge is the final reviewed account action, after native teardown succeeds. */
export async function commitSignOut(token: WritingRuntimeToken): Promise<void> {
  assertWritingRuntimeToken(token);
  if (releaseSignOut === null || releaseExclusive === null || signOutReview === null || signOutReview.fingerprint !== signOutFingerprint())
    throw new WritingDecisionError("review the current writing before signing out");
  if (database !== null) await journalTransaction("readwrite", async (draftStore, outboxStore) => {
    await request(draftStore.clear()); await request(outboxStore.clear());
  }, true);
  epoch += 1;
  drafts.clear(); durableRevisions.clear(); pendingAdmissions.clear(); pendingReferenceConsumes.clear(); handles.clear(); branchUsers.clear();
  state = { ...state, drafts: [], outbox: [], incompatible: [] }; publish();
  signOutReview = null;
}
export async function finishSignOut(token: WritingRuntimeToken, succeeded: boolean): Promise<void> {
  assertWritingRuntimeToken(token);
  // Successful sign-out keeps both gates through the actual document navigation.
  if (succeeded) return;
  else if (releaseSignOut !== null) await restoreRuntimeLease(token);
}

