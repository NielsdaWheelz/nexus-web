/** Native adapter uses the same shared semantic kernel. Kotlin admits only
 * closed SQL transactions and fixed foreground transport operations. */
import { bindingQueries, changesDailyIndex, excerptQuery, searchQuery, sourceAliasQuery, pageTitle, foldedFields, type CompiledQuery } from "@nexus/authored/queries";
import { decodeBytes } from "@nexus/authored/documents";
import { validateBindings } from "@nexus/authored/identity";
import { mergeChanges } from "@nexus/authored/merge";
import { FORMAT_REVISION, type AuthoredStore, type Corpus, type Change, type FeedChange, type MergeResult, type ReplicaState, type StateSelection, type QueryResult, type OutlineWindowSlice, type SyncFailure, type SyncStatus } from "@nexus/authored/types";
import type { ScopeInputsPage, ScopeProgress, ScopeTextPage, ScopeNormalizationInterval, ScopeRawChunk, ScopeNormalizationObservation, NormalizedScopeChunk } from "@nexus/authored/scope";
import { decodeOutlineWindow, selectionFor } from "./persistence";
import { nativeQueryPlans, nativeSearchPlan } from "./nativeQuery";
import { Sync } from "./sync";
import { scheduleReplication } from "./schedule";
import { setNativeForeground } from "@/lib/native/foreground";
import { ApiError } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { observeWorkerUpdate } from "@/lib/native/admission";
import { syncStatus, uploadStall } from "./status";
type Port = { postMessage(frame: string): void; onmessage: ((event: { data: string }) => void) | null };
let nextId = 0;
let installedPort: Port | null = null;
let protocolFailure: ApiError | null = null;
let foregroundRevision = BigInt(-1);
function receiveForeground(active: boolean, revision: string) {
  if (BigInt(revision) < foregroundRevision) return;
  foregroundRevision = BigInt(revision); setNativeForeground(active);
}
const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
/** protocol refusal retires this document's channel, never native storage. */
function refuseNativeProtocol(): ApiError {
  const failure = protocolFailure ?? new ApiError(426, "E_WIRE_MISMATCH", "update nexus to open local writing");
  protocolFailure = failure;
  if (installedPort !== null) installedPort.onmessage = null;
  installedPort = null;
  for (const waiting of pending.values()) waiting.reject(failure);
  pending.clear();
  observeWorkerUpdate();
  return failure;
}
function nativePort(): Port {
  if (protocolFailure !== null) throw protocolFailure;
  const port = (window as Window & { nexusAuthored?: Port }).nexusAuthored;
  if (!port) throw new Error("native authored storage unavailable");
  if (installedPort !== port) {
  installedPort = port;
  port.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.kind === "authored_foreground") { receiveForeground(reply.active, reply.revision); return; }
    const waiting = pending.get(reply.id); pending.delete(reply.id);
    if (waiting === undefined) return;
    if (reply.ok) { waiting.resolve(reply.result); return; }
    const { message, status, code } = reply.error;
    const invariant = code === "E_AUTHORED" && status === 500;
    waiting.reject(Object.assign(new Error(message), invariant ? { code } : { status, code }));
  };
  }
  return port;
}
async function frame<T>(op: string, input: Record<string, unknown> = {}, signal?: AbortSignal, timeout = 30_000): Promise<T> {
  signal?.throwIfAborted();
  const id = ++nextId;
  const port = nativePort();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); };
    const cancel = () => port.postMessage(JSON.stringify({ id: ++nextId, op: "cancel", target_id: id }));
    const abort = () => { cleanup(); cancel(); reject(signal?.reason ?? new DOMException("cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); cancel(); reject(Object.assign(new Error("native authored operation did not acknowledge completion"), { status: 504 })); }, timeout);
    pending.set(id, { resolve: value => { cleanup(); resolve(value as T); }, reject: error => { cleanup(); reject(error); } });
    signal?.addEventListener("abort", abort, { once: true });
    port.postMessage(JSON.stringify({ id, op, ...input }));
  });
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function call<T>(op: string, input: Record<string, unknown> = {}, signal?: AbortSignal, projections?: MergeResult["projections"]): Promise<T> {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify({ op, ...input }));
  if (projections?.length) {
    // Keep a canonical commit admissible even when its derived fields would exceed a native transfer.
    const literal = projections.map(p => [p.ref, ...foldedFields({title: p.kind === "page" ? pageTitle(p.title ?? "", p.local_date) : p.title,
      body: p.body_text, quote: p.selection?.quote_exact})]);
    const suffix = encoder.encode(`,"literal_fields":${JSON.stringify(literal)}}`);
    if (bytes.length - 1 + suffix.length <= 16 * 1024 * 1024) {
      const combined = new Uint8Array(bytes.length - 1 + suffix.length);
      combined.set(bytes.subarray(0,-1)); combined.set(suffix, bytes.length - 1); bytes = combined;
    }
  }
  const transfer_id = crypto.randomUUID();
  try {
  let byte_count: number;
  const timeout = op === "snapshot" ? 300_000 : 30_000;
  if (bytes.byteLength <= 24 * 1024) {
    const result = await frame<{ kind: "inline"; byte_count: number; base64: string } | { kind: "transfer"; byte_count: number }>("invoke_inline", { transfer_id, base64: base64(bytes) }, signal, timeout);
    if (result.kind === "inline") {
      const raw = unbase64(result.base64);
      if (raw.byteLength !== result.byte_count || raw.byteLength > 24 * 1024) throw new Error("invalid native authored inline framing");
      return JSON.parse(new TextDecoder().decode(raw));
    }
    byte_count = result.byte_count;
  } else {
    await frame("begin", { transfer_id, byte_count: bytes.byteLength }, signal);
    for (let offset = 0; offset < bytes.byteLength; offset += 24 * 1024) await frame("chunk", { transfer_id, offset, base64: base64(bytes.subarray(offset, offset + 24 * 1024)) }, signal);
    ({ byte_count } = await frame<{ byte_count: number }>("invoke", { transfer_id }, signal, timeout));
  }
  const output = new Uint8Array(byte_count);
  for (let offset = 0; offset < byte_count;) {
    const chunk = await frame<{ base64: string; next_offset: number }>("read", { transfer_id, offset }, signal);
    const raw = unbase64(chunk.base64);
    if (chunk.next_offset !== offset + raw.byteLength || raw.byteLength === 0) throw new Error("invalid native authored result framing");
    output.set(raw, offset); offset = chunk.next_offset;
  }
  return JSON.parse(new TextDecoder().decode(output));
  } catch (error) {
    void frame("discard_transfer", { transfer_id }).catch(reportError);
    throw error;
  }
}

/** Canonical local text repairs old installations or a write whose derived sidecar did not fit.
 * A large field crosses in pieces and is normalized as a whole, preserving NFC and final sigma. */
async function repairLiteralFields() {
  const {revision, items} = await call<{revision: string; items: {ref: string; fields: [string,string,string] | null}[]}>("literal_inputs");
  const small: string[][] = [];
  for (const {ref, fields} of items) {
    if (fields !== null) { small.push([ref, ...foldedFields({title: fields[0],body: fields[1],quote: fields[2]})]); continue; }
    const ticket = crypto.randomUUID();
    for (const field of ["title","body","quote"] as const) {
      const decoder = new TextDecoder(), text: string[] = [];
      for (let offset = 0;;) {
        const piece: {changed: boolean; chunk: string | null} = await call("literal_piece", {revision, ref, field, offset});
        if (piece.changed) return;
        const bytes = decodeBytes(piece.chunk!);
        text.push(decoder.decode(bytes, {stream: true})); offset += bytes.length;
        if (bytes.length < 65536) break;
      }
      text.push(decoder.decode());
      const [folded] = foldedFields({title: text.join("")});
      for (let offset = 0;;) {
        let end = Math.min(folded.length, offset + 65536);
        if (end < folded.length && /[\uD800-\uDBFF]/u.test(folded[end-1]!)) end--;
        const last = end === folded.length;
        const {accepted} = await call<{accepted: boolean}>("literal_part", {ticket, revision, ref, field, offset, text: folded.slice(offset,end), last});
        if (!accepted) return;
        if (last) break;
        offset = end;
      }
    }
  }
  if (small.length) await call("literal_install", {revision, items: small});
}

export async function openNativeAuthoredStore(accountId: string): Promise<AuthoredStore> {
  const replica = await nativeHello(accountId);
  let lease: string | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
  const queries = new Set<(corpusChanged: boolean, dailyIndexChanged: boolean) => void>();
  const evidence = new Set<() => void>();
  const closedWaiters = new Set<() => void>();
  const statuses = new Set<(status: SyncStatus, detail: string | null, failure: SyncFailure) => void>();
  const changed = (corpusChanged = false, dailyIndexChanged = false) => { for (const listener of statuses) listener(syncStatus(sync.facts), sync.detail, sync.facts.failure); for (const listener of queries) listener(corpusChanged, dailyIndexChanged); };
  const queryLocal = async (query: Parameters<AuthoredStore["query"]>[0]): Promise<QueryResult> => {
    if (query.kind === "outline_windows") {
      const plans = await nativeQueryPlans(query);
      for (;;) {
        const windows: OutlineWindowSlice[] = [];
        let revision: string | null = null;
        for (const plan of plans) {
          const records: Record<string, unknown>[] = [];
          let start: number | null = 0;
          while (start !== null) {
            const part: {revision: string; records?: Record<string, unknown>[]; next: number | null} =
              await call("outline_read", {plan, start, revision});
            if (revision !== null && part.revision !== revision) break;
            revision = part.revision;
            records.push(...part.records!);
            start = part.next;
          }
          if (start !== null) break;
          windows.push(decodeOutlineWindow(records));
        }
        if (windows.length === plans.length && revision !== null) return {
          store_revision: revision, rows: [], children: [], positions: [], binding_id: null, scope_available: true,
          next_cursor: null, previous_cursor: null, canonical_source_ref: null, outline_windows: windows,
          page_register: null, page_label: null, outline_filter: null, work_index: null, habits: null, mentions: null,
          habit_days: null, latest_habit_date: null, daily_index: null,
        };
      }
    }
    if (query.kind !== "search" && query.kind !== "search_preview" && query.kind !== "search_admission" && query.kind !== "source_alias" && query.kind !== "excerpt") {
      const plans = await nativeQueryPlans(query);
      for (;;) {
        const value = await call<QueryResult | {literal_repair: true}>("query", {query, plans});
        if (!("literal_repair" in value)) return value;
        await repairLiteralFields();
      }
    }
    for (;;) {
      const before = await call<ReplicaState>("replica");
      const read = async (plan: CompiledQuery) => (await call<{rows: Record<string, unknown>[]}>("search_read", await nativeSearchPlan(plan))).rows;
      const result = query.kind === "excerpt" ? await excerptQuery(read,query) : query.kind === "source_alias" ? await sourceAliasQuery(read, query)
        : await searchQuery(read, query, async (text, expression) => (await call<{score: number|null}>("search_match", {text,expression})).score);
      const after = await call<ReplicaState>("replica");
      if (before.store_revision === after.store_revision) return {store_revision:after.store_revision,...result};
    }
  };
  const changeStates = async (changes: Change[]) => {
    const selection: StateSelection = { refs: [], link_ids: [], anchor_ids: [], source_refs: [] };
    for (const change of changes) {
      const touched = selectionFor(change);
      for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) selection[key].push(...touched[key]);
      for (const binding of bindingQueries(change)) {
        const known = await queryLocal(binding.query);
        if (known.binding_id !== null) selection[binding.selector].push(known.binding_id);
      }
    }
    for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) selection[key] = [...new Set(selection[key])];
    return call<Parameters<typeof mergeChanges>[0]>("states", { selection });
  };
  const persistence = {
    replica: () => call<ReplicaState>("replica"),
    pending: async () => (await call<{ changes: Change[] }>("pending")).changes,
    acknowledge: async (sequence: string) => { await call("acknowledge", { sequence }); },
    applyRemote: async (entries: FeedChange[], nextCursor: string): Promise<ReplicaState> => {
      for (;;) {
        const current = await call<ReplicaState>("replica");
        if (BigInt(current.server_cursor) >= BigInt(nextCursor)) return current;
        const changes = entries.filter(entry => BigInt(entry.server_seq) > BigInt(current.server_cursor));
        const states = await changeStates(changes.map(entry => entry.change));
        await validateBindings(accountId, states, changes.map(entry => entry.change));
        const merged = mergeChanges(states, changes.map(entry => entry.change));
        const result = await call<ReplicaState | { kind: "stale" }>("apply_remote", { expected_store_revision: current.store_revision, changes, next_cursor: nextCursor, states: merged }, undefined, merged.projections);
        if (!("kind" in result)) return result;
      }
    },
    resetProvisioning: async () => { await call("reset_provisioning"); },
    stage: async (states: MergeResult) => {
      const ceiling = 16 * 1024 * 1024 - 1024;
      const encoder = new TextEncoder();
      const empty: MergeResult = {resources: [], links: [], passages: [], source_stubs: [], projections: []};
      const byRef = new Map(states.projections.map(projection => [projection.ref, projection]));
      // Each stage is unpublished until finishProvisioning commits its exact counts.
      const stage = async <T,>(records: readonly T[], corpus: (rows: T[]) => MergeResult,
        project: (row: T) => MergeResult["projections"][number] | undefined) => {
        let rows: T[] = [], projections: MergeResult["projections"] = [], size = 0;
        const flush = async () => {
          if (rows.length === 0) return;
          await call("stage", {states: {...corpus(rows), projections}}, undefined, projections);
          rows = []; projections = []; size = 0;
        };
        for (const row of records) {
          const projection = project(row);
          const bytes = encoder.encode(JSON.stringify(row)).byteLength +
            (projection === undefined ? 0 : encoder.encode(JSON.stringify(projection)).byteLength) + 2;
          if (bytes > ceiling) throw new RangeError("authored snapshot record exceeds the native transfer limit");
          if (size + bytes > ceiling) await flush();
          rows.push(row);
          if (projection !== undefined) projections.push(projection);
          size += bytes;
        }
        await flush();
      };
      await stage(states.resources, resources => ({...empty, resources}), row => byRef.get(row.ref));
      await stage(states.passages, passages => ({...empty, passages}), row => byRef.get(`passage_anchor:${row.anchor_id}`));
      await stage(states.source_stubs, source_stubs => ({...empty, source_stubs}), () => undefined);
      await stage(states.links, links => ({...empty, links}), () => undefined);
    },
    finishProvisioning: async (cursor: string, counts: Record<string, number>, lamport: string) => { await call("finish_provisioning", { cursor, counts, lamport }); },
    scopeProgress: () => call<ScopeProgress>("scope_progress"),
    scopeRefs: async (after: string | null) => (await call<{refs: string[]}>("scope_refs", {after})).refs,
    scopeRepairRefs: async (refs: string[]) => (await call<{refs: string[]}>("scope_repair_refs", {refs})).refs,
    scopeNeedsRepair: async () => (await call<{needed: boolean}>("scope_needs_repair")).needed,
    scopeReset: async (revision: string, repair = false) => { await call("scope_reset", {revision,repair}); },
    scopeRevoke: async (refs: string[]) => (await call<{changed: boolean}>("scope_revoke", {refs})).changed,
    scopeMetadata: async (page: ScopeInputsPage, requestedCursor: string | null) => (await call<{accepted: boolean}>("scope_metadata", {page,requested_cursor:requestedCursor})).accepted,
    scopeText: async (page: ScopeTextPage, requestedCursor: string | null) => (await call<{accepted: boolean}>("scope_text", {page,requested_cursor:requestedCursor})).accepted,
    scopeReuse: async (revision: string, readingRef: string) => (await call<{accepted: boolean}>("scope_reuse", {revision,reading_ref:readingRef})).accepted,
    scopeNormalizationNext: async (revision: string, readingRef: string) => (await call<{interval: ScopeNormalizationInterval | null}>("scope_normalization_next", {revision,reading_ref:readingRef})).interval,
    scopeNormalizationRead: async (revision: string, readingRef: string, intervalKey: string, after: number | null) => (await call<{chunk: ScopeRawChunk | null}>("scope_normalization_read", {revision,reading_ref:readingRef,interval_key:intervalKey,after})).chunk,
    scopeNormalizationObservation: (revision: string, readingRef: string, intervalKey: string, after: number | null) => call<ScopeNormalizationObservation>("scope_normalization_observation", {revision,reading_ref:readingRef,interval_key:intervalKey,after}),
    scopeNormalizationReset: async (revision: string, readingRef: string, intervalKey: string) => { await call("scope_normalization_reset", {revision,reading_ref:readingRef,interval_key:intervalKey}); },
    scopeNormalized: async (revision: string, readingRef: string, intervalKey: string, chunks: NormalizedScopeChunk[], normalizedLength: number | null) => (await call<{accepted: boolean}>("scope_normalized", {revision,reading_ref:readingRef,interval_key:intervalKey,chunks,normalized_length:normalizedLength})).accepted,
    scopeTextComplete: async (revision: string, readingRef: string) => (await call<{accepted: boolean}>("scope_text_complete", {revision,reading_ref:readingRef})).accepted,
    scopePublish: async (revision: string, expectedStoreRevision: string) => (await call<{accepted: boolean}>("scope_publish", {revision,expected_store_revision:expectedStoreRevision})).accepted,
  };
  const sync = new Sync(persistence, {
    json: <T,>(path: string, body: unknown | null, signal: AbortSignal): Promise<T> => {
      if (path === "/api/authored/scope-inputs") return call<T>("scope_inputs", {body}, signal);
      if (path === "/api/authored/scope-text") return call<T>("scope_text_remote", {body}, signal);
      if (path === "/api/authored/replicas") return call<T>("register", {body}, signal);
      if (path === "/api/authored/changes" && body !== null) return call<T>("push", {body}, signal);
      const url = new URL(path, location.origin);
      if (url.pathname === "/api/authored/changes" && body === null) return call<T>("pull", {after:url.searchParams.get("after")}, signal);
      return Promise.reject(new Error("unknown native authored transport operation"));
    },
    snapshot: async signal => {
      await call("snapshot", {}, signal);
      let offset = 0;
      return new ReadableStream<Uint8Array>({ pull: async controller => {
        const chunk = await frame<{ base64: string; next_offset: number; done: boolean }>("snapshot_chunk", { offset }, signal);
        controller.enqueue(unbase64(chunk.base64)); offset = chunk.next_offset;
        if (chunk.done) controller.close();
      }, cancel: async () => { await frame("snapshot_cancel"); } });
    },
  }, serialize, changed, () => { for (const listener of evidence) listener(); });
  sync.facts.ready = replica.provisioning_complete; sync.facts.cursor = replica.server_cursor; sync.facts.pending = (await persistence.pending()).length > 0;
  sync.facts.online = navigator.onLine;
  const replication = scheduleReplication(refresh => { sync.facts.online = navigator.onLine; return sync.step({ refresh }); }, reportError);
  return {
    withCommand: async work => {
      if (closed) throw new Error("authored account closed");
      lease = (await call<{ lease: string }>("command_begin")).lease;
      try { return await work(); } finally { const token = lease; lease = null; await call("command_end", { lease: token }); }
    },
    whenUploaded: (commandSeq, signal) => new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown | null) => { if (done) return; done = true; queries.delete(check); signal.removeEventListener("abort", aborted); closedWaiters.delete(aborted); if (error !== null) reject(error); else resolve(); };
      const aborted = () => finish(signal.reason ?? new DOMException("authored store closed", "AbortError"));
      const check = () => { void call<{ uploaded: boolean }>("uploaded", { command_seq: commandSeq }).then(result => {
        if (result.uploaded) { finish(null); return; }
        const stall = uploadStall({ status: syncStatus(sync.facts), detail: sync.last_error, failure: sync.facts.failure }, Date.now());
        if (stall !== null) finish(stall);
      }, finish); };
      if (signal.aborted) { aborted(); return; }
      queries.add(check); closedWaiters.add(aborted); signal.addEventListener("abort", aborted, { once: true }); check();
    }),
    readSnapshot: selection => serialize(async () => {
      type StateRecord = {[K in keyof Corpus]: {kind: K; value: Corpus[K][number]}}[keyof Corpus];
      for (;;) {
        const states: Corpus = {resources: [], links: [], passages: [], source_stubs: []};
        let replica: ReplicaState | null = null, start: number | null = 0;
        while (start !== null) {
          const part: {replica: ReplicaState; records?: StateRecord[]; next: number | null} =
            await call("read_snapshot", {selection, start, revision: replica?.store_revision ?? null});
          if (replica !== null && replica.store_revision !== part.replica.store_revision) break;
          replica = part.replica;
          for (const record of part.records!) {
            switch (record.kind) {
              case "resources": states.resources.push(record.value); break;
              case "links": states.links.push(record.value); break;
              case "passages": states.passages.push(record.value); break;
              case "source_stubs": states.source_stubs.push(record.value); break;
            }
          }
          start = part.next;
        }
        if (start === null && replica !== null) return {replica, states};
      }
    }),
    readReplica: () => serialize(persistence.replica),
    readStates: selection => serialize(() => call("states", { selection })),
    query: query => serialize(() => queryLocal(query)),
    commit: frame => serialize(async () => {
      sync.facts.saving = true; changed();
      try {
        const states = await changeStates([frame.change]);
        await validateBindings(accountId, states, [frame.change]);
        frame = { ...frame, states: mergeChanges(states, [frame.change]) };
        const result = await call<Awaited<ReturnType<AuthoredStore["commit"]>>>("commit", { frame, lease }, undefined, frame.states.projections); sync.facts.pending = true; if (result.kind === "committed") changed(true, changesDailyIndex(frame.change)); replication.wake(); return result; }
      finally { sync.facts.saving = false; changed(); }
    }),
    subscribe: (query, listener, failed) => {
      let live = true, queued = false;
      const read = (corpusChanged: boolean, dailyIndexChanged: boolean) => {
        if (!live || queued || !(query.kind === "daily_index" ? dailyIndexChanged : corpusChanged)) return;
        queued = true;
        void serialize(async () => {
          queued = false;
          return live ? queryLocal(query) : null;
        }).then(value => { if (live && value !== null) listener(value); }, error => { if (live) failed(error); });
      };
      queries.add(read); read(true, true);
      return () => { live = false; queries.delete(read); };
    },
    evidence_changed: listener => { evidence.add(listener); return () => { evidence.delete(listener); }; },
    sync_status: listener => { statuses.add(listener); listener(syncStatus(sync.facts), sync.detail, sync.facts.failure); return () => { statuses.delete(listener); }; },
    close: async () => {
      closed = true; replication.close(); sync.close();
      for (const cancel of closedWaiters) cancel(); closedWaiters.clear();
      queries.clear(); statuses.clear(); evidence.clear();
      await sync.stopped(); await queue;
    },
  };
}
/** Shelf derives the provider identity from native authority, never its URL. */
export async function readNativeAuthoredAccount(): Promise<string> { return (await nativeHello(null)).account_id; }
async function nativeHello(accountId: string | null): Promise<ReplicaState> {
  let replica: ReplicaState & {wire_revision: number; foreground: boolean; foreground_revision: string};
  try { replica = await call<typeof replica>("hello", {wire_revision:WIRE_REVISION,format_revision:FORMAT_REVISION,account_id:accountId}); }
  catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 426) throw refuseNativeProtocol();
    if (error !== null && typeof error === "object" && "status" in error && error.status === 403) throw new ApiError(403, "E_ACCOUNT_MISMATCH", "sign in with the account saved on this device");
    throw error;
  }
  if (replica.wire_revision !== WIRE_REVISION || replica.format_revision !== FORMAT_REVISION) throw refuseNativeProtocol();
  if (accountId !== null && replica.account_id !== accountId) throw new ApiError(403, "E_ACCOUNT_MISMATCH", "sign in with the account saved on this device");
  receiveForeground(replica.foreground, replica.foreground_revision);
  return replica;
}
