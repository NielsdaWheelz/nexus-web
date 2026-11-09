/** Foreground replication. Upload and download fail independently. Every retry
 * sends the same durable source bytes; only verified acceptance removes pending.
 * The foreground host requests every finite unit; this owner has no timer.
 * Scope hydration advances bounded pages beside writing replication. Its durable
 * staging and final fence never expand authored snapshot time or local readiness. */
import { mergeChanges } from "@nexus/authored/merge";
import { FORMAT_REVISION, type FeedChange, type MergeResult } from "@nexus/authored/types";
import { Persistence } from "./persistence";
import { SIGN_IN_SYNC_DETAIL, UPDATE_SYNC_DETAIL, syncDetail, type SyncFacts } from "./status";
import { ScopeTextNormalizer, type ScopeInputsPage, type ScopeTextPage, type ScopeNormalizationInterval, type NormalizedScopeChunk } from "@nexus/authored/scope";

/** A failure of the connection or its answer carries a numeric `status` and, where the answer
 * names one, its `code`. Status 0 is a lost connection, including a body that died mid-read.
 * A failure with no status is a broken local invariant. */
export interface Transport {
  json<T>(path: string, body: unknown | null, signal: AbortSignal): Promise<T>;
  snapshot(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
/** A later attempt can answer these differently. 409 is here because the api answers a busy
 * row lock with it, and no wire field separates that from a permanent conflict. */
const TRANSIENT_4XX: ReadonlySet<number> = new Set([409, 429]);
export interface SyncStep { more: boolean; retry_after_ms: number | null }
type Lane = "setup" | "upload" | "download" | "scope";
type Failure = { error: unknown; attempts: number; since: number; retry_at: number | null };

export class Sync {
  private readonly abort = new AbortController();
  private running: Promise<SyncStep> | null = null;
  private retired = false;
  private registered = false;
  private refreshRequested = false;
  private pullNeeded = false;
  private pullTarget: string | null = null;
  private scopeCheck = false;
  private sweep: { after: string | null; revision: string; repair: boolean } | null = null;
  private readonly failures = new Map<Lane, Failure>();
  private evidenceRevision: string | null = null;
  private normalization: {revision: string; reading: string; interval: ScopeNormalizationInterval; normalizer: ScopeTextNormalizer; after: number | null; nextRaw: number} | null = null;
  last_error: string | null = null;
  readonly facts: SyncFacts = { local_error: false, saving: false, ready: false, admission: "ready", failure: null, online: true, pending: false, scope_pending: true, scope_progress: null, cursor: "0", head: null };
  get detail(): string | null { return syncDetail(this.facts, this.last_error); }
  constructor(readonly persistence: Pick<Persistence, "replica" | "pending" | "acknowledge" | "applyRemote" | "resetProvisioning" | "stage" | "finishProvisioning" | "scopeProgress" | "scopeRefs" | "scopeRepairRefs" | "scopeNeedsRepair" | "scopeReset" | "scopeRevoke" | "scopeMetadata" | "scopeText" | "scopeReuse" | "scopeNormalizationNext" | "scopeNormalizationRead" | "scopeNormalizationObservation" | "scopeNormalizationReset" | "scopeNormalized" | "scopeTextComplete" | "scopePublish">, readonly transport: Transport, readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>, readonly changed: (corpusChanged?: boolean) => void, readonly evidenceChanged: () => void) {}
  step({ refresh }: { refresh: boolean }): Promise<SyncStep> {
    if (refresh) {
      this.refreshRequested = true;
      // Only an admitted host calls again after repairing the account session.
      if (this.facts.admission === "auth") {
        this.facts.admission = "ready";
        for (const [lane, failure] of this.failures) {
          const status = this.status(failure.error);
          if (status === 401 || status === 403) this.failures.delete(lane);
        }
      }
    }
    if (this.retired) return Promise.resolve({ more: false, retry_after_ms: null });
    if (this.running) return this.running;
    this.running = this.run().catch(error => {
      if (!this.retired) {
        this.facts.local_error = error !== null && typeof error === "object" && "code" in error && error.code === "E_AUTHORED_LOCAL";
        this.facts.failure = { kind: "Refused", since: Date.now() };
        this.last_error = this.facts.local_error ? "couldn’t prepare your notes on this device. check available storage and retry." : this.facts.ready ? null : "your notes couldn’t finish preparing.";
        this.changed();
      }
      return { more: false, retry_after_ms: null };
    }).finally(() => { this.running = null; });
    return this.running;
  }
  stopped(): Promise<unknown> { return this.running ?? Promise.resolve(); }
  private local<T>(operation: () => Promise<T>): Promise<T> { return this.serialize(() => { if (this.retired) throw new DOMException("authored synchronization stopped", "AbortError"); return operation(); }); }
  close() { this.retired = true; this.abort.abort(); }
  private status(error: unknown): number | null { return error !== null && typeof error === "object" && "status" in error ? Number(error.status) : null; }
  private due(lane: Lane): boolean {
    const failure = this.failures.get(lane);
    return failure === undefined || failure.retry_at !== null && failure.retry_at <= Date.now();
  }
  private async attempt(lane: Lane, operation: () => Promise<void>) {
    if (!this.due(lane)) return;
    try { await operation(); this.failures.delete(lane); }
    catch (error) {
      if (this.retired) return;
      const status = this.status(error);
      const previous = this.failures.get(lane);
      const attempts = (previous?.attempts ?? 0) + 1;
      const retry = status !== null && (status === 0 || status >= 500 || TRANSIENT_4XX.has(status));
      this.failures.set(lane, { error, attempts, since: previous?.since ?? Date.now(), retry_at: retry ? Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) * (0.75 + Math.random() * 0.25) : null });
      if (status === 401 || status === 403) this.facts.admission = "auth";
      if (status === 426) this.facts.admission = "format";
    }
  }
  private async run(): Promise<SyncStep> {
    try {
      const state = await this.local(() => this.persistence.replica());
      this.facts.ready = state.provisioning_complete;
      this.facts.cursor = state.server_cursor;
      if (this.facts.admission !== "ready") return { more: false, retry_after_ms: null };
      if (!this.registered) {
        await this.attempt("setup", async () => {
          const { data } = await this.transport.json<{ data: { accepted_command_seq: string; head_cursor: string } }>("/api/authored/replicas", { replica_id: state.replica_id, format_revision: FORMAT_REVISION }, this.abort.signal);
          await this.local(() => this.persistence.acknowledge(data.accepted_command_seq));
          this.facts.head = data.head_cursor;
          this.registered = true;
        });
      } else if (!state.provisioning_complete) {
        await this.attempt("setup", () => this.provision());
      } else {
        if (this.refreshRequested && !this.pullNeeded) {
          this.refreshRequested = false; this.pullNeeded = true; this.pullTarget = null;
          if (this.sweep === null) this.scopeCheck = true;
        }
        const pending = await this.local(() => this.persistence.pending());
        await Promise.all([
          pending.length ? this.attempt("upload", () => this.upload()) : Promise.resolve(),
          this.pullNeeded ? this.attempt("download", () => this.download()) : Promise.resolve(),
          this.scopeCheck || this.sweep !== null || this.facts.scope_pending ? this.attempt("scope", () => this.scopeStep()) : Promise.resolve(),
        ]);
      }
      return await this.finishStep();
    } finally { this.changed(); }
  }
  /** Publish durable progress and lane failures after every admitted unit. */
  private async finishStep(): Promise<SyncStep> {
    if (this.retired) return { more: false, retry_after_ms: null };
    const progress = await this.local(() => this.persistence.scopeProgress());
    this.facts.scope_pending = progress.active_revision === null || progress.staging_revision !== null;
    this.facts.scope_progress = progress.staging_revision === null ? null : progress;
    this.facts.pending = (await this.local(() => this.persistence.pending())).length > 0;
    const failure = [...this.failures.values()].sort((a, b) => a.since - b.since)[0];
    this.facts.local_error = failure !== undefined && failure.error !== null && typeof failure.error === "object" && "code" in failure.error && failure.error.code === "E_AUTHORED_LOCAL";
    this.facts.failure = failure === undefined || this.facts.admission !== "ready" || this.status(failure.error) === 0 && !this.facts.online ? null : { kind: failure.retry_at === null ? "Refused" : "Retrying", since: failure.since };
    this.last_error = this.facts.admission === "auth" ? SIGN_IN_SYNC_DETAIL : this.facts.admission === "format" ? UPDATE_SYNC_DETAIL : this.facts.local_error ? "couldn’t prepare your notes on this device. check available storage and retry." : !this.facts.ready && failure ? "your notes couldn’t finish preparing." : null;
    if (this.facts.admission !== "ready") return { more: false, retry_after_ms: null };
    const more = !this.registered || !this.facts.ready ? this.due("setup") :
      this.facts.pending && this.due("upload") || this.pullNeeded && this.due("download") ||
      (this.scopeCheck || this.sweep !== null || this.facts.scope_pending) && this.due("scope") ||
      this.refreshRequested && !this.pullNeeded;
    const retries = [...this.failures.values()].flatMap(value => value.retry_at === null ? [] : [Math.max(1, value.retry_at - Date.now())]);
    return { more, retry_after_ms: more || !retries.length ? null : Math.min(...retries) };
  }
  private async upload() {
    const { changes, replica } = await this.local(async () => ({ changes: await this.persistence.pending(), replica: await this.persistence.replica() }));
    if (!changes.length) return;
    const { data } = await this.transport.json<{ data: { accepted_command_seq: string; head_cursor: string } }>("/api/authored/changes", { replica_id: replica.replica_id, format_revision: FORMAT_REVISION, changes }, this.abort.signal);
    if (this.retired) return;
    if (BigInt(data.accepted_command_seq) < BigInt(changes.at(-1)!.command_seq)) throw Object.assign(new Error("incomplete authored acknowledgement"), { status: 500 });
    this.facts.head = max(this.facts.head, data.head_cursor);
    await this.local(() => this.persistence.acknowledge(data.accepted_command_seq));
  }
  private async download() {
    const replica = await this.local(() => this.persistence.replica());
    const { data } = await this.transport.json<{ data: { changes: FeedChange[]; next_cursor: string; head_cursor: string; evidence_revision: string } }>(`/api/authored/changes?after=${replica.server_cursor}`, null, this.abort.signal);
    if (this.retired) return;
    this.pullTarget ??= data.head_cursor;
    this.facts.head = max(this.facts.head, data.head_cursor);
    if (typeof data.evidence_revision !== "string") throw new Error("authored feed omitted its evidence revision");
    if (data.evidence_revision !== this.evidenceRevision) { this.evidenceRevision = data.evidence_revision; this.evidenceChanged(); }
    await this.local(async () => {
      const current = await this.persistence.applyRemote(data.changes, data.next_cursor);
      this.facts.cursor = current.server_cursor;
      this.changed(data.changes.some(change => BigInt(change.server_seq) > BigInt(replica.server_cursor)));
    });
    if (BigInt(this.facts.cursor) >= BigInt(this.pullTarget)) { this.pullNeeded = false; this.pullTarget = null; }
    else if (!data.changes.length) throw new Error("authored feed did not advance");
  }
  /** Bulk reading inputs never extend the authored snapshot or delay its local
   * admission. One hydration/normalization page shares each upload/pull turn. */
  private async scopeStep() {
    const progress = await this.local(() => this.persistence.scopeProgress());
    const revoke = async (refs: string[]) => {
      if (!refs.length) return;
      if (!await this.local(() => this.persistence.scopeRevoke(refs)).catch(error => { this.normalization = null; throw error; })) return;
      this.normalization = null;
      this.changed(true);
    };
    if (this.scopeCheck) {
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"status",revision:progress.staging_revision ?? progress.active_revision,active_refs:[]}, this.abort.signal);
      const repair = progress.staging_revision === null && await this.local(() => this.persistence.scopeNeedsRepair());
      if (data.revision !== (progress.staging_revision ?? progress.active_revision) || repair)
        this.sweep = { after: null, revision: data.revision, repair: false };
      this.scopeCheck = false;
      return;
    }
    if (this.sweep !== null) {
      const sweep = this.sweep;
      const refs = await this.local(() => this.persistence.scopeRefs(sweep.after));
      const repairRefs = await this.local(() => this.persistence.scopeRepairRefs(refs));
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"status",revision:sweep.revision,active_refs:refs}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.revision !== sweep.revision) { this.sweep = {after:null,revision:data.revision,repair:false}; return; }
      sweep.repair ||= repairRefs.some(ref => !data.revoked_refs.includes(ref));
      if (refs.length === 100) { sweep.after = refs.at(-1)!; return; }
      if (this.normalization?.revision !== sweep.revision) this.normalization = null;
      await this.local(() => this.persistence.scopeReset(sweep.revision, sweep.repair));
      this.sweep = null;
      return;
    }
    this.facts.scope_pending = progress.active_revision === null || progress.staging_revision !== null;
    this.facts.scope_progress = progress.staging_revision === null ? null : progress;
    if (progress.staging_revision === null || this.retired) return;
    const revision = progress.staging_revision;
    if (!progress.metadata_complete) {
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"metadata",revision,cursor:progress.metadata_cursor}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.restart || data.revision !== revision) { this.normalization = null; await this.local(() => this.persistence.scopeReset(data.revision)); return; }
      if (!await this.local(() => this.persistence.scopeMetadata(data, progress.metadata_cursor))) { this.normalization = null; this.facts.scope_pending = true; return; }
    } else if (progress.reading_ref !== null && !progress.raw_complete) {
      if (progress.text_cursor === null && await this.local(() => this.persistence.scopeReuse(revision, progress.reading_ref!))) { this.normalization = null; return; }
      const {data} = await this.transport.json<{data: ScopeTextPage}>("/api/authored/scope-text", {revision,reading_ref:progress.reading_ref,cursor:progress.text_cursor}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.revision === revision && data.revoked_refs.includes(progress.reading_ref)) throw new Error("scope reading access changed before refresh completed");
      if (data.restart || data.revision !== revision) { this.normalization = null; await this.local(() => this.persistence.scopeReset(data.revision)); return; }
      if (!await this.local(() => this.persistence.scopeText(data, progress.text_cursor))) { this.normalization = null; this.facts.scope_pending = true; return; }
    } else if (progress.reading_ref !== null) {
      const reading = progress.reading_ref;
      const interval = await this.local(() => this.persistence.scopeNormalizationNext(revision, reading));
      if (interval === null) {
        if (!await this.local(() => this.persistence.scopeTextComplete(revision, reading))) this.facts.scope_pending = true;
        this.normalization = null; return;
      }
      let owner = this.normalization;
      if (!owner || owner.revision !== revision || owner.reading !== reading || owner.interval.interval_key !== interval.interval_key) {
        this.normalization = null;
        await this.local(() => this.persistence.scopeNormalizationReset(revision, reading, interval.interval_key));
        owner = {revision,reading,interval,normalizer:new ScopeTextNormalizer(),after:null,nextRaw:interval.start_offset};
        this.normalization = owner;
      }
      const chunk = await this.local(() => this.persistence.scopeNormalizationRead(revision, reading, interval.interval_key, owner!.after));
      const gap = chunk !== null && chunk.start_offset !== owner.nextRaw;
      const nextRaw = owner.nextRaw + (chunk === null ? 0 : Array.from(chunk.text).length);
      if (gap || nextRaw > interval.end_offset || chunk === null && nextRaw !== interval.end_offset) {
        const current = await this.local(() => this.persistence.scopeNormalizationObservation(revision, reading, interval.interval_key, owner!.after));
        const recovered = current.chunk === null ? owner.nextRaw === interval.end_offset
          : current.chunk.start_offset === owner.nextRaw && owner.nextRaw + Array.from(current.chunk.text).length <= interval.end_offset;
        if (current.progress.staging_revision !== revision || current.progress.reading_ref !== reading || !current.progress.raw_complete
          || current.interval === null || current.interval.interval_key !== interval.interval_key || current.interval.start_offset !== interval.start_offset || current.interval.end_offset !== interval.end_offset || recovered) {
          this.normalization = null; this.facts.scope_pending = true; return;
        }
        this.normalization = null;
        throw new Error(gap ? "scope text contains a gap or overlap" : "scope text disagrees with its complete interval");
      }
      // Reuse this cursor only after every normalized chunk has committed.
      this.normalization = null;
      if (chunk !== null) {
        owner.nextRaw = nextRaw;
        owner.after = chunk.start_offset;
      }
      const complete = owner.nextRaw === interval.end_offset;
      const output = owner.normalizer.push(chunk?.text ?? "", complete);
      const chunks: NormalizedScopeChunk[] = [];
      let text = "", start = output.start_offset, count = 0;
      const flush = () => { if (!text) return; chunks.push({start_offset:start,normalized_text:text,edits:output.edits.filter(([at]) => at > start && at <= start + count)}); start += count; text = ""; count = 0; };
      for (const char of output.normalized_text) { text += char; if (++count === 16_384) flush(); }
      flush();
      if (!chunks.length && !await this.local(() => this.persistence.scopeNormalized(revision, reading, interval.interval_key, [], complete ? start : null))) {
        this.normalization = null; this.facts.scope_pending = true; return;
      }
      for (let at = 0; at < chunks.length; at++) {
        const accepted = await this.local(() => this.persistence.scopeNormalized(revision, reading, interval.interval_key, [chunks[at]!], complete && at === chunks.length - 1 ? start : null));
        if (!accepted) { this.normalization = null; this.facts.scope_pending = true; return; }
      }
      this.normalization = complete ? null : owner;
    } else {
      const expectedStoreRevision = (await this.local(() => this.persistence.replica())).store_revision;
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"finish",revision}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.restart || data.revision !== revision) { await this.local(() => this.persistence.scopeReset(data.revision)); return; }
      if (!await this.local(() => this.persistence.scopePublish(revision, expectedStoreRevision))) { this.normalization = null; this.facts.scope_pending = true; return; }
      this.facts.scope_pending = false;
      this.facts.scope_progress = null;
      this.changed(true);
    }
  }
  private async provision() {
    // The live tables are staging while readiness is false. A failed snapshot is
    // discarded in its entirety on the next attempt; no editor can observe it.
    await this.local(() => this.persistence.resetProvisioning());
    const reader = (await this.transport.snapshot(this.abort.signal)).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let header: { head_cursor: string; format_revision: number; lamport: string } | null = null;
    let complete = false;
    const counts = { resources: 0, links: 0, passages: 0, source_stubs: 0 };
    let staged: MergeResult = { resources: [], links: [], passages: [], source_stubs: [], projections: [] };
    let stagedCount = 0;
    const flush = async () => {
      if (!stagedCount) return;
      const batch = staged;
      staged = { resources: [], links: [], passages: [], source_stubs: [], projections: [] }; stagedCount = 0;
      await this.local(() => this.persistence.stage(mergeChanges(batch, [])));
    };
    try {
      for (;;) {
        this.abort.signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 128 * 1024 * 1024) throw new Error("authored snapshot state exceeds device capacity");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const record = JSON.parse(line);
          if (complete) throw new Error("authored snapshot data after footer");
          if (record.type === "header") {
            if (header || record.format_revision !== FORMAT_REVISION) throw Object.assign(new Error("authored snapshot format mismatch"), { status: 426 });
            header = record;
          } else if (!header) throw new Error("authored snapshot header missing");
          else if (record.type === "footer") {
            if (record.head_cursor !== header.head_cursor || record.lamport !== header.lamport || record.format_revision !== FORMAT_REVISION || Object.keys(counts).some(key => record.counts[key] !== counts[key as keyof typeof counts])) throw new Error("authored snapshot completion mismatch");
            complete = true;
          } else {
            // Snapshot resources hold full CRDT state, so build projections by
            // merging that state with no new command and no semantic touch.
            const corpus = staged;
            switch (record.type) {
              case "resource": corpus.resources.push(record.state); counts.resources++; break;
              case "link": corpus.links.push(record.state); counts.links++; break;
              case "passage": corpus.passages.push(record.state); counts.passages++; break;
              case "source_stub": corpus.source_stubs.push(record.state); counts.source_stubs++; break;
              default: throw new Error("unknown authored snapshot record");
            }
            stagedCount++;
            if (stagedCount >= 100) await flush();
          }
        }
      }
      await flush();
      if (buffered.trim() || !complete || !header) throw Object.assign(new Error("incomplete authored snapshot"), { status: 0 });
      if (this.retired) return;
      const cursor = header.head_cursor;
      await this.local(() => this.persistence.finishProvisioning(cursor, counts, header!.lamport));
      this.facts.ready = true; this.facts.cursor = cursor; this.last_error = null;
      this.changed(true);
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
function max(a: string | null, b: string) { return a !== null && BigInt(a) > BigInt(b) ? a : b; }
