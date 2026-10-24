"use client";
/** Canonical same-tab text owners. Unsaved committed edits stay in memory across
 * editor unmounts. Only the latest unsent edit coalesces; one field save remains
 * outstanding until acknowledgement/refusal. Canonical reads never rebase dirty
 * input. Composition remains local to its editor until committed with its base.
 */
import { useSyncExternalStore } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { readSharedValue } from "@/lib/api/serverState";
import { watchWritingResource, type WritingWatch } from "@/lib/api/writingReceive";
import { isAbortError } from "@/lib/errors";
import { bodyHasContent, parseBody, sameBody, type NoteBody } from "./noteBody";
import { fetchNote } from "./api";
import { admitWriting, canRetryWriting, isTextPredecessor, captureLane, creationDependency, readWriting, subscribeWriting,
  subscribeWritingAcknowledgements, subscribeWritingBindings, subscribeWritingAdmissions,
  provenTextVersion, WritingDecisionError,
  type AuthoredSnapshot, type AuthoredValue, type ConflictShown, type LaneDependency,
  type Publication, type WriteHandle, type WritingIntent } from "./writes";
export type TextValue = NoteBody | string;
interface Saved { readonly value: TextValue; readonly version: number }
export interface TextEditBase { readonly value: TextValue; readonly acknowledged: Saved | null }
export type TextWritingState = "saving" | "synced" | "uncertain" | "draft" | "blocked";
export interface Text {
  readonly ready: boolean;
  readonly value: TextValue;
  readonly revision: number;
  readonly acked: Saved | null;
  readonly conflict: (Saved & { readonly origin: "server" }) | { readonly origin: "local"; readonly value: TextValue } | null;
  readonly failure: { readonly error: unknown; readonly requestId?: string; readonly irreducible: boolean } | null;
  readonly gone: boolean;
  readonly creationIntent: boolean;
  readonly writingState: TextWritingState;
}
interface Entry extends Text {
  readonly creator: Publication | null;
  readonly selection: { anchor: number; head: number } | null;
  readonly outstanding: WriteHandle | null;
  readonly lastAccepted: WriteHandle | null;
  readonly autosave: boolean;
}
export interface TextTitle {
  readonly title: string;
  readonly acknowledged: { readonly title: string; readonly version: number } | null;
  readonly unsettled: boolean;
  readonly gone: boolean;
}
const AUTOSAVE_IDLE_MS = 250;
const AUTOSAVE_MAX_MS = 2_000;
const texts = new Map<string, Entry>();
const aliases = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
const titleListeners = new Set<() => void>();
const watches = new Map<string, { watch: WritingWatch; controller: AbortController | null }>();
const timers = new Map<string, { first: number; timer: ReturnType<typeof setTimeout> }>();
let titleRevision = 0;
let accountGeneration = readWriting().generation;
const same = (a: TextValue, b: TextValue): boolean => typeof a === "string" || typeof b === "string" ? a === b : sameBody(a, b);
const canonicalValue = (value: TextValue): TextValue => typeof value === "string" ? value : parseBody(value.body_pm_json);
const valueOf = (value: TextValue): AuthoredValue => typeof value === "string" ? { kind: "title", text: value } : { kind: "body", body_pm_json: value.body_pm_json };
function canonicalTextRef(ref: string): string { return aliases.get(ref) ?? ref; }
function textEntry(ref: string): Entry | undefined { return texts.get(canonicalTextRef(ref)); }
function entry(ref: string): Entry {
  const value = textEntry(ref);
  // justify-defect: editors may only edit an opened canonical text owner.
  if (!value) throw new Error(`no text is open for ${ref}`);
  return value;
}
function emit(ref: string): void {
  for (const listener of [...listeners.get(ref) ?? [], ...allListeners]) { try { listener(); } catch (error) { reportError(error); } }
}
function dirty(value: Entry): boolean {
  return value.acked === null ? typeof value.value === "string" ? value.value.length > 0 : bodyHasContent(value.value) : !same(value.value, value.acked.value);
}
function update(ref: string, patch: Partial<Entry>, external = false): void {
  ref = canonicalTextRef(ref);
  const current = entry(ref);
  texts.set(ref, { ...current, ...patch, revision: patch.revision ?? current.revision + (external ? 1 : 0) });
  emit(ref); for (const [alias, canonical] of aliases) if (canonical === ref) emit(alias);
  titleRevision += 1;
  for (const listener of titleListeners) { try { listener(); } catch (error) { reportError(error); } }
}
function seed(ref: string, value: TextValue, base: Saved | null, publication: Publication | null): void {
  value = canonicalValue(value);
  texts.set(ref, { ready: true, value, revision: 0, acked: base === null ? null : { ...base, value: canonicalValue(base.value) }, conflict: null,
    failure: null, gone: false, creationIntent: false, writingState: "synced", creator: publication, selection: null, outstanding: null, lastAccepted: null, autosave: false });
  emit(ref); if (base !== null) watchText(ref, base.version);
}
function refreshState(ref: string): void {
  const current = entry(ref);
  const state = current.outstanding?.read();
  const writingState = state?.kind === "unconfirmed" ? "uncertain" : current.conflict !== null || current.failure !== null ? "blocked"
    : state?.kind === "queued" || state?.kind === "sending" || timers.has(canonicalTextRef(ref)) ? "saving" : dirty(current) ? "draft" : "synced";
  if (current.writingState !== writingState) update(ref, { writingState });
}
function clearTimer(ref: string): void {
  ref = canonicalTextRef(ref); const timer = timers.get(ref); if (timer) clearTimeout(timer.timer); timers.delete(ref);
}
function schedule(ref: string): void {
  ref = canonicalTextRef(ref); const current = entry(ref);
  if (readWriting().paused || current.outstanding !== null || current.conflict !== null || current.gone || current.failure !== null) return;
  const first = timers.get(ref)?.first ?? Date.now(); clearTimer(ref);
  const delay = Math.max(0, Math.min(AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS - (Date.now() - first)));
  timers.set(ref, { first, timer: setTimeout(() => { timers.delete(ref); persist(ref, false); }, delay) }); refreshState(ref);
}
export function adoptText(ref: string, value: TextValue, version: number | null): void {
  const current = textEntry(ref);
  if (!current) { seed(ref, value, version === null ? null : { value, version }, null); return; }
  value = canonicalValue(value);
  if (current.acked === null && current.creator !== null) return;
  if (current.gone || (version !== null && current.acked !== null && version < current.acked.version) || dirty(current) || current.outstanding !== null) return;
  update(ref, { value, acked: version === null ? current.acked : { value, version }, failure: null }, !same(current.value, value));
  if (version !== null) watchText(ref, version);
}
function watchText(ref: string, version: number): void {
  const accountId = readWriting().account_id;
  if (accountId === null || watches.has(ref) || textEntry(ref)?.gone) return;
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
        if (watches.get(ref) !== owner) return;
        owner.controller?.abort();
        const generation = owner.watch.capture();
        if (state === "unavailable") { retire(generation); return; }
        const controller = new AbortController(); owner.controller = controller;
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
          if (controller.signal.aborted || readWriting().account_id !== accountId || watches.get(ref) !== owner) return;
          if (owner.watch.adopt({ [lane]: saved.version }, generation)) adoptText(ref, saved.value, saved.version);
        }).catch(error => {
          if (controller.signal.aborted || isAbortError(error) || readWriting().account_id !== accountId ||
            watches.get(ref) !== owner || owner.watch.capture() !== generation) return;
          if (isApiError(error) && !isSameSystemApiDefect(error) && error.status === 404) retire(generation);
          else owner.watch.fail(error, generation);
        });
      },
    }),
  };
  function retire(generation: number) {
    if (watches.get(ref) !== owner || owner.watch.capture() !== generation) return;
    watches.delete(ref);
    owner.controller?.abort();
    owner.watch.stop();
    setGone(ref);
  }
  watches.set(ref, owner); owner.watch.adopt({ [lane]: version }, owner.watch.capture());
}
export function createText(ref: string, value: NoteBody, publication: Publication | null): void {
  if (!textEntry(ref)) seed(ref, value, null, publication);
  else update(ref, { value: canonicalValue(value), creator: publication, gone: false }, true);
}
export function createFreshText(ref: string, value: NoteBody, publication: Publication | null): void {
  if (textEntry(ref)) throw new Error("the fresh text resource is already open");
  seed(ref, value, null, publication);
}
export function setCreator(ref: string, publication: Publication | null): void {
  update(ref, { creator: publication });
  if (entry(ref).autosave && dirty(entry(ref))) schedule(ref);
}
export function readPublication(ref: string): Publication | null { return textEntry(ref)?.creator ?? null; }
function publicationWithBody(publication: Publication, value: NoteBody): Publication {
  switch (publication.kind) {
    case "insert_note": return { ...publication, request: { ...publication.request, body_pm_json: value.body_pm_json } };
    case "page": return { ...publication, request: { ...publication.request, initial_item: publication.request.initial_item.kind === "note" ? { ...publication.request.initial_item, body_pm_json: value.body_pm_json } : publication.request.initial_item } };
    case "capture": return { ...publication, request: { ...publication.request, text: value.body_text } };
    case "passage": return { ...publication, request: { ...publication.request, initial_note: publication.request.initial_note === null ? null : { ...publication.request.initial_note, body_pm_json: value.body_pm_json } } };
    case "attach_highlight": return { ...publication, request: { ...publication.request, body_pm_json: value.body_pm_json } };
  }
}
function intentFor(ref: string, explicit: boolean): WritingIntent | null {
  ref = canonicalTextRef(ref); const current = entry(ref);
  if (current.gone || current.conflict !== null) return null;
  const lane = typeof current.value === "string" ? "title" : "body";
  const id = ref.slice(ref.indexOf(":") + 1);
  if (current.acked === null) {
    const dependency = creationDependency(ref, lane);
    if (dependency !== null) return typeof current.value === "string"
      ? current.value.trim() ? { kind: "title", policy: "autosave", page_id: id, title: current.value, expected: dependency } : null
      : { kind: "body", policy: "autosave", note_id: id, body_pm_json: current.value.body_pm_json, expected: dependency };
    if (current.creator === null || typeof current.value === "string" || (!explicit && !bodyHasContent(current.value))) return null;
    const publication = publicationWithBody(current.creator, current.value);
    if (publication.kind === "page") {
      const title = textEntry(`page:${publication.request.id}`)?.value;
      return { ...publication, request: { ...publication.request, title: typeof title === "string" && title.trim() ? title : "untitled" } };
    }
    if (publication.kind === "insert_note" && publication.request.source.kind === "daily_page") {
      const page = textEntry(`page:${publication.request.source.page_id}`);
      if (page?.acked === null && typeof page.value === "string" && page.value.trim()) return { ...publication, initial_title: page.value };
    }
    return publication;
  }
  if (same(current.value, current.acked.value) || typeof current.value === "string" && !current.value.trim()) return null;
  const expected: LaneDependency = { kind: "observed", ref, lane, version: current.acked.version };
  return typeof current.value === "string"
    ? { kind: "title", policy: explicit ? "explicit" : "autosave", page_id: id, title: current.value, expected }
    : { kind: "body", policy: explicit ? "explicit" : "autosave", note_id: id, body_pm_json: current.value.body_pm_json, expected };
}
function persist(ref: string, explicit: boolean): WriteHandle | null {
  ref = canonicalTextRef(ref); clearTimer(ref);
  const current = entry(ref);
  if (readWriting().paused || current.outstanding !== null) { refreshState(ref); return current.outstanding; }
  const intent = intentFor(ref, explicit);
  if (intent === null) { refreshState(ref); return null; }
  const pageRef = intent.kind === "page" ? `page:${intent.request.id}` : intent.kind === "insert_note" && intent.request.source.kind === "daily_page" ? `page:${intent.request.source.page_id}` : null;
  const authored = [snapshotText(ref)];
  if (pageRef !== null && textEntry(pageRef)) authored.push(intent.kind === "page" ? snapshotPageTitle(intent) : snapshotText(pageRef));
  return admitWriting(intent, authored);
}
export function editText(ref: string, value: TextValue, editBase?: TextEditBase, selection: { anchor: number; head: number } | null = null): void {
  if (readWriting().paused) throw new WritingDecisionError("writing is paused");
  const current = entry(ref); value = canonicalValue(value);
  let conflict = current.conflict; let acked = current.acked;
  if (editBase) {
    let original = editBase.acknowledged;
    if (current.acked !== null && same(value, current.acked.value)) original = current.acked;
    if (current.lastAccepted !== null && current.acked !== null && same(current.acked.value, editBase.value)) {
      const lane = typeof value === "string" ? "title" : "body";
      if (provenTextVersion(current.lastAccepted, canonicalTextRef(ref), lane, original?.version ?? 1) === current.acked.version) original = current.acked;
    }
    const changed = current.acked !== null && (original === null || current.acked.version !== original.version || !same(current.acked.value, original.value));
    if (!same(current.value, editBase.value) && !same(current.value, value) && dirty(current)) conflict = { origin: "local", value: current.value };
    else if (changed && current.acked) conflict = { origin: "server", ...current.acked };
    acked = original;
  }
  update(ref, { value, acked, conflict, selection, revision: current.revision + 1, autosave: true, failure: current.outstanding?.read().kind === "unconfirmed" || current.conflict !== null ? current.failure : null });
  schedule(ref);
}
export function replaceText(ref: string, value: TextValue): void {
  if (readWriting().paused) throw new WritingDecisionError("writing is paused");
  update(ref, { value: canonicalValue(value), autosave: true, failure: null }, true); schedule(ref);
}
/** Structural commands carry exact text through the same queue, without starting autosave. */
export function carryText(ref: string, value: TextValue): void {
  clearTimer(ref); update(ref, { value: canonicalValue(value) }, true);
}
export function snapshotText(ref: string): AuthoredSnapshot {
  const current = entry(ref);
  return { resource_ref: canonicalTextRef(ref), revision: current.revision, value: structuredClone(valueOf(current.value)), selection: current.selection };
}
export function snapshotPageTitle(publication: Extract<Publication, { kind: "page" }>): AuthoredSnapshot {
  const ref = `page:${publication.request.id}`; const current = entry(ref);
  if (current.acked === null && typeof current.value === "string" && !current.value.trim() && current.value !== publication.request.title) carryText(ref, publication.request.title);
  return snapshotText(ref);
}
export function textDependency(ref: string, lane: "body" | "title"): LaneDependency | null {
  const current = textEntry(ref); if (!current) return null;
  return current.acked === null ? creationDependency(canonicalTextRef(ref), lane) : captureLane(canonicalTextRef(ref), lane, current.acked.version);
}
export function textWrite(ref: string): WriteHandle | null { return textEntry(ref)?.outstanding ?? null; }
export function retryText(ref: string): void { textWrite(ref)?.retry(); }
export function acknowledgeText(ref: string, value: TextValue, version: number): void {
  if (!textEntry(ref)) { adoptText(ref, value, version); return; }
  const current = entry(ref); value = canonicalValue(value);
  if (current.acked !== null && version < current.acked.version) return;
  const clean = !dirty(current) && current.outstanding === null;
  update(ref, { acked: { value, version }, creator: null, creationIntent: false, ...(clean ? { value } : {}) }, clean && !same(current.value, value));
  refreshState(ref); watchText(ref, version);
}
export function setGone(ref: string): void { if (textEntry(ref)) { clearTimer(ref); update(ref, { gone: true }); } }
export function resetText(ref: string): void {
  const current = entry(ref);
  if (current.outstanding !== null && ["queued", "sending", "unconfirmed"].includes(current.outstanding.read().kind)) throw new WritingDecisionError("this save still needs confirmation");
  clearTimer(ref);
  if (current.acked) update(ref, { value: current.acked.value, conflict: null, failure: null }, true); else setGone(ref);
  refreshState(ref);
}
export async function resolveConflict(ref: string, keep: "mine" | "saved", shown: ConflictShown): Promise<void> {
  const current = entry(ref); const conflict = current.conflict;
  if (current.revision !== shown.revision || conflict === null || (conflict.origin === "server" ? conflict.version : current.acked?.version ?? null) !== shown.saved_version) throw new WritingDecisionError("this note changed; review the current comparison");
  if (current.outstanding !== null && current.outstanding.read().kind === "unconfirmed") throw new WritingDecisionError("copy your changes, then reload to confirm the saved version");
  const saved = conflict.origin === "server" ? conflict : current.acked;
  if (saved === null) throw new WritingDecisionError("review the saved resource before making a replacement");
  update(ref, { value: keep === "saved" ? saved.value : current.value, acked: saved, conflict: null, failure: null, outstanding: null, autosave: true }, true);
  if (keep === "mine") persist(ref, true); else refreshState(ref);
}
export function flushText(ref: string): void { if (textEntry(ref)) persist(ref, false); }
export function materializeText({ ref, body }: { ref: string; body: NoteBody }): WriteHandle | null {
  const current = entry(ref);
  if (current.outstanding !== null) return current.outstanding;
  if (current.acked !== null || current.creator === null || current.gone || current.conflict !== null) return null;
  carryText(ref, body); return persist(ref, true);
}
export function textCreationReady(ref: string): boolean { const current = textEntry(ref); return current !== undefined && !current.gone && (current.acked !== null || current.creator !== null); }
export function hasUnsavedText(ref: string): boolean { const current = textEntry(ref); return current !== undefined && dirty(current); }
export function hasUnsavedTexts(): boolean {
  return [...texts.values()].some(current => current.autosave && !(typeof current.value === "string" && current.acked === null) && (dirty(current) || current.outstanding !== null || current.failure !== null));
}
export function subscribeTexts(listener: () => void): () => void { allListeners.add(listener); return () => void allListeners.delete(listener); }
export function readText(ref: string): Text | undefined { return textEntry(ref); }
function subscribeText(ref: string, listener: () => void): () => void {
  let scoped = listeners.get(ref); if (!scoped) { scoped = new Set(); listeners.set(ref, scoped); }
  scoped.add(listener); return () => { scoped.delete(listener); if (!scoped.size) listeners.delete(ref); };
}
export function useText(ref: string): Text | undefined { return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref), () => undefined); }
export function useTextPublished(ref: string): boolean { return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.acked != null, () => false); }
export function useTextReady(ref: string): boolean { return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.ready ?? false, () => false); }
export function useTextVersion(ref: string): number | null { return useSyncExternalStore(listener => subscribeText(ref, listener), () => textEntry(ref)?.acked?.version ?? null, () => null); }
function titleOf(value: TextValue): string {
  if (typeof value === "string") return value;
  const points: string[] = []; let pendingWhitespace = false;
  for (const point of value.body_text) {
    if (point === "\n") break;
    if (/\s/.test(point)) { pendingWhitespace = points.length > 0; continue; }
    if (pendingWhitespace) points.push(" ");
    if (points.length < 513) points.push(point);
    if (points.length === 513) break;
    pendingWhitespace = false;
  }
  return points.length > 512 ? `${points.slice(0, 511).join("")}…` : points.join("");
}
export function readTextTitle(ref: string): TextTitle | null {
  const current = textEntry(ref); if (!current) return null;
  return { title: titleOf(current.value), acknowledged: current.acked && { title: titleOf(current.acked.value), version: current.acked.version }, unsettled: !current.gone && (dirty(current) || current.conflict !== null || current.outstanding !== null), gone: current.gone };
}
export function useTextTitleRevision(): number { return useSyncExternalStore(listener => { titleListeners.add(listener); return () => void titleListeners.delete(listener); }, () => titleRevision, () => 0); }
subscribeWritingAcknowledgements((ack, write) => {
  for (const note of ack.notes) {
    const ref = `note_block:${note.id}`; const current = textEntry(ref); if (!current) continue;
    const value = { body_pm_json: note.body_pm_json, body_text: note.body_text };
    if (current.outstanding === write || current.outstanding !== null && isTextPredecessor(current.outstanding, write, ref, "body")) acknowledgeText(ref, value, note.body_version); else adoptText(ref, value, note.body_version);
  }
  for (const page of ack.pages) {
    const ref = `page:${page.id}`; const current = textEntry(ref); if (!current) continue;
    if (current.outstanding === write || current.outstanding !== null && isTextPredecessor(current.outstanding, write, ref, "title")) acknowledgeText(ref, page.title, page.title_version); else adoptText(ref, page.title, page.title_version);
  }
  for (const ref of ack.deleted_refs) setGone(ref);
});
subscribeWritingAdmissions((write, snapshots) => {
  const captured = accountGeneration;
  for (const snapshot of snapshots) {
    const ref = snapshot.resource_ref; if (!textEntry(ref)) continue;
    clearTimer(ref); update(ref, { outstanding: write, creationIntent: entry(ref).creationIntent || entry(ref).acked === null, failure: null }); refreshState(ref);
    const inspect = () => {
      if (captured !== accountGeneration || textEntry(ref)?.outstanding !== write) return;
      const state = write.read();
      if (state.kind === "unconfirmed") update(ref, { failure: { error: state.error, requestId: isApiError(state.error) ? state.error.requestId : undefined, irreducible: !canRetryWriting(write) } });
      else if (state.kind === "queued" || state.kind === "sending") update(ref, { failure: null });
      refreshState(ref);
    };
    const unsubscribe = write.subscribe(inspect);
    void write.settled.then(() => {
      unsubscribe(); if (captured !== accountGeneration || textEntry(ref)?.outstanding !== write) return;
      update(ref, { outstanding: null, lastAccepted: write, failure: null });
      if (entry(ref).autosave && dirty(entry(ref))) schedule(ref); else refreshState(ref);
    }, error => {
      unsubscribe(); if (captured !== accountGeneration || textEntry(ref)?.outstanding !== write) return;
      let conflict = entry(ref).conflict;
      if (isApiError(error) && (error.code === "E_NOTE_CONFLICT" || error.code === "E_RESOURCE_CONFLICT")) {
        const saved = error.details?.current;
        if (saved !== null && typeof saved === "object") {
          const value = saved as Record<string, unknown>; // justify-type-assertion: api details are an untrusted object, narrowed field by field.
          if (typeof value.body_version === "number" && value.body_pm_json !== undefined) conflict = { origin: "server", value: parseBody(value.body_pm_json), version: value.body_version };
          else if (typeof value.title_version === "number" && typeof value.title === "string") conflict = { origin: "server", value: value.title, version: value.title_version };
        }
      }
      const gone = isApiError(error) && ["E_NOT_FOUND", "E_WRITING_DEPENDENCY_GONE"].includes(error.code);
      update(ref, { outstanding: null, conflict, gone: entry(ref).gone || gone, failure: { error, requestId: isApiError(error) ? error.requestId : undefined, irreducible: false } }); refreshState(ref);
    });
  }
});
subscribeWritingBindings(bindings => {
  for (const binding of bindings) {
    const incoming = textEntry(binding.from_ref); const previous = textEntry(binding.to_ref);
    clearTimer(binding.from_ref);
    const oldWatch = watches.get(binding.from_ref);
    if (oldWatch) { oldWatch.controller?.abort(); oldWatch.watch.stop(); watches.delete(binding.from_ref); }
    aliases.set(binding.from_ref, binding.to_ref);
    for (const [alias, target] of aliases) if (target === binding.from_ref) aliases.set(alias, binding.to_ref);
    if (incoming) {
      texts.delete(binding.from_ref);
      const conflict = previous && previous !== incoming && dirty(previous) && !same(previous.value, incoming.value) ? { origin: "local" as const, value: previous.value } : incoming.conflict;
      const retained = binding.retained;
      texts.set(binding.to_ref, { ...incoming, conflict: retained && !retained.historical_body_matches ? { origin: "server", value: parseBody(retained.body_pm_json), version: retained.version } : conflict,
        ...(retained ? { acked: { value: parseBody(retained.body_pm_json), version: retained.version } } : {}) });
    }
    emit(binding.from_ref); emit(binding.to_ref);
  }
});
subscribeWriting(() => {
  if (accountGeneration !== readWriting().generation) {
    accountGeneration = readWriting().generation;
    for (const timer of timers.values()) clearTimeout(timer.timer); timers.clear();
    for (const owner of watches.values()) { owner.controller?.abort(); owner.watch.stop(); } watches.clear();
    const refs = [...texts.keys(), ...aliases.keys()]; texts.clear(); aliases.clear(); for (const ref of refs) emit(ref);
    titleRevision += 1; for (const listener of titleListeners) listener(); return;
  }
  if (!readWriting().paused) for (const [ref, current] of texts) if (current.autosave && dirty(current) && current.outstanding === null && !timers.has(ref)) schedule(ref);
});
if (typeof document !== "undefined") {
  const flush = () => { for (const [ref, current] of texts) if (current.autosave) flushText(ref); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}
