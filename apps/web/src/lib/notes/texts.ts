"use client";

/**
 * Same-tab occurrences share one text owner; independent tabs own journal branches.
 * Editors paint synchronously. Every committed edit checkpoints immediately and
 * admits its typed autosave in that same transaction. Acknowledgements change the
 * base, never newer input. Publication descriptors contain no component callbacks.
 * Unload protection belongs to the authenticated shell's existing work guard.
 */
import { useSyncExternalStore } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { readSharedValue } from "@/lib/api/serverState";
import { watchWritingResource, type WritingWatch } from "@/lib/api/writingReceive";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { bodyHasContent, emptyBody, parseBody, sameBody, type NoteBody } from "./noteBody";
import { fetchNote } from "./api";
import {
  admitWriting, adoptDraftRead, captureLane, checkpoint, claimDraft, creationDependency, discardDraft, draftDependency, draftIsCleanSeed, draftIsDurable, expediteDraft,
  observeWritingIntent, openDraft, openFreshDraft, readDraft, readWriting, releaseDraft, resolveDraftConflict, snapshotDraft,
  stageDraft, subscribeDraft, subscribeWriting, subscribeWritingAcknowledgements, subscribeWritingBindings,
  updateDraftContext,
  type AuthoredSnapshot, type ConflictShown, type DraftBase, type DraftContext, type DraftHandle, type DraftShown,
  type DraftSelection, type DraftValue, type DraftConflict, type LaneDependency, type Publication,
  type ReferenceConsumption,
  type WritingAck, type WritingIntent,
} from "./journal";
import { nudgeWrites } from "./writes";

export type TextValue = NoteBody | string;
interface Saved { readonly value: TextValue; readonly version: number }
export interface TextEditBase {
  readonly value: TextValue;
  readonly acknowledged: Saved | null;
  readonly consumed_reference: ReferenceConsumption | null;
}
export type TextWritingState = "saving" | "local_syncing" | "local_offline" | "synced" | "uncertain" | "memory_only" | "draft" | "blocked";
export interface Text {
  readonly ready: boolean;
  readonly value: TextValue;
  readonly revision: number;
  readonly acked: Saved | null;
  readonly conflict: (Saved & { readonly origin: "server" }) | { readonly origin: "local"; readonly value: TextValue } | null;
  readonly failure: { readonly requestId?: string } | null;
  readonly gone: boolean;
  readonly creationIntent: boolean;
  readonly writingState: TextWritingState;
  readonly durable: boolean;
}
interface Entry extends Text {
  readonly creator: Publication | null;
  readonly handle: DraftHandle | null;
  readonly opening: Promise<DraftHandle>;
  readonly selection: DraftSelection;
  readonly localRevision: number;
  readonly durableRevision: number;
  readonly pending: number;
  readonly awaitingCreator: boolean;
}
export interface TextTitle {
  readonly title: string;
  readonly acknowledged: { readonly title: string; readonly version: number } | null;
  readonly unsettled: boolean;
  readonly gone: boolean;
}
const texts = new Map<string, Entry>();
const aliases = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
const titleListeners = new Set<() => void>();
const watches = new Map<string, { watch: WritingWatch; controller: AbortController | null }>();
let titleRevision = 0;
let account = readWriting().account_id;

const same = (a: TextValue, b: TextValue): boolean => typeof a === "string" || typeof b === "string" ? a === b : sameBody(a, b);
const canonicalValue = (value: TextValue): TextValue => typeof value === "string" ? value : parseBody(value.body_pm_json);
const valueOf = (value: TextValue): DraftValue => typeof value === "string" ? { kind: "title", text: value } : { kind: "body", body_pm_json: value.body_pm_json };
function textValue(value: DraftValue): TextValue {
  switch (value.kind) {
    case "body": return parseBody(value.body_pm_json);
    case "title":
    case "capture": return value.text;
    case "reference": return parseBody(value.base_body_pm_json);
  }
}
function entry(ref: string): Entry {
  const value = textEntry(ref);
  // justify-defect: editors write only an opened canonical body or title.
  if (!value) throw new Error(`no text is open for ${ref}`);
  return value;
}
function canonicalTextRef(ref: string): string { return aliases.get(ref) ?? ref; }
function textEntry(ref: string): Entry | undefined { return texts.get(canonicalTextRef(ref)); }
function emit(ref: string): void {
  for (const listener of listeners.get(ref) ?? []) {
    try { listener(); } catch (error) { reportError(error); }
  }
}
function titleOf(value: TextValue): string {
  if (typeof value === "string") return value;
  const points: string[] = [];
  let pendingWhitespace = false;
  for (const point of value.body_text) {
    if (point === "\n") break;
    if (/\s/.test(point)) {
      pendingWhitespace = points.length > 0;
      continue;
    }
    if (pendingWhitespace) points.push(" ");
    if (points.length < 513) points.push(point);
    if (points.length === 513) break;
    pendingWhitespace = false;
  }
  return points.length > 512 ? `${points.slice(0, 511).join("")}…` : points.join("");
}
function dirty(value: Entry): boolean {
  return value.acked === null ? typeof value.value === "string" ? value.value.length > 0 : bodyHasContent(value.value) : !same(value.value, value.acked.value);
}
function titleSignature(value: Entry | undefined): string {
  return value === undefined ? "" : JSON.stringify([titleOf(value.value), value.acked === null ? null : [titleOf(value.acked.value), value.acked.version], dirty(value) || value.conflict !== null || value.pending > 0, value.gone]);
}
function update(ref: string, patch: Partial<Entry>, external = false): void {
  ref = canonicalTextRef(ref);
  const current = entry(ref);
  const next = { ...current, ...patch, revision: current.revision + (external ? 1 : 0) };
  texts.set(ref, next); emit(ref);
  for (const [alias, canonical] of aliases) if (canonical === ref) emit(alias);
  if (titleSignature(current) !== titleSignature(next)) {
    titleRevision += 1;
    for (const listener of titleListeners) {
      try { listener(); } catch (error) { reportError(error); }
    }
  }
}
function context(ref: string, value: TextValue, publication: Publication | null): DraftContext {
  if (typeof value !== "string") return { kind: "body", resource_ref: ref, publication };
  return { kind: "title", resource_ref: ref, publication: publication?.kind === "page" || publication?.kind === "insert_note" ? publication : null };
}
function receiveDraft(ref: string, handle: DraftHandle): void {
  if (textEntry(ref)?.handle !== handle) return;
  const draft = readDraft(handle.draft_id);
  const current = entry(ref);
  if (!draft) {
    update(ref, { ready: false, handle: null, value: typeof current.value === "string" ? "" : emptyBody(), acked: null,
      conflict: null, creator: null, selection: null, gone: true, creationIntent: false, awaitingCreator: false,
      localRevision: 0, durableRevision: 0, failure: null }, true);
    refreshState(ref); return;
  }
  const base = draft.base !== null && typeof draft.base.version === "number" ? { value: textValue(draft.base.value), version: draft.base.version } : current.acked;
  if (draftIsCleanSeed(handle.draft_id)) {
    update(ref, { value: textValue(draft.value), acked: base, conflict: null, selection: null,
      localRevision: 0, durableRevision: 0, failure: null, creator: null, creationIntent: false, awaitingCreator: false }, true);
    refreshState(ref); return;
  }
  const conflict = draft.conflict === null ? null : draft.conflict.saved_value !== null && typeof draft.conflict.saved_version === "number"
    ? { origin: "server" as const, value: textValue(draft.conflict.saved_value), version: draft.conflict.saved_version } : current.conflict;
  const durable = draftIsDurable(handle.draft_id);
  update(ref, { acked: base, conflict, durable: durable && current.pending === 0,
    ...(durable && same(current.value, textValue(draft.value)) ? { durableRevision: current.localRevision } : {}) });
  refreshState(ref);
}
function refreshState(ref: string): void {
  const current = entry(ref);
  const journal = readWriting();
  const rows = current.handle === null ? [] : journal.outbox.filter(row => row.authored.some(item => item.draft_id === current.handle!.draft_id));
  const durable = current.localRevision === current.durableRevision && current.pending === 0;
  const writingState: TextWritingState = journal.storage_error !== null && !durable ? "memory_only"
    : current.pending > 0 ? "saving"
    : rows.some(row => row.uncertain) ? "uncertain"
    : rows.some(row => row.blocked !== null) || current.conflict !== null ? "blocked"
    : rows.length > 0 ? typeof navigator !== "undefined" && !navigator.onLine ? "local_offline" : "local_syncing"
    : dirty(current) ? durable ? "draft" : "memory_only" : "synced";
  if (current.writingState !== writingState || current.durable !== durable) update(ref, { writingState, durable });
}
function pointerKey(ref: string): string { return `nexus-writing-branch:${readWriting().account_id}:${ref}`; }
function rememberBranch(ref: string, handle: DraftHandle): void {
  try { sessionStorage.setItem(pointerKey(ref), handle.draft_id); }
  catch (error) { if (!(error instanceof DOMException)) throw error; }
}
async function openTextDraft(ref: string, value: TextValue, base: DraftBase, publication: Publication | null): Promise<DraftHandle> {
  let pointed: string | null = null;
  try { pointed = sessionStorage.getItem(pointerKey(ref)); }
  catch (error) { if (!(error instanceof DOMException)) throw error; }
  const recoverable = readWriting().drafts.filter(draft => draft.resource_ref === ref && (draft.conflict !== null || draft.base === null || JSON.stringify(draft.value) !== JSON.stringify(draft.base.value)));
  const candidate = pointed !== null && recoverable.some(draft => draft.draft_id === pointed) ? pointed : recoverable.length === 1 ? recoverable[0]!.draft_id : null;
  const recovered = candidate === null ? null : await claimDraft(candidate);
  const handle = recovered ?? await openDraft(context(ref, value, publication), valueOf(value), base);
  rememberBranch(ref, handle);
  return handle;
}
function seed(ref: string, value: TextValue, base: Saved | null, publication: Publication | null, fresh: DraftHandle | null = null): void {
  const incoming = value;
  value = canonicalValue(value);
  if (base !== null) base = { ...base, value: base.value === incoming ? value : canonicalValue(base.value) };
  const initialBase: DraftBase = base === null ? null : { value: valueOf(base.value), version: base.version };
  const opening = fresh === null ? openTextDraft(ref, value, initialBase, publication) : Promise.resolve(fresh);
  // Opening clean content seeds only memory and takes branch ownership.
  const initial: Entry = { ready: false, value, revision: 0, acked: base, conflict: null, failure: null, gone: false, creationIntent: false,
    writingState: "synced", durable: true, creator: publication, handle: null, opening, selection: null,
    localRevision: 0, durableRevision: 0, pending: 0, awaitingCreator: false };
  texts.set(ref, initial); emit(ref);
  const install = (handle: DraftHandle) => {
    if (textEntry(ref)?.opening !== opening) return;
    const recovered = readDraft(handle.draft_id);
    const latest = entry(ref);
    const restored = recovered !== undefined && recovered.revision > 0 && latest.localRevision === 0;
    update(ref, { ready: true, handle, ...(restored ? { value: textValue(recovered.value), selection: recovered.selection,
      creator: recovered.context.kind === "body" || recovered.context.kind === "title" ? recovered.context.publication : latest.creator,
      localRevision: recovered.revision, durableRevision: draftIsDurable(handle.draft_id) ? recovered.revision : 0 } : {}) }, restored);
    subscribeDraft(handle.draft_id, () => receiveDraft(ref, handle));
    receiveDraft(ref, handle);
    if (entry(ref).acked !== null) watchText(ref, entry(ref).acked!.version);
  };
  if (fresh !== null) { rememberBranch(ref, fresh); install(fresh); }
  else void opening.then(install).catch(() => { if (textEntry(ref)?.opening === opening) update(ref, { writingState: "memory_only", durable: false, failure: {} }); });
}
export function adoptText(ref: string, value: TextValue, version: number | null): void {
  const current = textEntry(ref);
  if (!current) { seed(ref, value, version === null ? null : { value, version }, null); return; }
  value = canonicalValue(value);
  const saved = version === null ? null : { value, version };
  if (current.gone || (saved && current.acked && saved.version < current.acked.version) || dirty(current)) return;
  update(ref, { value, acked: saved ?? current.acked, failure: null }, !same(current.value, value));
  if (version !== null) {
    if (current.handle !== null) adoptDraftRead(current.handle, valueOf(value), version);
    watchText(ref, version);
  }
}
function watchText(ref: string, version: number): void {
  const accountId = readWriting().account_id;
  if (accountId === null || watches.has(ref)) return;
  const title = ref.startsWith("page:");
  const lane = title ? "title_version" : "body_version";
  const owner: { watch: WritingWatch; controller: AbortController | null } = {
    controller: null,
    watch: watchWritingResource({ accountId, ref, lanes: [lane],
      acknowledge(ack) {
        const value = title ? ack.pages.find(item => ref === `page:${item.id}`) : ack.notes.find(item => ref === `note_block:${item.id}`);
        return value === undefined ? {} : "title_version" in value ? { title_version: value.title_version } : { body_version: value.body_version };
      },
      invalidate(state) {
        owner.controller?.abort();
        if (state === "unavailable") { setGone(ref); return; }
        const controller = new AbortController(); owner.controller = controller;
        const generation = owner.watch.capture();
        const read = title
          ? apiFetch<ApiJson<"/resource-graph/outline/{ref}", "get">>(`/api/resource-graph/outline/${encodeURIComponent(ref)}?limit=1`, { signal: controller.signal, cache: "no-store" }).then(reply => {
              const content = reply.data.source.content;
              if (content.kind !== "page") throw new Error("page title read returned another resource kind");
              return { value: content.title, version: content.title_version };
            })
          : readSharedValue({ accountId, key: `/notes/blocks/${encodeURIComponent(ref.slice("note_block:".length))}`, signal: controller.signal, revalidate: true,
              load: signal => fetchNote(ref.slice("note_block:".length), signal),
            }).then(note => ({ value: { body_pm_json: note.body_pm_json, body_text: note.body_text }, version: note.body_version }));
        void read.then(saved => {
          if (controller.signal.aborted || readWriting().account_id !== accountId) return;
          if (owner.watch.adopt({ [lane]: saved.version }, generation)) adoptText(ref, saved.value, saved.version);
        }).catch(error => {
          if (controller.signal.aborted || isAbortError(error) || readWriting().account_id !== accountId || handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && error.status === 404) setGone(ref);
          else if (isApiError(error) && !isSameSystemApiDefect(error)) owner.watch.fail(error, generation);
          else reportError(error);
        });
      },
    }),
  };
  watches.set(ref, owner); owner.watch.adopt({ [lane]: version }, owner.watch.capture());
}
export function createText(ref: string, value: NoteBody, publication: Publication | null): void {
  if (!textEntry(ref)) seed(ref, value, null, publication);
  else update(ref, { value, creator: publication, gone: false }, true);
}
/** Only the caller that just minted this resource ref may use fresh ownership. */
export function createFreshText(ref: string, value: NoteBody, publication: Publication | null): void {
  if (textEntry(ref)) throw new Error("the fresh text resource is already open");
  const handle = openFreshDraft(context(ref, value, publication), valueOf(value));
  seed(ref, value, null, publication, handle);
}
export function setCreator(ref: string, publication: Publication | null): void {
  const current = entry(ref);
  const submit = publication !== null && current.awaitingCreator;
  update(ref, { creator: publication, awaitingCreator: submit ? false : current.awaitingCreator });
  void current.opening.then(async handle => {
    if (textEntry(ref)?.opening !== current.opening) return;
    const latest = entry(ref);
    await updateDraftContext(handle, context(ref, latest.value, latest.creator));
    if (submit && textEntry(ref)?.opening === current.opening) persist(ref, false);
  }).catch(() => { if (textEntry(ref)?.opening === current.opening) update(ref, { failure: {} }); });
}
function publicationWithBody(publication: Publication, value: NoteBody): Publication {
  switch (publication.kind) {
    case "insert_note": return { ...publication, request: { ...publication.request, body_pm_json: value.body_pm_json } };
    case "page": return { ...publication, request: { ...publication.request, initial_item: publication.request.initial_item.kind === "note" ? { ...publication.request.initial_item, body_pm_json: value.body_pm_json } : publication.request.initial_item } };
    case "capture": return { ...publication, request: { ...publication.request, text: value.body_text } };
    case "passage": return { ...publication, request: { ...publication.request, initial_note: publication.request.initial_note === null ? null : { ...publication.request.initial_note, body_pm_json: value.body_pm_json } } };
    case "attach_highlight": return { ...publication, request: { ...publication.request, body_pm_json: value.body_pm_json } };
    case "attach_link": return { ...publication, request: { ...publication.request, body_pm_json: value.body_pm_json } };
  }
}
function intentFor(ref: string, current: Entry, explicit: boolean): WritingIntent | null {
  ref = canonicalTextRef(ref);
  if (current.gone || current.conflict !== null) return null;
  if (current.acked === null) {
    const dependency = creationDependency(ref, typeof current.value === "string" ? "title" : "body");
    if (dependency !== null) {
      const id = ref.slice(ref.indexOf(":") + 1);
      return typeof current.value === "string"
        ? current.value.trim() ? { kind: "title", policy: "autosave", page_id: id, title: current.value, expected: dependency } : null
        : { kind: "body", policy: "autosave", note_id: id, body_pm_json: current.value.body_pm_json, expected: dependency };
    }
    if (current.creator === null || typeof current.value === "string" || (!explicit && !bodyHasContent(current.value))) return null;
    return publicationWithBody(current.creator, current.value);
  }
  const lane = typeof current.value === "string" ? "title" : "body";
  const preceding = current.handle === null ? null : draftDependency(current.handle, lane);
  if ((same(current.value, current.acked.value) && preceding?.kind !== "result") || (typeof current.value === "string" && !current.value.trim())) return null;
  const id = ref.slice(ref.indexOf(":") + 1);
  const policy = explicit ? "explicit" : "autosave";
  const expected: LaneDependency = preceding?.kind === "result" ? preceding : { kind: "observed", ref, lane, version: current.acked.version };
  return typeof current.value === "string"
    ? { kind: "title", policy, page_id: id, title: current.value, expected }
    : { kind: "body", policy, note_id: id, body_pm_json: current.value.body_pm_json, expected };
}
function persist(ref: string, explicit: boolean, consumed_reference: ReferenceConsumption | null = null): void {
  const current = entry(ref);
  const localRevision = current.localRevision;
  const value = current.value;
  const selection = current.selection;
  update(ref, { pending: current.pending + 1, durable: false, writingState: "saving" });
  void (async () => {
    const handle = current.handle;
    if (handle === null) throw new Error("the local authoring branch is still opening");
    const draft = readDraft(handle.draft_id);
    if (!draft) throw new Error("the authoring branch is unavailable");
    const intent = intentFor(ref, { ...entry(ref), value }, explicit);
    const shownConflict = entry(ref).conflict;
    const conflict: DraftConflict | null = shownConflict === null ? null : { reason: shownConflict.origin === "local" ? "another local draft differs" : "E_NOTE_CONFLICT", saved_value: valueOf(shownConflict.value), saved_version: shownConflict.origin === "server" ? shownConflict.version : entry(ref).acked?.version ?? null, other_draft_id: null };
    if (intent === null) {
      const durable = checkpoint(handle, draft.revision, valueOf(value), selection, null, conflict, consumed_reference);
      rememberBranch(ref, handle); await durable;
    }
    else {
      const snapshot = stageDraft(handle, valueOf(value), selection, conflict);
      rememberBranch(ref, handle);
      const pageRef = intent.kind === "page" ? `page:${intent.request.id}` : intent.kind === "insert_note" && intent.request.source.kind === "daily_page" ? `page:${intent.request.source.page_id}` : null;
      const authored = pageRef !== null && texts.has(pageRef)
        ? (intent.kind === "page" ? snapshotPageTitle(intent) : snapshotText(pageRef)).then(title => [snapshot, title]) : [snapshot];
      const admitted = admitWriting(intent, authored, consumed_reference);
      update(ref, { creationIntent: entry(ref).creationIntent || entry(ref).acked === null });
      await admitted.durable;
    }
    if (textEntry(ref)?.opening !== current.opening) return;
    const latest = entry(ref);
    update(ref, { durableRevision: Math.max(latest.durableRevision, localRevision), failure: null });
  })().catch(() => { if (textEntry(ref)?.opening === current.opening) update(ref, { failure: {}, writingState: "memory_only", durable: false }); })
    .finally(() => { if (textEntry(ref)?.opening === current.opening) { update(ref, { pending: Math.max(0, entry(ref).pending - 1) }); refreshState(ref); } });
}
export function editText(ref: string, value: TextValue, editBase?: TextEditBase, selection: DraftSelection = null): void {
  const current = entry(ref);
  if (current.handle === null || readWriting().paused) throw new Error("the local authoring branch is not ready for editing");
  let conflict = current.conflict;
  let acked = current.acked;
  let released: DraftHandle | null = null;
  if (editBase) {
    let original = editBase.acknowledged;
    // Exact current desired content needs no write and authorizes no other work.
    if (current.acked !== null && same(value, current.acked.value)) original = current.acked;
    // A pending edit can be acknowledged while the next composition remains
    // local. Only its exact desired fact may advance the captured authority;
    // a later canonical read alone cannot do so.
    if (current.acked !== null && same(current.acked.value, editBase.value)) {
      const accepted = current.acked;
      const lane = typeof value === "string" ? "title" : "body";
      const from = original?.version ?? 1;
      if (readDraft(current.handle.draft_id)?.results.some(result => result.ack.absolute_versions.some(fact =>
        fact.kind === "desired" && fact.ref === canonicalTextRef(ref) && fact.lane === lane && fact.from_version === from && fact.version === accepted.version))) original = accepted;
    }
    const changed = current.acked !== null && (original === null || current.acked.version !== original.version || !same(current.acked.value, original.value));
    if (!same(current.value, editBase.value) && !same(current.value, value) && dirty(current)) conflict = { origin: "local", value: current.value };
    else if (changed && current.acked) conflict = { origin: "server", ...current.acked };
    acked = original;
  }
  // The clean owner may have adopted a foreign value during local preedit. A
  // fresh authored branch preserves its captured base without rewriting that
  // confirmed row. The editor and resource keep their existing identities.
  if (editBase && current.conflict === null && conflict?.origin === "server" && !dirty(current) && current.pending === 0 && current.failure === null && readWriting().storage_error === null &&
    !readWriting().outbox.some(row => row.authored.some(item => item.draft_id === current.handle!.draft_id))) {
    const handle = openFreshDraft(context(canonicalTextRef(ref), value, null), valueOf(value), acked === null ? null : { value: valueOf(acked.value), version: acked.version });
    released = current.handle;
    update(ref, { handle, opening: Promise.resolve(handle), creator: null, creationIntent: false, awaitingCreator: false });
    subscribeDraft(handle.draft_id, () => receiveDraft(ref, handle));
  }
  update(ref, { value, acked, conflict, selection, localRevision: current.localRevision + 1,
    awaitingCreator: current.acked === null && current.creator === null && typeof value !== "string" && bodyHasContent(value) }); persist(ref, false, editBase?.consumed_reference ?? null);
  if (released !== null) void releaseDraft(released).catch(reportError);
}
export function replaceText(ref: string, value: TextValue): void {
  if (entry(ref).handle === null || readWriting().paused) throw new Error("the local authoring branch is not ready for editing");
  update(ref, { value, localRevision: entry(ref).localRevision + 1 }, true); persist(ref, false);
}
/** A structural admission carries the value; its journal transaction admits it. */
export function carryText(ref: string, value: TextValue): void {
  update(ref, { value, localRevision: entry(ref).localRevision + 1, durable: false }, true);
}
export async function snapshotText(ref: string): Promise<AuthoredSnapshot> {
  const handle = entry(ref).handle ?? await entry(ref).opening;
  const current = entry(ref);
  const draft = readDraft(handle.draft_id);
  if (!draft) throw new Error("the authoring branch is unavailable");
  const value = valueOf(current.value);
  stageDraft(handle, value, current.selection);
  rememberBranch(ref, handle);
  return snapshotDraft(handle);
}
/** Publication owns the default title; its carried snapshot must name that value. */
export function snapshotPageTitle(publication: Extract<Publication, { kind: "page" }>): Promise<AuthoredSnapshot> {
  const ref = `page:${publication.request.id}`;
  const current = entry(ref);
  if (current.acked === null && typeof current.value === "string" && !current.value.trim() && current.value !== publication.request.title)
    carryText(ref, publication.request.title);
  return snapshotText(ref);
}
export function textDraft(ref: string): DraftHandle | null { return textEntry(ref)?.handle ?? null; }
export async function restoreTextDraft(ref: string, id: string): Promise<boolean> {
  const handle = await claimDraft(id);
  if (handle === null) return false;
  const draft = readDraft(id);
  if (!draft) return false;
  const value = textValue(draft.value);
  if (!texts.has(ref)) seed(ref, value, draft.base !== null && typeof draft.base.version === "number" ? { value: textValue(draft.base.value), version: draft.base.version } : null, draft.context.kind === "body" || draft.context.kind === "title" ? draft.context.publication : null);
  update(ref, { ready: true, handle, opening: Promise.resolve(handle), value, selection: draft.selection, awaitingCreator: false,
    localRevision: draft.revision, durableRevision: draftIsDurable(id) ? draft.revision : 0 }, true);
  rememberBranch(ref, handle);
  subscribeDraft(id, () => receiveDraft(ref, handle)); receiveDraft(ref, handle); return true;
}
export function textDependency(ref: string, lane: "body" | "title"): LaneDependency | null {
  const current = textEntry(ref);
  if (!current) return null;
  const handle = current.handle;
  if (handle !== null) return draftDependency(handle, lane);
  return current.acked === null ? creationDependency(canonicalTextRef(ref), lane) : captureLane(canonicalTextRef(ref), lane, current.acked.version);
}
export function acknowledgeText(ref: string, value: TextValue, version: number): void {
  if (!textEntry(ref)) { adoptText(ref, value, version); return; }
  value = canonicalValue(value);
  if (entry(ref).acked !== null && version < entry(ref).acked!.version) return;
  update(ref, { acked: { value, version }, creator: null, failure: null, creationIntent: false }); refreshState(ref);
  watchText(ref, version);
}
export function setGone(ref: string): void { if (textEntry(ref)) update(ref, { gone: true }); }
export function resetText(ref: string): void {
  const current = entry(ref);
  if (current.acked) replaceText(ref, current.acked.value); else setGone(ref);
}
export async function resolveConflict(ref: string, keep: "mine" | "saved", shown: ConflictShown): Promise<void> {
  const current = entry(ref);
  const displayed = current.conflict;
  if (displayed === null) return;
  const handle = await current.opening;
  if (textEntry(ref)?.opening !== current.opening || entry(ref).localRevision !== current.localRevision) throw new Error("the draft changed; review the current comparison");
  const draft = readDraft(handle.draft_id);
  const version = displayed.origin === "server" ? displayed.version : current.acked?.version ?? null;
  if (!draft || version === null) throw new Error("review the saved resource before choosing a replacement");
  await resolveDraftConflict(handle, keep, shown);
  if (textEntry(ref)?.opening !== current.opening) return;
  const settled = readDraft(handle.draft_id);
  if (settled && entry(ref).localRevision === current.localRevision) {
    update(ref, { value: textValue(settled.value), conflict: null }, true);
    refreshState(ref);
  }
}
/** Discard authored work without ending a retained canonical editor's owner. */
export async function discardTextDraft(ref: string, shown: DraftShown): Promise<void> {
  const current = entry(ref);
  if (current.handle === null) throw new Error("the local authoring branch is not ready");
  const conflict = current.conflict;
  const saved = conflict?.origin === "server" && (current.acked === null || conflict.version > current.acked.version) ? conflict : current.acked;
  await discardDraft(current.handle, shown, current.gone || saved === null ? null : { value: valueOf(saved.value), version: saved.version });
}
export function flushText(ref: string): void {
  const current = textEntry(ref);
  if (current) void current.opening.then(expediteDraft).then(nudgeWrites).catch(() => update(ref, { failure: {} }));
}
export function materializeText({ ref, body }: { ref: string; body: NoteBody }): { intent_id: string; durable: Promise<void>; settled: Promise<WritingAck> } | null {
  const current = entry(ref);
  if (current.acked !== null || current.creator === null || current.gone || current.conflict !== null) return null;
  const preceding = creationDependency(canonicalTextRef(ref), "body");
  if (preceding?.kind === "result") return observeWritingIntent(preceding.intent_id);
  carryText(ref, body);
  const publication = publicationWithBody(current.creator, body);
  const pageRef = publication.kind === "page" ? `page:${publication.request.id}` : publication.kind === "insert_note" && publication.request.source.kind === "daily_page" ? `page:${publication.request.source.page_id}` : null;
  const title = pageRef !== null && textEntry(pageRef) ? publication.kind === "page" ? snapshotPageTitle(publication) : snapshotText(pageRef) : null;
  const authored = title === null ? snapshotText(ref).then(snapshot => [snapshot]) : Promise.all([snapshotText(ref), title]);
  const admitted = admitWriting(publication, authored);
  update(ref, { creationIntent: true });
  return admitted;
}
export function textCreationReady(ref: string): boolean {
  const current = textEntry(ref); return current !== undefined && !current.gone && (current.acked !== null || current.creator !== null);
}
export function hasUnsavedText(ref: string): boolean { const current = textEntry(ref); return current !== undefined && dirty(current); }
export function readText(ref: string): Text | undefined { return textEntry(ref); }
function subscribeText(ref: string, listener: () => void): () => void {
  let scoped = listeners.get(ref);
  if (!scoped) { scoped = new Set(); listeners.set(ref, scoped); }
  scoped.add(listener);
  return () => { scoped.delete(listener); if (!scoped.size) listeners.delete(ref); };
}
export function useText(ref: string): Text | undefined {
  return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref), () => undefined);
}
export function useTextPublished(ref: string): boolean {
  return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.acked !== null && textEntry(ref)?.acked !== undefined, () => false);
}
export function useTextReady(ref: string): boolean {
  return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.ready ?? false, () => false);
}
export function useTextVersion(ref: string): number | null {
  return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.acked?.version ?? null, () => null);
}
export function readTextTitle(ref: string): TextTitle | null {
  const current = textEntry(ref); if (!current) return null;
  return { title: titleOf(current.value), acknowledged: current.acked && { title: titleOf(current.acked.value), version: current.acked.version }, unsettled: !current.gone && (dirty(current) || current.conflict !== null || current.pending > 0), gone: current.gone };
}
export function useTextTitleRevision(): number {
  return useSyncExternalStore(listener => { titleListeners.add(listener); return () => void titleListeners.delete(listener); }, () => titleRevision, () => 0);
}
function receiveAck(ack: WritingAck): void {
  for (const note of ack.notes) {
    const ref = `note_block:${note.id}`;
    if (texts.has(ref)) acknowledgeText(ref, { body_pm_json: note.body_pm_json, body_text: note.body_text }, note.body_version);
  }
  for (const page of ack.pages) if (texts.has(`page:${page.id}`)) acknowledgeText(`page:${page.id}`, page.title, page.title_version);
  for (const ref of ack.deleted_refs) setGone(ref);
}
subscribeWritingAcknowledgements(receiveAck);
subscribeWritingBindings(bindings => {
  for (const binding of bindings) {
    const incoming = textEntry(binding.from_ref);
    const previous = textEntry(binding.to_ref);
    aliases.set(binding.from_ref, binding.to_ref);
    for (const [alias, target] of aliases) if (target === binding.from_ref) aliases.set(alias, binding.to_ref);
    if (incoming) {
      texts.delete(binding.from_ref);
      const conflict = previous && previous !== incoming && dirty(previous) && !same(previous.value, incoming.value)
        ? { origin: "local" as const, value: previous.value } : incoming.conflict;
      texts.set(binding.to_ref, { ...incoming, conflict });
      if (incoming.handle !== null) receiveDraft(binding.to_ref, incoming.handle);
    }
    emit(binding.from_ref); emit(binding.to_ref);
  }
});
subscribeWriting(() => {
  const nextAccount = readWriting().account_id;
  if (account !== nextAccount) {
    for (const owner of watches.values()) { owner.controller?.abort(); owner.watch.stop(); }
    watches.clear();
    account = nextAccount; const refs = [...texts.keys(), ...aliases.keys()]; texts.clear(); aliases.clear();
    for (const ref of refs) emit(ref);
    titleRevision += 1; for (const listener of titleListeners) listener();
    return;
  }
  for (const ref of texts.keys()) refreshState(ref);
});
