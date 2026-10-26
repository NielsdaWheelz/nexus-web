/** Account-scoped live documents and command preparation. A shared store lease
 * covers sequence allocation through durable commit, including uncertain replies
 * and local failure/retry. A receipt is published only after its committed state
 * reaches open documents, so following edits can refer to its shared identities.
 * Unsynchronized committed work needs no loss warning. */
import * as Y from "yjs";
import { prepareChange, type Intent } from "@nexus/authored/commands";
import { decodeBytes, encodeBytes, hydrateNote, createTitle, readBody } from "@nexus/authored/documents";
import { noteBodySchema, projectBody, type NoteBody } from "@nexus/authored/body";
import { mergeChanges, mergeVector } from "@nexus/authored/merge";
import type { AuthoredStore, Change, CommitFrame, ResourceState, StateSelection, Vector } from "@nexus/authored/types";
import { openAuthoredStore } from "@/lib/authored/client";
export interface WritingSnapshot { body_state: string; observed_touch: Vector }
export interface WritingDocument { ref: string; doc: Y.Doc; retain(): () => void; capture(): Promise<WritingSnapshot>; onCommitted(listener: (receipt: LocalCommit, origin: unknown) => void): () => void }
export class LocalCommitError extends Error {
  constructor(message: string, readonly cause: unknown, readonly retry: () => Promise<LocalCommit>, readonly completion: Promise<LocalCommit>) { super(message); this.name = "LocalCommitError"; }
}
export function writingStoreStopped(error:unknown):boolean {
  if(error instanceof LocalCommitError)return writingStoreStopped(error.cause);
  return error instanceof Error && "code" in error && error.code === "E_AUTHORED_WORKER_STOPPED";
}
export interface LocalCommit { command_seq: string; store_revision: string; change: Change }
interface CachedDocument extends WritingDocument { pins: number; bytes: number; last_used: number; pending: number; receive(resource: ResourceState): void; unsubscribe: () => void }
interface SaveState { saving: boolean; error: unknown | null; error_refs: string[]; revision: number }
interface FailedCommit {
  intent: Intent; selection: StateSelection; change: Change | null; frame: CommitFrame | null;
  store: AuthoredStore | null; held: boolean; attempting: boolean;
  settled: Promise<LocalCommit>; resolve(receipt: LocalCommit): void; reject(error: Error): void;
  result: Promise<LocalCommit>; refuse(error: unknown): void; retry_failure: ((error: unknown) => void) | null;
}
const REMOTE = Symbol("incoming authored state");
const runtimes = new Map<string, WritingRuntime>();
export function hasUncommittedWriting(): boolean { return [...runtimes.values()].some(runtime => runtime.snapshot().saving || runtime.snapshot().error !== null); }
export async function closeWritingRuntime(accountId: string): Promise<void> { await runtimes.get(accountId)?.close(); }
export async function discardWritingRuntime(accountId: string): Promise<void> { await runtimes.get(accountId)?.discard(); }
export function getWritingRuntime(accountId: string): WritingRuntime {
  let runtime = runtimes.get(accountId);
  if (!runtime) { runtime = new WritingRuntime(accountId); runtimes.set(accountId, runtime); }
  return runtime;
}
export function selectStates(selection: Partial<StateSelection>): StateSelection {
  return { refs: selection.refs ?? [], link_ids: selection.link_ids ?? [], anchor_ids: selection.anchor_ids ?? [], source_refs: selection.source_refs ?? [] };
}
export class WritingRuntime {
  private opened_store: Promise<AuthoredStore> | null = null;
  get store(): Promise<AuthoredStore> {
    if (!this.opened_store) {
      const pending = openAuthoredStore(this.accountId);
      this.opened_store = pending;
      void pending.catch(() => { if (this.opened_store === pending) this.opened_store = null; });
    }
    return this.opened_store;
  }
  private readonly documents = new Map<string, {promise:Promise<CachedDocument>;value:CachedDocument|null}>();
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private failed: FailedCommit | null = null;
  private retrying: Promise<void> | null = null;
  private retired = false;
  private state: SaveState = { saving: false, error: null, error_refs: [], revision: 0 };
  private pending = 0;
  private readonly pending_commands = new Set<Promise<LocalCommit>>();
  constructor(private readonly accountId: string) {}
  snapshot = (): SaveState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<SaveState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  async committedPrefix(): Promise<string> {
    const admitted = this.tail;
    const required = [...this.pending_commands];
    await Promise.all(required);
    await admitted;
    if (this.retired) throw new Error("Writing account is closed");
    return (await (await this.store).readReplica()).command_seq;
  }
  whenUploaded(commandSeq: string, signal: AbortSignal): Promise<void> { return this.store.then(store => store.whenUploaded(commandSeq, signal)); }
  run(intent: Intent, selection: Partial<StateSelection> = {}): Promise<LocalCommit> {
    if (this.retired) return Promise.reject(new Error("Writing account is closed"));
    const frozen = structuredClone(intent);
    const inferred = intentSelection(frozen);
    const selected = selectStates(selection);
    for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) inferred[key] = [...new Set([...inferred[key], ...selected[key]])];
    this.pending++;
    this.publish({ saving: true });
    let accept: (receipt: LocalCommit) => void = () => {};
    let refuse: (error: unknown) => void = () => {};
    const result = new Promise<LocalCommit>((resolve, reject) => { accept = resolve; refuse = reject; });
    this.pending_commands.add(result);
    const operation = this.tail.then(async () => {
      if (this.retired) throw new Error("Writing account is closed");
      let resolve: (receipt: LocalCommit) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const settled = new Promise<LocalCommit>((done, failed) => { resolve = done; reject = failed; });
      void settled.catch(() => {});
      const owner: FailedCommit = { intent: frozen, selection: inferred, change: null, frame: null, store: null, held: false, attempting: false, settled, resolve, reject, result, refuse, retry_failure: null };
      this.failed = owner;
      let receipt: LocalCommit;
      try { receipt = await this.attempt(owner); }
      catch (error) { this.reportFailure(owner, error); receipt = await settled; }
      if (this.failed === owner) this.failed = null;
      this.publish({ error: null, error_refs: [] });
      return receipt;
    });
    this.tail = operation.then(accept, error => { if (!this.retired) this.publish({ error, error_refs: inferred.refs }); refuse(error); }).finally(() => {
      this.pending_commands.delete(result);
      this.pending--; this.publish({ saving: this.pending > 0 });
    });
    return result;
  }
  private reportFailure(owner: FailedCommit, error: unknown): void {
    if (this.retired) return;
    this.publish({ error, error_refs: owner.selection.refs });
    const failure = new LocalCommitError("couldn’t save on this device", error, async () => { await this.retry(); return owner.settled; }, owner.settled);
    owner.refuse(failure);
    owner.retry_failure?.(failure);
  }
  private async attempt(owner: FailedCommit): Promise<LocalCommit> {
    owner.attempting = true;
    try {
      const store = await this.store;
      owner.store = store;
      return await store.withCommand(async () => {
        owner.held = true;
        try { return await this.prepareAndPersist(owner, store); }
        catch (error) {
          owner.attempting = false;
          this.reportFailure(owner, error);
          // Retain the account lease until these exact bytes settle or the
          // account is deliberately discarded. Other tabs cannot reuse its seq.
          return await owner.settled;
        } finally { owner.held = false; }
      });
    } finally { owner.attempting = false; }
  }
  private async prepareAndPersist(owner: FailedCommit, store: AuthoredStore): Promise<LocalCommit> {
    if (this.retired) throw new Error("Writing account is closed");
    if (owner.frame === null) {
      const { replica, states } = await store.readSnapshot(owner.selection);
      if (this.retired) throw new Error("Writing account is closed");
      if (owner.change === null) owner.change = prepareChange({ replica_id: replica.replica_id, command_seq: (BigInt(replica.command_seq) + 1n).toString(), lamport: (BigInt(replica.lamport) + 1n).toString() }, owner.intent, states);
      owner.frame = { expected_store_revision: replica.store_revision, replica_id: replica.replica_id, change: owner.change, states: mergeChanges(states, [owner.change]) };
    }
    const receipt = await this.persist(owner.frame, store);
    // Subscriptions may arrive after the receipt. Install the complete committed
    // baseline before a later edit can reference identities introduced by it.
    for (const resource of owner.frame.states.resources) {
      const entry = this.documents.get(resource.ref);
      if (!entry || this.retired) continue;
      if (entry.value) entry.value.receive(resource);
      else void entry.promise.then(document => {
        if (!this.retired && this.documents.get(resource.ref) === entry) document.receive(resource);
      }, () => {
        // Document loading owns this failure. The command is already committed.
      });
    }
    return receipt;
  }
  private async persist(frame: CommitFrame, store: AuthoredStore): Promise<LocalCommit> {
    for (;;) {
      let result;
      try { result = await store.commit(frame); }
      catch (error) {
        const replica = await store.readReplica();
        if (BigInt(replica.command_seq) >= BigInt(frame.change.command_seq)) return { command_seq: frame.change.command_seq, store_revision: replica.store_revision, change: frame.change };
        throw error;
      }
      if (result.kind === "committed") return { command_seq: result.command_seq, store_revision: result.store_revision, change: frame.change };
      frame.expected_store_revision = result.store_revision;
      frame.states = mergeChanges(result.states, [frame.change]);
    }
  }
  retry(): Promise<void> {
    if(this.retrying)return this.retrying;
    const attempt=this.retryFailed().finally(()=>{if(this.retrying===attempt)this.retrying=null;});
    this.retrying=attempt;
    return attempt;
  }
  private async retryFailed(): Promise<void> {
    if (this.retired) throw new Error("Writing account is closed");
    const owner = this.failed;
    if (!owner) return;
    if (owner.attempting) { await owner.result; return; }
    if (owner.held && owner.store) {
      owner.attempting = true;
      try { const receipt = await this.prepareAndPersist(owner, owner.store); owner.resolve(receipt); }
      catch (error) { this.reportFailure(owner, error); throw error; }
      finally { owner.attempting = false; }
      return;
    }
    let refuse: (error: unknown) => void = () => {};
    const failedAttempt = new Promise<never>((_resolve, reject) => { refuse = reject; });
    owner.retry_failure = refuse;
    const recovery = this.attempt(owner).then(receipt => { owner.resolve(receipt); }, error => { this.reportFailure(owner, error); throw error; });
    try { await Promise.race([recovery, failedAttempt]); }
    finally { owner.retry_failure = null; }
  }
  /** The words held only in memory while a save is uncommitted: the open documents a
   * failed command touched and the current command's own created body or title, as
   * canonical text for copying. It keeps no history and recovers nothing. */
  async uncommittedText(): Promise<string> {
    const texts = new Map<string, string>();
    const text = (body: NoteBody) => projectBody(noteBodySchema.nodeFromJSON(body.body_pm_json)).text;
    const creation = (intent: Intent): void => {
      if (intent.kind === "batch") intent.intents.forEach(creation);
      else if (intent.kind === "create_note") texts.set(intent.ref, text(intent.body));
      else if (intent.kind === "create_page") texts.set(intent.ref, intent.title);
    };
    if (this.failed) creation(this.failed.intent);
    for (const ref of this.state.error_refs) {
      const pending = this.documents.get(ref);
      if (!pending) continue;
      const { doc } = await pending.promise;
      texts.set(ref, doc.share.has("title") ? doc.getText("title").toString() : text(readBody(doc)));
    }
    return [...texts.values()].filter(text => text.trim() !== "").join("\n\n");
  }
  async openDocument(ref: string, prelude: readonly Intent[] = []): Promise<WritingDocument> {
    if (this.retired) throw new Error("Writing account is closed");
    let entry = this.documents.get(ref);
    if (!entry) {
      entry={promise:this.loadDocument(ref,prelude),value:null};
      this.documents.set(ref,entry);
      const owner=entry;
      void owner.promise.then(value=>{owner.value=value;},()=>{if(this.documents.get(ref)===owner)this.documents.delete(ref);});
    }
    return entry.promise;
  }
  openBody(ref:string):NoteBody|null {
    const document=this.documents.get(ref)?.value;
    return document?readBody(document.doc):null;
  }
  private async loadDocument(ref: string, prelude: readonly Intent[]): Promise<CachedDocument> {
    const store = await this.store;
    const selection = selectStates({ refs: [ref] });
    const states = await store.readStates(selection);
    const existing = states.resources.find(r => r.ref === ref);
    const creation = prelude.find((intent): intent is Extract<Intent,{kind:"create_page"}> => intent.kind === "create_page" && intent.ref === ref);
    const resource = existing ?? (creation ? {kind:"page" as const,ref,touch_vv:{},delete_vv:{},local_date:creation.local_date,title_state:createTitle("")} : null);
    if (!resource || resource.kind === "highlight") throw new Error("Writing document is unavailable");
    let initial_prelude: readonly Intent[] = prelude;
    const doc = resource.kind === "note" ? hydrateNote(resource.body_state) : new Y.Doc();
    if (resource.kind === "page") Y.applyUpdate(doc, decodeBytes(resource.title_state), REMOTE);
    let observed_touch = resource.touch_vv;
    const pending_edits = new Set<Promise<LocalCommit>>();
    const committed = new Set<(receipt: LocalCommit, origin: unknown) => void>();
    const cached: CachedDocument = {
      ref, doc, pins: 0, pending: 0, bytes: Y.encodeStateAsUpdate(doc).byteLength, last_used: Date.now(), unsubscribe: () => {},
      receive: latest => {
        if (this.retired || latest.kind === "highlight") return;
        if (Object.entries(latest.touch_vv).some(([replica,sequence])=>BigInt(sequence)>BigInt(latest.delete_vv[replica]??"0"))) initial_prelude=[];
        observed_touch = mergeVector(observed_touch, latest.touch_vv);
        Y.applyUpdate(doc, decodeBytes(latest.kind === "note" ? latest.body_state : latest.title_state), REMOTE);
        cached.bytes = Y.encodeStateAsUpdate(doc).byteLength;
        void this.evict();
      },
      onCommitted: listener => { committed.add(listener); return () => committed.delete(listener); },
      capture: () => {
        const body_state = encodeBytes(Y.encodeStateAsUpdate(doc));
        const observed = { ...observed_touch };
        const pending = [...pending_edits];
        return Promise.all(pending).then(receipts => {
          for (const receipt of receipts) {
            const patch = receipt.change.resources.find(patch => patch.ref === ref);
            for (const [replica, sequence] of Object.entries(patch?.touch_vv ?? {})) if (BigInt(sequence) > BigInt(observed[replica] ?? "0")) observed[replica] = sequence;
          }
          return { body_state, observed_touch: observed };
        });
      },
      retain: () => { cached.pins++; return () => { cached.pins--; cached.last_used = Date.now(); void this.evict(); }; },
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.retired) return;
      const intent: Intent = resource.kind === "note" ? { kind: "edit_body", ref, body_update: encodeBytes(update) } : { kind: "edit_title", ref, title_update: encodeBytes(update) };
      const prepared: Intent = initial_prelude.length ? {kind:"batch",intents:[...initial_prelude,intent]} : intent;
      initial_prelude = [];
      const pending = this.run(prepared, { refs: [ref] }).catch(error => {
        if (error instanceof LocalCommitError && this.failed) return this.failed.settled;
        throw error;
      });
      pending_edits.add(pending); cached.pending++;
      const settled=()=>{pending_edits.delete(pending);cached.pending--;void this.evict();};
      void pending.then(receipt => { for (const listener of committed) listener(receipt, origin); settled(); },settled);
    });
    cached.unsubscribe = store.subscribe({ kind: "resource", ref }, () => {
      void store.readStates(selection).then(current => {
        if (this.retired) return;
        const latest = current.resources.find(r => r.ref === ref);
        if (!latest || latest.kind === "highlight") return;
        cached.receive(latest);
      }).catch(error => this.publish({ error, error_refs: [ref] }));
    });
    return cached;
  }
  private async evict(): Promise<void> {
    const opened = await Promise.allSettled([...this.documents.values()].map(entry=>entry.promise));
    const entries=opened.flatMap(entry=>entry.status==="fulfilled"?[entry.value]:[]);
    const unmounted = entries.filter(d => d.pins === 0).sort((a, b) => a.last_used - b.last_used);
    let count = unmounted.length;
    let bytes = unmounted.reduce((n, d) => n + d.bytes, 0);
    for (const entry of unmounted) {
      if (count <= 64 && bytes <= 16 * 1024 * 1024) break;
      if (entry.pending>0) continue;
      entry.unsubscribe(); entry.doc.destroy(); this.documents.delete(entry.ref);
      count--; bytes -= entry.bytes;
    }
  }
  async discard(): Promise<void> {
    this.retired = true;
    if (runtimes.get(this.accountId) === this) runtimes.delete(this.accountId);
    this.failed?.reject(new Error("Writing deliberately discarded"));
    this.failed = null;
    await this.finishClose();
  }
  async close(): Promise<void> {
    if (this.pending > 0 || this.failed || this.state.error !== null) throw new Error("Uncommitted writing must be saved or deliberately discarded");
    this.retired = true;
    if (runtimes.get(this.accountId) === this) runtimes.delete(this.accountId);
    await this.finishClose();
  }
  private async finishClose(): Promise<void> {
    await this.tail;
    const opened=await Promise.allSettled([...this.documents.values()].map(entry=>entry.promise));
    for (const entry of opened) if(entry.status==="fulfilled"){entry.value.unsubscribe();entry.value.doc.destroy();}
    this.documents.clear();
    if (this.opened_store) await (await this.opened_store).close();
    if (runtimes.get(this.accountId) === this) runtimes.delete(this.accountId);
  }
}

function intentSelection(intent: Intent): StateSelection {
  const selection = selectStates({});
  function visit(intent: Intent): void {
    if (intent.kind === "batch") { intent.intents.forEach(visit); return; }
    if ("ref" in intent) selection.refs.push(intent.ref);
    if ("link_id" in intent) selection.link_ids.push(intent.link_id);
    if (intent.kind === "add_link") selection.refs.push(intent.endpoint_a, intent.endpoint_b);
    if (intent.kind === "capture_passage") selection.anchor_ids.push(intent.anchor_id);
    if (intent.kind === "capture_source") selection.source_refs.push(intent.source_ref);
  }
  visit(intent);
  return selection;
}
