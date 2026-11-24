/** Account-scoped canonical documents and authored command admission. One tail
 * slot and store lease own each immutable change through durable commit and
 * uncertain replies. Compound admission pins declared live documents, seals
 * synchronous Yjs updates and new initializers, then prepares graph intents at
 * the head; retries never repeat Yjs mutation. A receipt reaches those same
 * documents before their committed listeners run. Unsynchronized committed
 * work needs no loss warning. */
import * as Y from "yjs";
import { prepareChange, createNoteIntent, foldPageCredit, type Intent, type CommandContext } from "@nexus/authored/commands";
import { decodeBytes, encodeBytes, hydrateNote, createTitle, noteEncodingBound, readBody } from "@nexus/authored/documents";
import { emptyBody, noteBodySchema, rawBodyText, type NoteBody } from "@nexus/authored/body";
import { advanceCoverage, mergeChanges, mergeVector } from "@nexus/authored/merge";
import { MAX_COMMAND_BYTES, MAX_PAGE_WORK_AT_MS, CommandTooLargeError, WorkConversionError, WorkJoinError, WorkUnavailableError, type AuthoredStore, type Change, type CommitFrame, type Corpus, type HighlightPatch, type PageCredit, type PagePatch, type MergeResult, type ResourceState, type StateSelection, type Vector, type NoteWork } from "@nexus/authored/types";
import { openAuthoredStore } from "@/lib/authored/client";
import { linkId, sortedEndpoints } from "@nexus/authored/identity";
/** A shared document receives the originating occurrence on each local Yjs transaction. */
export class PageWritingOrigin {
  constructor(readonly pageRef: string | null) {}
  credit(at_ms = Date.now()): PageCredit {
    return this.pageRef === null ? null : {ref: this.pageRef, at_ms};
  }
}
export interface WritingSnapshot { body_state: string; observed_touch: Vector }
export interface WritingDocument {
  ref: string; doc: Y.Doc; retain(): () => void; capture(): Promise<WritingSnapshot>;
  /** Wait for currently pending edits without freezing a causal snapshot. */
  editsSettled(): Promise<void>;
  readonly prelude: readonly Intent[];
  checkTextSize(bytes: number, credit: PageCredit, creating: boolean): void;
  checkFirstNoteSize(body: NoteBody, credit: PageCredit): void;
  onCommitted(listener: (receipt: LocalCommit, origin: unknown) => void): () => void;
  hasPendingEdits(): boolean;
  subscribePendingEdits(listener: () => void): () => void;
}
export class LocalCommitError extends Error {
  constructor(message: string, readonly cause: unknown, readonly retry: () => Promise<LocalCommit>, readonly completion: Promise<LocalCommit>) { super(message); this.name = "LocalCommitError"; }
}
export function isAuthoredStorageFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "E_AUTHORED_LOCAL" || error.code === "E_AUTHORED_WORKER_STOPPED");
}
export function writingStoreStopped(error:unknown):boolean {
  if(error instanceof LocalCommitError)return writingStoreStopped(error.cause);
  return error instanceof Error && "code" in error && error.code === "E_AUTHORED_WORKER_STOPPED";
}
export interface LocalCommit {
  command_seq: string; store_revision: string; change: Change;
  before: { resources: { ref: string; touch_vv: Vector; delete_vv: Vector; work: NoteWork | null }[]; links: { link_id: string; add_vv: Vector; remove_vv: Vector }[] };
}
export interface LocalGraphCommit extends LocalCommit {states: MergeResult}
export type GraphIntent = Exclude<Intent, {kind: "batch" | "create_note" | "create_page" | "create_highlight" | "edit_body" | "edit_title"}>;
interface WritingMutation {
  existing: readonly {document: WritingDocument; origin: unknown; state_vector?: Uint8Array}[];
  notes: readonly ({body: NoteBody; origin: unknown} | {initializer: Extract<Intent, {kind: "create_note"}>; origin: unknown})[];
  mutate(created: readonly WritingDocument[]): void;
  prepare(created_refs: readonly string[]): Promise<readonly Intent[]>;
}
interface WritingAdmission {created: readonly WritingDocument[]; result: Promise<LocalCommit>}
type CheckedBaseline = Awaited<ReturnType<AuthoredStore["readSnapshot"]>> & {selection: StateSelection};
/** Only the transaction's own inserts and deletes belong to its command. */
export function transactionUpdate(updates: Uint8Array[]): Uint8Array {
  return updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
}
type HighlightRegisters = Pick<HighlightPatch, "selection" | "color">;
interface CachedDocument extends WritingDocument { highlightRegisters(): HighlightRegisters | null; text_pending: Set<Promise<LocalCommit>>; read_attempt: number; read_subscription: number; pins: number; bytes: number; last_used: number; pending: number; prelude: readonly Intent[]; receive(resource: ResourceState): void; track(result: Promise<LocalCommit>, origin: unknown): void; unsubscribe: () => void }
interface SaveState { saving: boolean; error: unknown | null; error_occurrence: object | null; error_refs: string[]; revision: number }
interface FailedCommit {
  occurrence: object;
  readonly credit: PageCredit;
  highlight_registers: Map<string, HighlightRegisters>;
  reject_oversize: boolean;
  intent: Intent | null; selection: StateSelection; change: Change | null;
  baseline: CheckedBaseline | null;
  prepared: { frame: CommitFrame; before: LocalCommit["before"] } | null;
  store: AuthoredStore | null; held: boolean; attempting: boolean;
  settled: Promise<LocalCommit>; committed: boolean; resolve(receipt: LocalCommit): void; reject(error: Error): void;
  result: Promise<LocalCommit>; accept(receipt: LocalCommit): void; refuse(error: unknown): void; retry_failure: ((error: unknown) => void) | null;
  ready: Promise<void>; release(): void; faulted: boolean; fault: unknown;
  created_refs: readonly string[];
  prepare_graph: (() => Promise<void>) | null;
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
  // The tail's last title owner can collect edits until its preparation starts.
  private queuedTitle: { owner: FailedCommit; origin: unknown } | null = null;
  private failed: FailedCommit | null = null;
  private retrying: Promise<void> | null = null;
  private retired = false;
  private state: SaveState = { saving: false, error: null, error_occurrence: null, error_refs: [], revision: 0 };
  private pending = 0;
  private readonly pending_commands = new Map<Promise<LocalCommit | null>, FailedCommit | null>();
  private capture_scope: { owner: FailedCommit; origins: Map<string, unknown>; updates: Map<string, Uint8Array[]>; offending: Map<string,{document:CachedDocument;updates:string[]}> } | null = null;
  constructor(private readonly accountId: string) {}
  snapshot = (): SaveState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<SaveState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  async committedPrefix(): Promise<string> {
    this.queuedTitle = null;
    const admitted = this.tail;
    // A successful retry can settle the command before its first attempt leaves this map.
    const required = [...this.pending_commands].flatMap(([result, owner]) => owner?.committed ? [] : [result]);
    await Promise.all(required);
    await admitted;
    if (this.retired) throw new Error("Writing account is closed");
    return (await (await this.store).readReplica()).command_seq;
  }
  whenUploaded(commandSeq: string, signal: AbortSignal): Promise<void> { return this.store.then(store => store.whenUploaded(commandSeq, signal)); }
  run(intent: Intent, selection: Partial<StateSelection> = {}, credit: PageCredit = null, highlight_registers: ReadonlyMap<string, HighlightRegisters> = new Map()): Promise<LocalCommit> {
    return this.enqueue(intent, { selection, credit, highlight_registers, foldOrigin: null });
  }
  private enqueue(intent: Intent, { selection, credit, highlight_registers, foldOrigin }: {
    selection: Partial<StateSelection>; credit: PageCredit; highlight_registers: ReadonlyMap<string, HighlightRegisters> | null; foldOrigin: unknown;
  }): Promise<LocalCommit> {
    if (this.retired) return Promise.reject(new Error("Writing account is closed"));
    if (this.capture_scope) {
      const error = new Error("A compound mutation cannot submit another command");
      this.capture_scope.owner.faulted = true;
      this.capture_scope.owner.fault = error;
      throw error;
    }
    const frozen = structuredClone(intent);
    const inferred = intentSelection(frozen, credit);
    const selected = selectStates(selection);
    for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) inferred[key] = [...new Set([...inferred[key], ...selected[key]])];
    const waiting = this.pending > 0;
    const owner = this.reserve(credit);
    if (highlight_registers !== null) owner.highlight_registers = new Map(highlight_registers);
    const capturesExcerpt = (command: Intent): boolean => command.kind === "batch" ? command.intents.some(capturesExcerpt) : command.kind === "create_highlight" || command.kind === "update_highlight" && command.selection !== null || command.kind === "capture_passage";
    owner.reject_oversize = capturesExcerpt(frozen);
    owner.intent = frozen;
    owner.selection = inferred;
    if (waiting && foldOrigin !== null && foldOrigin !== undefined && frozen.kind === "edit_title") this.queuedTitle = {owner, origin: foldOrigin};
    owner.release();
    this.publish({ saving: true });
    return owner.result;
  }
  /** Reserve graph-only admission on the same account tail. Expected refusal
   * precedes sequence allocation, placement publication and the save-failure lane. */
  admitGraph<R>(args: {
    credit: PageCredit;
    prepare(): Promise<{kind: "ready"; intents: readonly GraphIntent[]; selection: Partial<StateSelection>; preflight_revision: string | null; accepted(states: MergeResult): void} | {kind: "refusal"; reason: R}>;
    active(): boolean; retired: R; changed: R; capacity: R | null;
  }): {result: Promise<{kind: "committed"; receipt: LocalGraphCommit} | {kind: "refusal"; reason: R}>; committed: Promise<LocalGraphCommit | null>} {
    if (this.capture_scope) throw new Error("A compound mutation cannot submit another command");
    this.queuedTitle = null;
    let accept: (value: {kind: "committed"; receipt: LocalGraphCommit} | {kind: "refusal"; reason: R}) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const result = new Promise<{kind: "committed"; receipt: LocalGraphCommit} | {kind: "refusal"; reason: R}>((resolve, refuse) => {accept = resolve; reject = refuse;});
    let settle: (receipt: LocalGraphCommit | null) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const committed = new Promise<LocalGraphCommit | null>((resolve, refuse) => {settle = resolve; fail = refuse;});
    void committed.catch(() => {});
    const refuse = (reason: R): null => {accept({kind: "refusal", reason}); return null;};
    this.pending++; this.pending_commands.set(committed, null); this.publish({saving: true});
    const operation = this.tail.then(async () => {
      if (this.retired || !args.active()) return refuse(args.retired);
      const store = await this.store;
      return store.withCommand(async () => {
        if (this.retired || !args.active()) return refuse(args.retired);
        const prepared = await args.prepare();
        if (prepared.kind === "refusal") return refuse(prepared.reason);
        if (this.retired || !args.active()) return refuse(args.retired);
        const graph = structuredClone([...prepared.intents]), intent: Intent = {kind: "batch", intents: graph};
        const selection = intentSelection(intent, args.credit), requested = selectStates(prepared.selection);
        for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) selection[key] = [...new Set([...selection[key], ...requested[key]])];
        const snapshot = await store.readSnapshot(selection);
        if (prepared.preflight_revision !== null && snapshot.replica.store_revision !== prepared.preflight_revision) return refuse(args.changed);
        if (this.retired || !args.active()) return refuse(args.retired);
        const context = {replica_id: snapshot.replica.replica_id, command_seq: (BigInt(snapshot.replica.command_seq) + 1n).toString(), lamport: (BigInt(snapshot.replica.lamport) + 1n).toString()};
        const lowered = lowerGraph(context, graph, snapshot.states, args.credit);
        if (!lowered) {
          if (args.capacity === null) throw new Error("An admitted graph inverse exceeds its reserved command capacity");
          return refuse(args.capacity);
        }
        const {change, states} = lowered;
        const owner = this.commandOwner(args.credit);
        this.pending_commands.set(committed, owner);
        owner.intent = intent; owner.selection = selection; owner.change = change; owner.store = store;
        owner.prepared = {before: commitBefore(change, snapshot.states, selection), frame: {expected_store_revision: snapshot.replica.store_revision, replica_id: snapshot.replica.replica_id, change, states}};
        owner.release();
        void owner.result.catch(reject);
        const receipt = await this.commitHeld(owner, store, () => prepared.accepted(states));
        const graphReceipt: LocalGraphCommit = {...receipt, states: owner.prepared!.frame.states};
        accept({kind: "committed", receipt: graphReceipt});
        return graphReceipt;
      });
    });
    this.tail = operation.then(settle, error => {reject(error); fail(error);}).finally(() => {
      this.pending_commands.delete(committed); this.pending--; this.publish({saving: this.pending > 0});
    });
    return {result, committed};
  }
  /** A structural edit can prove its forward, undo and redo before publishing text.
   * The first write uses the witness's exact snapshot and account lease. */
  admitCheckedWriting<T>(credit: PageCredit, check: (store: AuthoredStore, admit: (args: WritingMutation, baseline: CheckedBaseline) => WritingAdmission) => Promise<T>): Promise<T> {
    if (this.capture_scope) throw new Error("A compound mutation cannot submit another command");
    this.queuedTitle = null;
    let accept: (value: T) => void = () => {}, reject: (error: unknown) => void = () => {};
    const decision = new Promise<T>((resolve, refuse) => {accept = resolve; reject = refuse;});
    const operation: Promise<LocalCommit | null> = this.tail.then(async () => {
      if (this.retired) throw new Error("Writing account is closed");
      const store = await this.store;
      return store.withCommand(async () => {
        if (this.retired) throw new Error("Writing account is closed");
        const owner = this.commandOwner(credit);
        let value: T;
        try {
          value = await check(store, (args, baseline) => this.sealWriting(args, () => {
            if (owner.intent !== null) throw new Error("Writing admission was already used");
            owner.baseline = baseline; this.pending_commands.set(operation, owner); return owner;
          }));
        } catch (error) {
          if (owner.intent === null) throw error;
          reject(error); // A presenter fault cannot strand an already sealed write.
          return this.commitHeld(owner, store, () => {});
        }
        if (owner.intent === null) {accept(value); return null;}
        return this.commitHeld(owner, store, () => accept(value));
      });
    });
    this.pending++; this.pending_commands.set(operation, null); this.publish({saving: true});
    this.tail = operation.then(() => {}, reject).finally(() => {
      this.pending_commands.delete(operation); this.pending--; this.publish({saving: this.pending > 0});
    });
    return decision;
  }
  private async commitHeld(owner: FailedCommit, store: AuthoredStore, accepted: () => void): Promise<LocalCommit> {
    owner.store = store; owner.held = true; owner.attempting = true; this.failed = owner;
    try {
      accepted();
      let receipt: LocalCommit;
      try {receipt = await this.prepareAndPersist(owner, store);}
      catch (error) {owner.attempting = false; this.reportFailure(owner, error); receipt = await owner.settled;}
      owner.resolve(receipt); owner.accept(receipt);
      if (this.failed === owner) this.failed = null;
      this.publish({error: null, error_occurrence: null, error_refs: []});
      return receipt;
    } finally {owner.held = false; owner.attempting = false;}
  }
  /** Reserve one command before exposing new documents or running synchronous
   * structural edits. Only actual updates from the declared live documents enter
   * its text segment; asynchronous preparation may add graph intents only. */
  admitWriting(args: WritingMutation & {credit: PageCredit}): WritingAdmission {
    return this.sealWriting(args, () => this.reserve(args.credit));
  }
  private sealWriting(args: WritingMutation, reserve: () => FailedCommit): WritingAdmission {
    if (this.retired) throw new Error("Writing account is closed");
    if (this.capture_scope) {
      const error = new Error("Nested compound writing is unavailable");
      this.capture_scope.owner.faulted = true;
      this.capture_scope.owner.fault = error;
      throw error;
    }
    const participants: {document: CachedDocument; origin: unknown; state_vector?: Uint8Array}[] = [];
    const refs = new Set<string>();
    for (const entry of args.existing) {
      const cached = this.documents.get(entry.document.ref)?.value;
      if (!cached || cached !== entry.document || refs.has(cached.ref)) throw new Error("Compound writing needs distinct open documents from this account");
      refs.add(cached.ref);
      participants.push({document:cached,origin:entry.origin,state_vector:entry.state_vector});
    }
    const initializers: {ref:string;intent:Extract<Intent,{kind:"create_note"}>;doc:Y.Doc;origin:unknown}[] = [];
    try {
      for (const note of args.notes) {
        const intent = "initializer" in note ? note.initializer : createNoteIntent(`note_block:${crypto.randomUUID()}`, note.body);
        initializers.push({ref:intent.ref,intent,doc:hydrateNote(intent.body_update),origin:note.origin});
      }
    } catch (error) {
      for (const note of initializers) note.doc.destroy();
      throw error;
    }
    const owner = reserve();
    owner.created_refs = initializers.map(note=>note.ref);
    const created: CachedDocument[] = [];
    const preludes: Intent[] = [];
    for (const {document,origin} of participants) {
      const registers = document.highlightRegisters();
      if (registers) owner.highlight_registers.set(document.ref, registers);
      preludes.push(...document.prelude);
      document.prelude = [];
      const release = document.retain();
      document.track(owner.settled,origin);
      void owner.settled.then(release,release);
    }
    for (const note of initializers) {
      const resource: ResourceState = {kind:"note",ref:note.ref,touch_vv:{},delete_vv:{},body_state:note.intent.body_update,work:null};
      const document = this.cacheDocument(note.ref,resource,note.doc,[],null,null);
      const release = document.retain();
      document.track(owner.settled,note.origin);
      document.text_pending.add(owner.settled);
      void owner.settled.then(release,release);
      const entry = {promise:Promise.resolve(document),value:document};
      this.documents.set(note.ref,entry);
      void owner.settled.then(() => this.store.then(opened => {
        if (!this.retired && this.documents.get(note.ref)?.value === document) this.listenDocument(document,opened,null);
      })).catch(() => {});
      created.push(document);
      participants.push({document,origin:note.origin});
      preludes.push(note.intent);
    }
    if (owner.credit) refs.add(owner.credit.ref);
    owner.selection = selectStates({refs:[...refs,...created.map(document=>document.ref)]});
    const scope = {owner,origins:new Map(participants.map(({document,origin})=>[document.ref,origin])),updates:new Map<string,Uint8Array[]>(),offending:new Map<string,{document:CachedDocument;updates:string[]}>()};
    this.capture_scope = scope;
    try {
      const returned: unknown = args.mutate(created);
      if (returned !== undefined) throw new TypeError("Compound mutation must finish synchronously");
    }
    catch (error) { owner.faulted = true; owner.fault = error; }
    finally { this.capture_scope = null; }
    for (const {document} of participants) if (scope.updates.has(document.ref)) document.text_pending.add(owner.settled);
    for (const {document} of scope.offending.values()) document.text_pending.add(owner.settled);
    const edits: Intent[] = [];
    try {
      for (const {document, state_vector} of participants) {
        const updates = scope.updates.get(document.ref); if (!updates) continue;
        // A refused join includes the undurable copy as well as its undo.
        const update = state_vector ? encodeBytes(Y.encodeStateAsUpdate(document.doc, state_vector)) : encodeBytes(transactionUpdate(updates));
        if (document.doc.share.has("body")) edits.push({kind:"edit_body",ref:document.ref,body_update:update});
        else edits.push({kind:"edit_title",ref:document.ref,title_update:update});
      }
      for (const [ref,offending] of scope.offending) for (const update of offending.updates) {
        if (offending.document.doc.share.has("body")) edits.push({kind:"edit_body",ref,body_update:update});
        else edits.push({kind:"edit_title",ref,title_update:update});
      }
    } catch (error) { if (!owner.faulted) { owner.faulted = true; owner.fault = error; } }
    owner.intent = {kind:"batch",intents:[...preludes,...edits]};
    if (!owner.faulted) owner.prepare_graph = async () => {
      // The reserved tail already orders every participant's pending local command.
      const graph = structuredClone(await args.prepare(created.map(document=>document.ref)));
      for (const intent of graph) if (intent.kind === "batch" || intent.kind === "create_note" || intent.kind === "create_page" || intent.kind === "create_highlight" || intent.kind === "edit_body" || intent.kind === "edit_title") {
        owner.faulted = true;
        owner.fault = new TypeError("Compound preparation may return graph intents only");
        throw owner.fault;
      }
      const intent: Intent = {kind:"batch",intents:[...preludes,...edits,...graph]};
      const selected = intentSelection(intent, owner.credit);
      owner.intent = intent;
      owner.selection = selectStates({refs:[...new Set([...selected.refs,...owner.selection.refs])],link_ids:selected.link_ids,anchor_ids:selected.anchor_ids,source_refs:selected.source_refs});
      owner.prepare_graph = null;
    };
    owner.release();
    this.publish({ saving: true });
    return {created,result:owner.result};
  }
  private commandOwner(credit: PageCredit): FailedCommit {
    let accept: (receipt: LocalCommit) => void = () => {};
    let refuse: (error: unknown) => void = () => {};
    const result = new Promise<LocalCommit>((resolve, reject) => { accept = resolve; refuse = reject; });
    let resolve: (receipt: LocalCommit) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const settled = new Promise<LocalCommit>((done, failed) => { resolve = done; reject = failed; });
    void settled.catch(() => {});
    let release: () => void = () => {};
    const ready = new Promise<void>(done => { release = done; });
    const owner: FailedCommit = {
      occurrence: {}, credit, highlight_registers: new Map(), reject_oversize: false, intent: null, selection: selectStates({}), baseline: null,
      change: null, prepared: null, store: null, held: false, attempting: false, settled, committed: false,
      resolve(receipt) { owner.committed = true; resolve(receipt); },
      reject, result, accept, refuse, retry_failure: null, ready, release, faulted: false, fault: null, created_refs: [], prepare_graph: null,
    };
    return owner;
  }
  private reserve(credit: PageCredit): FailedCommit {
    this.queuedTitle = null;
    this.pending++;
    this.state = { ...this.state, saving: true };
    const owner = this.commandOwner(credit), {result, settled} = owner;
    this.pending_commands.set(result, owner);
    const operation = this.tail.then(async () => {
      if (this.queuedTitle?.owner === owner) this.queuedTitle = null;
      if (this.retired) throw new Error("Writing account is closed");
      this.failed = owner;
      let receipt: LocalCommit;
      try { receipt = await this.attempt(owner); }
      catch (error) {
        if (refusedBeforePrepare(owner, error)) {
          if (this.failed === owner) this.failed = null;
          throw error;
        }
        this.reportFailure(owner, error); receipt = await settled;
      }
      if (this.failed === owner) this.failed = null;
      this.publish({ error: null, error_occurrence: null, error_refs: [] });
      owner.resolve(receipt);
      return receipt;
    });
    this.tail = operation.then(owner.accept, error => {
      owner.reject(error instanceof Error ? error : new Error("Writing command did not settle"));
      if (!this.retired) this.publish(refusedBeforePrepare(owner, error)
        ? { error: null, error_occurrence: null, error_refs: [] } : { error, error_occurrence: owner.occurrence, error_refs: owner.selection.refs });
      owner.refuse(error);
    }).finally(() => {
      this.pending_commands.delete(result);
      this.pending--; this.publish({ saving: this.pending > 0 });
    });
    return owner;
  }
  private reportFailure(owner: FailedCommit, error: unknown): void {
    if (this.retired) return;
    this.publish({ error, error_occurrence: owner.occurrence, error_refs: owner.selection.refs });
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
          if (refusedBeforePrepare(owner, error)) throw error;
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
    await owner.ready;
    if (this.retired) throw new Error("Writing account is closed");
    if (owner.faulted) throw owner.fault;
    if (owner.prepare_graph) await owner.prepare_graph();
    if (owner.intent === null) throw new Error("Writing command is unsealed");
    if (owner.prepared === null) {
      if (owner.baseline) owner.selection = owner.baseline.selection;
      const { replica, states } = owner.baseline ?? await store.readSnapshot(owner.selection);
      if (this.retired) throw new Error("Writing account is closed");
      if (states.resources.some(resource=>owner.created_refs.includes(resource.ref))) throw new TypeError("New writing identity already exists");
      if (owner.change === null) {
        // A body edit carries the ancillary registers it observed at admission.
        // Lower with those exact fields and merge against the current LWW state.
        const observed = owner.highlight_registers.size ? {...states, resources: states.resources.map(resource => {
          const registers = owner.highlight_registers.get(resource.ref);
          return resource.kind === "highlight" && registers ? {...resource, ...registers} : resource;
        })} : states;
        const change = prepareChange({ replica_id: replica.replica_id, command_seq: (BigInt(replica.command_seq) + 1n).toString(), lamport: (BigInt(replica.lamport) + 1n).toString() }, owner.intent, observed);
        owner.change = foldPageCredit(change, states, owner.credit);
      }
      const before = commitBefore(owner.change, states, owner.selection);
      owner.prepared = { before, frame: { expected_store_revision: replica.store_revision, replica_id: replica.replica_id, change: owner.change, states: mergeChanges(states, [owner.change]) } };
      owner.baseline = null;
    }
    const receipt = await this.persist(owner.prepared, store, owner.created_refs, owner.selection);
    // Subscriptions may arrive after the receipt. Install the complete committed
    // baseline before a later edit can reference identities introduced by it.
    for (const resource of owner.prepared.frame.states.resources) {
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
  private async persist(prepared: { frame: CommitFrame; before: LocalCommit["before"] }, store: AuthoredStore, created_refs: readonly string[], selection: StateSelection): Promise<LocalCommit> {
    const { frame } = prepared;
    for (;;) {
      let result;
      try { result = await store.commit(frame); }
      catch (error) {
        const replica = await store.readReplica();
        if (BigInt(replica.command_seq) >= BigInt(frame.change.command_seq)) return { command_seq: frame.change.command_seq, store_revision: replica.store_revision, change: frame.change, before: prepared.before };
        throw error;
      }
      if (result.kind === "committed") return { command_seq: result.command_seq, store_revision: result.store_revision, change: frame.change, before: prepared.before };
      const current = await store.readSnapshot(selection);
      if (current.states.resources.some(resource=>created_refs.includes(resource.ref))) throw new TypeError("New writing identity already exists");
      prepared.before = commitBefore(frame.change, current.states, selection);
      frame.expected_store_revision = current.replica.store_revision;
      frame.states = mergeChanges(current.states, [frame.change]);
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
    if (owner.faulted) throw owner.fault;
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
  /** Copy canonical text from failed creations and every open document with an
   * unresolved local save, including commands queued behind a failed owner. */
  hasUncommittedText(): boolean { return this.uncommittedTexts().some(text => text !== ""); }
  async uncommittedText(): Promise<string> { return this.uncommittedTexts().filter(text => text !== "").join("\n\n"); }
  private uncommittedTexts(): string[] {
    const texts = new Map<string, string>();
    const text = (body: NoteBody) => rawBodyText(noteBodySchema.nodeFromJSON(body.body_pm_json));
    const creation = (intent: Intent): void => {
      if (intent.kind === "batch") intent.intents.forEach(creation);
      else if (intent.kind === "create_note" || intent.kind === "create_highlight") {
        const doc = hydrateNote(intent.body_update);
        try { texts.set(intent.ref, text(readBody(doc))); }
        finally { doc.destroy(); }
      }
      else if (intent.kind === "create_page") texts.set(intent.ref, intent.title);
    };
    for (const owner of this.pending_commands.values()) if (owner?.intent) creation(owner.intent);
    for (const [ref, entry] of this.documents) if (entry.value && entry.value.text_pending.size > 0) {
      const { doc } = entry.value;
      texts.set(ref, doc.share.has("title") ? doc.getText("title").toString() : text(readBody(doc)));
    }
    return [...texts.values()];
  }
  async openDocument(ref: string, prelude: readonly Intent[] = []): Promise<WritingDocument> {
    return this.getOrOpenDocument(ref, prelude, () => this.loadDocument(ref, prelude));
  }
  /** Actual state from this account's atomic snapshot; an existing owner wins. */
  async openDocumentFromState(resource: ResourceState, loadedRevision: string, prelude: readonly Intent[] = []): Promise<WritingDocument> {
    return this.getOrOpenDocument(resource.ref, prelude, async () => this.hydrateDocument(resource, prelude, await this.store, loadedRevision));
  }
  private async getOrOpenDocument(ref: string, prelude: readonly Intent[], load: () => Promise<CachedDocument>): Promise<CachedDocument> {
    if (this.retired) throw new Error("Writing account is closed");
    let entry = this.documents.get(ref);
    if (!entry) {
      // Reserve the owner before either loader can await or hydrate a document.
      entry={promise:Promise.resolve().then(load),value:null};
      this.documents.set(ref,entry);
      const owner=entry;
      void owner.promise.then(value=>{owner.value=value;},()=>{if(this.documents.get(ref)===owner)this.documents.delete(ref);});
    }
    const document = await entry.promise;
    // An explicit reopen can restore a latent page even while its cell is cached.
    if (prelude.length > 0) document.prelude = prelude;
    return document;
  }
  openBody(ref:string):NoteBody|null {
    const document=this.documents.get(ref)?.value;
    return document?readBody(document.doc):null;
  }
  private async loadDocument(ref: string, prelude: readonly Intent[]): Promise<CachedDocument> {
    const store = await this.store;
    const selection = selectStates({ refs: [ref] });
    const { replica, states } = await store.readSnapshot(selection);
    const existing = states.resources.find(r => r.ref === ref);
    const creation = prelude.find((intent): intent is Extract<Intent,{kind:"create_page"}> => intent.kind === "create_page" && intent.ref === ref);
    const resource = existing ?? (creation ? {kind:"page" as const,ref,touch_vv:{},delete_vv:{},local_date:creation.local_date,title_state:createTitle(""),last_work_at_ms:null} : null);
    if (!resource) throw new Error("Writing document is unavailable");
    return this.hydrateDocument(resource, prelude, store, existing ? replica.store_revision : null);
  }
  private hydrateDocument(resource: ResourceState, prelude: readonly Intent[], store: AuthoredStore, loadedRevision: string | null): CachedDocument {
    const doc = resource.kind !== "page" ? hydrateNote(resource.body_state) : new Y.Doc();
    if (resource.kind === "page") Y.applyUpdate(doc, decodeBytes(resource.title_state), REMOTE);
    return this.cacheDocument(resource.ref, resource, doc, prelude, store, loadedRevision);
  }
  /** First input is an insertion from an observed empty occurrence. */
  firstNoteLink(parent: string, note: string): Extract<Intent, {kind: "add_link"}> {
    const [endpoint_a, endpoint_b] = sortedEndpoints(parent, note);
    return {kind: "add_link", link_id: linkId(this.accountId, endpoint_a, endpoint_b), endpoint_a, endpoint_b, position_a: "a0", position_b: "a0"};
  }
  private cacheDocument(ref: string, resource: ResourceState, doc: Y.Doc, prelude: readonly Intent[], store: AuthoredStore | null, loadedRevision: string | null): CachedDocument {
    let observed_touch = resource.touch_vv, current = resource;
    const pending_edits = new Set<Promise<LocalCommit>>();
    const committed = new Set<(receipt: LocalCommit, origin: unknown) => void>();
    const pendingListeners = new Set<() => void>();
    const cached: CachedDocument = {
      ref, doc, pins: 0, pending: 0, prelude, bytes: Y.encodeStateAsUpdate(doc).byteLength, last_used: Date.now(), unsubscribe: () => {},
      text_pending: new Set(), read_attempt: 0, read_subscription: 0,
      receive: latest => {
        if (this.retired) return;
        if (Object.entries(latest.touch_vv).some(([replica,sequence])=>BigInt(sequence)>BigInt(latest.delete_vv[replica]??"0"))) cached.prelude=[];
        observed_touch = mergeVector(observed_touch, latest.touch_vv); current = latest;
        Y.applyUpdate(doc, decodeBytes(latest.kind !== "page" ? latest.body_state : latest.title_state), REMOTE);
        cached.bytes = Y.encodeStateAsUpdate(doc).byteLength;
        cached.read_attempt++;
        void this.evict();
      },
      highlightRegisters: () => current.kind === "highlight" ? {selection: current.selection, color: current.color} : null,
      checkTextSize: (bytes, credit, creating) => {
        const counter = "9223372036854775807", replica_id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
        const causal = {ref, touch_vv: {[replica_id]: counter}, delete_vv: {}};
        const patch = current.kind === "page" ? {...causal, kind: "page" as const, local_date: current.local_date, title_update: "", last_work_at_ms: null}
          : current.kind === "note" ? {...causal, kind: "note" as const, body_update: "", work: null}
          : {...causal, kind: "highlight" as const, source_ref: current.source_ref, selection: current.selection, color: current.color, body_update: ""};
        const prelude = creating ? cached.prelude : [];
        const frame = prepareChange({replica_id, command_seq: counter, lamport: counter}, {kind: "batch", intents: [...prelude]},
          {resources: prelude.some(intent => intent.kind === "create_page") ? [] : [current], links: [], passages: [], source_stubs: []});
        frame.resources.push(patch);
        if (credit) {
          const page = frame.resources.find((value): value is PagePatch => value.ref === credit.ref && value.kind === "page");
          if (page && page.local_date === null) page.last_work_at_ms = MAX_PAGE_WORK_AT_MS;
          else if (!page) frame.resources.push({kind:"page", ref: credit.ref, touch_vv:{}, delete_vv:{}, local_date:null, title_update:null, last_work_at_ms: MAX_PAGE_WORK_AT_MS});
        }
        if (new TextEncoder().encode(JSON.stringify(frame)).byteLength + Math.ceil(bytes * 4 / 3) > MAX_COMMAND_BYTES) throw new CommandTooLargeError();
      },
      checkFirstNoteSize: (body, credit) => {
        const ref = `note_block:${crypto.randomUUID()}`;
        const link = this.firstNoteLink(cached.ref, ref), context = {replica_id: "ffffffff-ffff-4fff-bfff-ffffffffffff", command_seq: "9223372036854775807", lamport: "9223372036854775807"};
        const resources = cached.prelude.some(intent => intent.kind === "create_page") ? [] : [current];
        const states = {resources, links: [], passages: [], source_stubs: []};
        // Measure the frame with a valid tiny note. The real initializer's
        // maximal client id contributes only ASCII base64url bytes.
        const initializer = createNoteIntent(ref, emptyBody());
        const change = prepareChange(context, {kind: "batch", intents: [...cached.prelude, initializer, link]}, states);
        const budget = credit ? {...credit, at_ms: MAX_PAGE_WORK_AT_MS} : null;
        const measured = foldPageCredit(change, states, budget);
        if (new TextEncoder().encode(JSON.stringify(measured)).byteLength - initializer.body_update.length + Math.ceil(noteEncodingBound(body) * 4 / 3) > MAX_COMMAND_BYTES)
          throw new CommandTooLargeError();
        // Undo and redo carry only this note's and link's membership with fixed
        // widths. Neither carries the initializer or a repositioning batch.
      },
      onCommitted: listener => { committed.add(listener); return () => committed.delete(listener); },
      hasPendingEdits: () => pending_edits.size > 0,
      editsSettled: async () => { await Promise.all(pending_edits); },
      subscribePendingEdits: listener => {pendingListeners.add(listener); return () => pendingListeners.delete(listener);},
      track: (result, origin) => {
        pending_edits.add(result); cached.pending++;
        for (const listener of pendingListeners) listener();
        const settled=()=>{pending_edits.delete(result);cached.text_pending.delete(result);cached.pending--;for(const listener of pendingListeners)listener();void this.evict();};
        void result.then(receipt => { try { for (const listener of committed) listener(receipt, origin); } finally { settled(); } },settled);
      },
      capture: () => {
        this.queuedTitle = null;
        const body_state = encodeBytes(Y.encodeStateAsUpdate(doc));
        let observed: Vector = { ...observed_touch };
        const pending = [...pending_edits];
        return Promise.all(pending).then(receipts => {
          for (const receipt of receipts) {
            const patch = receipt.change.resources.find(patch => patch.ref === ref);
            const before = receipt.before.resources.find(resource => resource.ref === ref);
            observed = advanceCoverage(observed, before ? { touch: before.touch_vv, removed: before.delete_vv } : null, patch?.touch_vv ?? {});
          }
          return { body_state, observed_touch: observed };
        });
      },
      retain: () => { cached.pins++; return () => { cached.pins--; cached.last_used = Date.now(); void this.evict(); }; },
    };
    const kind = resource.kind;
    let changes: Uint8Array[] = [], at_ms = 0;
    doc.on("update", (update: Uint8Array) => {
      if (!changes.length) at_ms = Date.now();
      changes.push(update);
    });
    doc.on("afterAllTransactions", (_doc, transactions) => {
      const raw = changes; changes = [];
      const origin: unknown = transactions[0]!.origin;
      if (!raw.length || origin === REMOTE || this.retired) return;
      // A remote apply to live Yjs can produce a trailing null-origin
      // formatting cleanup. It shares the initiating edit's command or receipt.
      const update = transactionUpdate(raw);
      if (this.capture_scope) {
        const scope = this.capture_scope;
        const invalid = !scope.origins.has(ref) || scope.origins.get(ref) !== origin ||
          transactions.some(transaction => transaction.origin !== origin && transaction.origin !== null);
        const error = invalid ? new Error("Compound mutation used an undeclared document or origin") : null;
        if (error) { scope.owner.faulted = true; scope.owner.fault = error; }
        if (!scope.origins.has(ref)) {
          let offending = scope.offending.get(ref);
          if (!offending) {
            offending = {document:cached,updates:[]};
            scope.offending.set(ref,offending);
            scope.owner.selection.refs.push(ref);
            const release = cached.retain();
            cached.track(scope.owner.settled,origin);
            void scope.owner.settled.then(release,release);
          }
          offending.updates.push(encodeBytes(update));
        } else {
          const updates = scope.updates.get(ref);
          if (updates) updates.push(update); else scope.updates.set(ref, [update]);
        }
        if (error) throw error;
        return;
      }
      const intent: Intent = kind !== "page" ? { kind: "edit_body", ref, body_update: encodeBytes(update) } : { kind: "edit_title", ref, title_update: encodeBytes(update) };
      const prepared: Intent = cached.prelude.length ? {kind:"batch",intents:[...cached.prelude,intent]} : intent;
      cached.prelude = [];
      const credit = origin instanceof PageWritingOrigin ? origin.credit(at_ms) : null;
      // An undated page earns credit for each effective edit, even when a pair cancels out.
      const foldOrigin = credit === null && resource.kind === "page" && resource.local_date !== null ? origin : null;
      const queued = this.queuedTitle;
      const previous = queued?.owner.intent;
      // Keep generous room for the authored envelope before folding updates.
      if (prepared.kind === "edit_title" && queued?.origin === foldOrigin && previous?.kind === "edit_title" && previous.ref === ref &&
          previous.title_update.length + prepared.title_update.length <= MAX_COMMAND_BYTES / 2) {
        const combined = encodeBytes(Y.mergeUpdates([decodeBytes(previous.title_update), update]));
        if (combined.length <= MAX_COMMAND_BYTES / 2) { previous.title_update = combined; return; }
      }
      const registers = cached.highlightRegisters();
      const pending = this.enqueue(prepared, { selection: { refs: [ref] }, credit,
        highlight_registers: registers ? new Map([[ref, registers]]) : null, foldOrigin }).catch(error => {
        if (error instanceof LocalCommitError && this.failed) return this.failed.settled;
        throw error;
      });
      cached.text_pending.add(pending);
      cached.track(pending, origin);
    });
    if (store) this.listenDocument(cached, store, loadedRevision === null ? null : { revision: loadedRevision, resource });
    return cached;
  }
  /** Keeps an open document current. A refresh that fails over it shows nothing: the subscription
   * reads again at the next change. Only a defect is reported. */
  private listenDocument(cached: CachedDocument, store: AuthoredStore, loaded: { revision: string; resource: ResourceState } | null): void {
    const {ref} = cached;
    const entry = this.documents.get(ref);
    const subscription = ++cached.read_subscription;
    cached.read_attempt++;
    cached.unsubscribe();
    const current = () => !this.retired && this.documents.get(ref) === entry && cached.read_subscription === subscription && (!entry?.value || entry.value === cached);
    const failed = (error: unknown) => {if (current() && !isAuthoredStorageFailure(error)) reportError(error);};
    const refresh = (initial: { revision: string; resource: ResourceState } | null) => {
      if (!current()) return;
      const attempt = ++cached.read_attempt;
      const read = async () => {
        if (initial && (await store.readReplica()).store_revision === initial.revision) return initial.resource;
        return (await store.readStates(selectStates({refs: [ref]}))).resources.find(resource => resource.ref === ref);
      };
      void read().then(latest => {
        if (!current() || cached.read_attempt !== attempt) return;
        if (latest) cached.receive(latest);
      }).catch(error => {if (current() && cached.read_attempt === attempt) failed(error);});
    };
    cached.unsubscribe = store.onResourceChange(ref, () => refresh(null));
    refresh(loaded);
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
    this.publish({error: null, error_occurrence: null, error_refs: []});
    await this.finishClose();
  }
  async close(): Promise<void> {
    if (this.pending > 0 || this.failed || this.state.error !== null) throw new Error("Uncommitted writing must be saved or deliberately discarded");
    this.retired = true;
    if (runtimes.get(this.accountId) === this) runtimes.delete(this.accountId);
    await this.finishClose();
  }
  private async finishClose(): Promise<void> {
    await this.tail.catch(() => {});
    const opened=await Promise.allSettled([...this.documents.values()].map(entry=>entry.promise));
    for (const entry of opened) if(entry.status==="fulfilled"){entry.value.unsubscribe();entry.value.doc.destroy();}
    this.documents.clear();
    if (this.opened_store) await (await this.opened_store).close();
    if (runtimes.get(this.accountId) === this) runtimes.delete(this.accountId);
  }
}

/** Absence is certified only by a complete request for that exact identity. */
function commitBefore(change: Change, states: Corpus, requested: Pick<StateSelection, "refs" | "link_ids">): LocalCommit["before"] {
  const resources = new Map(states.resources.map(resource => [resource.ref, resource]));
  const links = new Map(states.links.map(link => [link.link_id, link]));
  return {
    resources: [...new Set(change.resources.map(resource => resource.ref))].flatMap(ref => {
      const resource = resources.get(ref);
      return resource || requested.refs.includes(ref) ? [{ ref, touch_vv: { ...resource?.touch_vv }, delete_vv: { ...resource?.delete_vv }, work: resource?.kind === "note" ? structuredClone(resource.work) : null }] : [];
    }),
    links: [...new Set(change.links.map(link => link.link_id))].flatMap(link_id => {
      const link = links.get(link_id);
      return link || requested.link_ids.includes(link_id) ? [{ link_id, add_vv: { ...link?.add_vv }, remove_vv: { ...link?.remove_vv } }] : [];
    }),
  };
}

function intentSelection(intent: Intent, credit: PageCredit): StateSelection {
  const selection = selectStates({refs: credit ? [credit.ref] : []});
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

/** Lower one complete graph payload without making oversized work exceptional.
 * Shared with reversible-capacity admission; no sequence is consumed here. */
export function lowerGraph(context: CommandContext, intents: readonly GraphIntent[], corpus: Corpus, credit: PageCredit): {change: Change; states: MergeResult} | null {
  const change: Change = {command_seq: context.command_seq, lamport: context.lamport, resources: [], links: [], passages: [], source_stubs: []};
  let states = mergeChanges(corpus, []);
  for (const intent of intents) {
    const patch = prepareChange(context, intent, states);
    change.resources.push(...patch.resources); change.links.push(...patch.links);
    change.passages.push(...patch.passages); change.source_stubs.push(...patch.source_stubs);
    if (new TextEncoder().encode(JSON.stringify(change)).byteLength > MAX_COMMAND_BYTES) return null;
    states = mergeChanges(states, [patch]);
  }
  const credited = foldPageCredit(change, corpus, credit);
  if (credited === change) return {change, states};
  if (new TextEncoder().encode(JSON.stringify(credited)).byteLength > MAX_COMMAND_BYTES) return null;
  return {change: credited, states: mergeChanges(corpus, [credited])};
}

function refusedBeforePrepare(owner: FailedCommit, error: unknown): boolean {
  return owner.prepared === null && (error instanceof WorkConversionError || error instanceof WorkJoinError || error instanceof WorkUnavailableError || error instanceof CommandTooLargeError && owner.reject_oversize);
}
