/** Foreground replication. Upload and download fail independently. Every retry
 * sends the same durable source bytes; only verified acceptance removes pending.
 * Scope hydration advances bounded pages beside writing replication. Its durable
 * staging and final fence never expand authored snapshot time or local readiness. */
import { mergeChanges } from "@nexus/authored/merge";
import { FORMAT_REVISION, type FeedChange, type MergeResult } from "@nexus/authored/types";
import { Persistence } from "./persistence";
import { SIGN_IN_SYNC_DETAIL, UPDATE_SYNC_DETAIL, type SyncFacts } from "./status";
import { ScopeTextNormalizer, type ScopeInputsPage, type ScopeTextPage, type ScopeNormalizationInterval, type NormalizedScopeChunk } from "@nexus/authored/scope";

export interface Transport {
  json<T>(path: string, body: unknown | null, signal: AbortSignal): Promise<T>;
  snapshot(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
export class Sync {
  private readonly abort = new AbortController();
  private completion: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  private retired = false;
  private foreground = true;
  private failures = 0;
  private commitError = false;
  private annotationsRevision: string | null = null;
  private scopeCheckedAt = 0;
  private normalization: {revision: string; reading: string; interval: ScopeNormalizationInterval; normalizer: ScopeTextNormalizer; after: number | null; nextRaw: number} | null = null;
  last_error: string | null = null;
  readonly facts: SyncFacts = { local_error: false, saving: false, ready: false, admission: "ready", sync_error: false, online: true, pending: false, scope_pending: true, cursor: "0", head: null };
  constructor(readonly persistence: Pick<Persistence, "replica" | "pending" | "acknowledge" | "applyRemote" | "resetProvisioning" | "stage" | "finishProvisioning" | "scopeProgress" | "scopeRefs" | "scopeRepairRefs" | "scopeReset" | "scopeRevoke" | "scopeMetadata" | "scopeText" | "scopeNormalizationNext" | "scopeNormalizationRead" | "scopeNormalizationObservation" | "scopeNormalizationReset" | "scopeNormalized" | "scopeTextComplete" | "scopePublish">, readonly transport: Transport, readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>, readonly changed: (corpusChanged?: boolean) => void, readonly annotationsChanged: () => void) {}
  wake() {
    if (this.retired || !this.foreground) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { this.rerun = true; return; }
    this.completion = this.run();
  }
  localFailure(failed: boolean) { this.commitError = failed; this.facts.local_error = failed; }
  setForeground(active: boolean) { this.foreground = active; if (!active && this.timer !== null) { clearTimeout(this.timer); this.timer = null; } if (active) this.wake(); }
  stopped(): Promise<void> { return this.completion; }
  private local<T>(operation: () => Promise<T>): Promise<T> { return this.serialize(() => { if (this.retired) throw new DOMException("authored synchronization stopped", "AbortError"); return operation(); }); }
  close() { this.retired = true; this.abort.abort(); if (this.timer !== null) clearTimeout(this.timer); }
  private async run() {
    this.running = true;
    this.rerun = false;
    let failed = false;
    try {
      const state = await this.local(() => this.persistence.replica());
      this.facts.ready = state.provisioning_complete;
      this.facts.cursor = state.server_cursor;
      if (!state.provisioning_complete) await this.provision();
      const registration = await this.transport.json<{ data: { accepted_command_seq: string; head_cursor: string } }>("/api/authored/replicas", { replica_id: state.replica_id, format_revision: FORMAT_REVISION }, this.abort.signal);
      if (this.retired) return;
      this.facts.head = registration.data.head_cursor;
      await this.local(() => this.persistence.acknowledge(registration.data.accepted_command_seq));
      const outcomes = await Promise.allSettled([this.upload(), this.download(), this.scopeStep().catch(error => { this.normalization = null; throw error; })]);
      for (const outcome of outcomes) if (outcome.status === "rejected") { failed = true; this.failure(outcome.reason); }
      if (!failed) { this.facts.local_error = this.commitError; this.last_error = null; this.facts.sync_error = false; this.facts.admission = "ready"; this.facts.online = true; this.failures = 0; }
    } catch (error) { failed = true; if (!this.retired) this.failure(error); }
    finally {
      this.running = false;
      this.changed();
      if (!this.retired && this.foreground) {
        if (this.rerun) this.wake();
        else if (this.facts.admission === "ready") {
          const delay = failed ? Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)) * (0.75 + Math.random() * 0.25) : this.facts.scope_pending ? 0 : 30_000;
          this.timer = setTimeout(() => { this.timer = null; this.wake(); }, delay);
        }
      }
    }
  }
  private failure(error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "E_AUTHORED_LOCAL") { this.facts.local_error = true; this.last_error = "couldn’t prepare your notes on this device. check available storage and retry."; return; }
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : null;
    this.last_error = status === 401 || status === 403 ? SIGN_IN_SYNC_DETAIL
      : status === 426 ? UPDATE_SYNC_DETAIL
      : status === 0 ? this.facts.ready ? "changes are saved on this device." : "connect to finish preparing your notes."
      : "your notes could not finish syncing. retry; saved changes remain on this device.";
    if (status === 401 || status === 403) this.facts.admission = "auth";
    else if (status === 426) this.facts.admission = "format";
    else if (status === 0) this.facts.online = false;
    else this.facts.sync_error = true;
  }
  private async upload() {
    while (!this.retired && this.foreground) {
      const { changes, replica } = await this.local(async () => ({ changes: await this.persistence.pending(), replica: await this.persistence.replica() }));
      this.facts.pending = changes.length > 0;
      this.changed();
      if (!changes.length) return;
      const { data } = await this.transport.json<{ data: { accepted_command_seq: string; head_cursor: string } }>("/api/authored/changes", { replica_id: replica.replica_id, changes }, this.abort.signal);
      if (this.retired) return;
      if (BigInt(data.accepted_command_seq) < BigInt(changes.at(-1)!.command_seq)) throw Object.assign(new Error("incomplete authored acknowledgement"), { status: 500 });
      this.facts.head = max(this.facts.head, data.head_cursor);
      await this.local(() => this.persistence.acknowledge(data.accepted_command_seq));
    }
  }
  private async download() {
    while (!this.retired && this.foreground) {
      const replica = await this.local(() => this.persistence.replica());
      const { data } = await this.transport.json<{ data: { changes: FeedChange[]; next_cursor: string; head_cursor: string; annotations_revision: string } }>(`/api/authored/changes?after=${replica.server_cursor}`, null, this.abort.signal);
      if (this.retired) return;
      this.facts.head = max(this.facts.head, data.head_cursor);
      // This opaque remote-evidence token has no relation to the applied cursor.
      if (typeof data.annotations_revision !== "string") throw new Error("authored feed omitted its annotations revision");
      if (data.annotations_revision !== this.annotationsRevision) {
        this.annotationsRevision = data.annotations_revision;
        this.annotationsChanged();
      }
      await this.local(async () => {
        const current = await this.persistence.applyRemote(data.changes, data.next_cursor);
        this.facts.cursor = current.server_cursor;
        this.changed(data.changes.some(change => BigInt(change.server_seq) > BigInt(replica.server_cursor)));
      });
      if (BigInt(this.facts.cursor) >= BigInt(data.head_cursor)) return;
      if (!data.changes.length) throw new Error("authored feed did not advance");
    }
  }
  /** Bulk reading inputs never extend the authored snapshot or delay its local
   * admission. One hydration/normalization page shares each upload/pull turn. */
  private async scopeStep() {
    let progress = await this.local(() => this.persistence.scopeProgress());
    const revoke = async (refs: string[]) => {
      if (!refs.length) return;
      if (!await this.local(() => this.persistence.scopeRevoke(refs))) return;
      this.normalization = null;
      this.changed(true);
    };
    if (Date.now() - this.scopeCheckedAt >= 30_000) {
      let after: string | null = null;
      let revision = progress.staging_revision ?? progress.active_revision;
      let repair = false;
      do {
        const refs = await this.local(() => this.persistence.scopeRefs(after));
        const repairRefs = await this.local(() => this.persistence.scopeRepairRefs(refs));
        const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"status",revision,active_refs:refs}, this.abort.signal);
        repair ||= repairRefs.some(ref => !data.revoked_refs.includes(ref));
        await revoke(data.revoked_refs);
        revision = data.revision;
        after = refs.length === 100 ? refs.at(-1)! : null;
      } while (after !== null && !this.retired && this.foreground);
      if (this.retired || !this.foreground) return;
      await this.local(() => this.persistence.scopeReset(revision!, repair));
      this.scopeCheckedAt = Date.now();
      progress = await this.local(() => this.persistence.scopeProgress());
    }
    this.facts.scope_pending = progress.active_revision === null || progress.staging_revision !== null;
    if (progress.staging_revision === null || this.retired || !this.foreground) return;
    const revision = progress.staging_revision;
    if (!progress.metadata_complete) {
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"metadata",revision,cursor:progress.metadata_cursor}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.restart || data.revision !== revision) { this.normalization = null; await this.local(() => this.persistence.scopeReset(data.revision)); return; }
      if (!await this.local(() => this.persistence.scopeMetadata(data, progress.metadata_cursor))) { this.normalization = null; this.facts.scope_pending = true; return; }
    } else if (progress.reading_ref !== null && !progress.raw_complete) {
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
        throw new Error(gap ? "scope text contains a gap or overlap" : "scope text disagrees with its complete interval");
      }
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
      if (complete) this.normalization = null;
    } else {
      const expectedStoreRevision = (await this.local(() => this.persistence.replica())).store_revision;
      const {data} = await this.transport.json<{data: ScopeInputsPage}>("/api/authored/scope-inputs", {kind:"finish",revision}, this.abort.signal);
      await revoke(data.revoked_refs);
      if (data.restart || data.revision !== revision) { await this.local(() => this.persistence.scopeReset(data.revision)); return; }
      if (!await this.local(() => this.persistence.scopePublish(revision, expectedStoreRevision))) { this.normalization = null; this.facts.scope_pending = true; return; }
      this.facts.scope_pending = false;
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
      if (buffered.trim() || !complete || !header) throw new Error("incomplete authored snapshot");
      if (this.retired) return;
      const cursor = header.head_cursor;
      await this.local(() => this.persistence.finishProvisioning(cursor, counts, header!.lamport));
      this.facts.ready = true; this.facts.cursor = cursor;
      this.changed(true);
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
function max(a: string | null, b: string) { return a !== null && BigInt(a) > BigInt(b) ? a : b; }
