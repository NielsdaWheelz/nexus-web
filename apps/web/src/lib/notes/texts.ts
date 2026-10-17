"use client";

// The tab's unsaved writing: one in-memory text per note body (`note_block:{id}`, a
// NoteBody) or page title (`page:{id}`, a string), shared by every editor showing it.
// `value` is what editors show; `acked` the last value the server confirmed (null until
// the note exists); `revision` bumps whenever the value changes other than by its own
// editor. A change saves 1.5 s after the last one and at once when the tab hides; a
// save is one set_body / set_title (or the creator's request for a note not yet made)
// through the write queue, with the acked version as its expectation; an acknowledgement
// publishes "Notes". A 409 parks the server's value in `conflict` until the user keeps
// theirs or takes the saved one; any other refusal marks it `failed` until its next save.
import { useSyncExternalStore } from "react";
import { isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { bodyHasContent, sameBody, type NoteBody } from "@/lib/notes/noteBody";
import {
  enqueueWrite,
  nudgeWrites,
  writesPending,
  type WriteRequest,
} from "@/lib/notes/writes";

export type TextValue = NoteBody | string;
interface Saved {
  readonly value: TextValue;
  readonly version: number;
}

/** How a note that does not exist yet is made by its first non-empty save. */
export interface Creator {
  request(value: NoteBody): WriteRequest;
  /** The created note's body version, from the reply. */
  settle(reply: unknown): number;
}

export interface Text {
  readonly value: TextValue;
  readonly revision: number;
  readonly acked: Saved | null;
  readonly conflict: Saved | null;
  readonly failed: boolean;
}

interface Entry extends Text {
  readonly creator: Creator | null;
  readonly gone: boolean;
  readonly timer: number | null;
  readonly queued: boolean;
}

const SAVE_DELAY_MS = 1500;
const texts = new Map<string, Entry>();
const listeners = new Set<() => void>();
let titleRevision = 0;
let installed = false;
let report: (error: unknown) => void = () => undefined;

const same = (a: TextValue, b: TextValue) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : sameBody(a, b);

function entry(ref: string): Entry {
  const found = texts.get(ref);
  // justify-defect: editors only write texts their outline or editor opened.
  if (!found) throw new Error(`No text is open for ${ref}`);
  return found;
}

function update(ref: string, patch: Partial<Entry>, external = false): void {
  const current = entry(ref);
  const revision = current.revision + (external ? 1 : 0);
  texts.set(ref, { ...current, ...patch, revision });
  notifyTexts();
}

function notifyTexts(): void {
  titleRevision += 1;
  for (const listener of listeners) listener();
}

function dirty(text: Entry): boolean {
  if (text.gone) return false;
  if (text.acked === null) {
    return (
      text.creator !== null &&
      typeof text.value !== "string" &&
      bodyHasContent(text.value)
    );
  }
  return !same(text.value, text.acked.value);
}

/** Seed or refresh a text from the server; a text with local changes keeps them. */
export function adoptText(
  ref: string,
  value: TextValue,
  version: number | null,
): void {
  install();
  const acked = version === null ? null : { value, version };
  const current = texts.get(ref);
  if (!current) {
    texts.set(ref, {
      value,
      revision: 0,
      acked,
      conflict: null,
      failed: false,
      creator: null,
      gone: false,
      timer: null,
      queued: false,
    });
    notifyTexts();
    return;
  }
  if (acked && current.acked && acked.version < current.acked.version) return;
  // Local changes keep the version they were based on, so their save 409s on a newer one.
  if (dirty(current)) return;
  const replace = !same(current.value, value);
  update(ref, { acked: acked ?? current.acked, gone: false, value }, replace);
}

/** A note made here: shown at once and saved by its creator; with no creator, the
 * structure edit that inserts it carries it and acknowledges it. */
export function createText(
  ref: string,
  value: NoteBody,
  creator: Creator | null,
): void {
  if (!texts.has(ref)) adoptText(ref, value, null);
  update(ref, { value, creator, gone: false }, true);
}

/** A new note's creator becomes known (a highlight finished being created). */
export function setCreator(ref: string, creator: Creator): void {
  update(ref, { creator });
  if (dirty(entry(ref))) schedule(ref, 0);
}

/** The text's own editor changed it: shown as is, saved after a pause. */
export function editText(ref: string, value: TextValue): void {
  update(ref, { value });
  schedule(ref, SAVE_DELAY_MS);
}

/** Changed for its editors (undo, a conflict choice, a rollback): they re-render it. */
export function replaceText(ref: string, value: TextValue): void {
  update(ref, { value }, true);
  schedule(ref, SAVE_DELAY_MS);
}

/** A structure edit carries this value: its reply acknowledges it, no save of its own. */
export function carryText(ref: string, value: TextValue): void {
  const { timer } = entry(ref);
  if (timer !== null) window.clearTimeout(timer);
  update(ref, { value, timer: null }, true);
}

/** The server confirmed `value` at `version`. */
export function acknowledgeText(
  ref: string,
  value: TextValue,
  version: number,
): void {
  update(ref, { acked: { value, version }, creator: null, gone: false, failed: false });
  publishChange("Notes");
}

/** A deleted note stops saving until an undo recreates it (`createText`). */
export function setGone(ref: string): void {
  const current = texts.get(ref);
  if (!current) return;
  if (current.timer !== null) window.clearTimeout(current.timer);
  update(ref, { gone: true, timer: null });
}

/** A refused write's text: its acked value, unsaved (gone if it never existed). */
export function resetText(ref: string): void {
  const { acked, timer } = entry(ref);
  if (timer !== null) window.clearTimeout(timer);
  const reset = acked ? { value: acked.value } : { gone: true };
  update(ref, { ...reset, timer: null, failed: false }, true);
}

export function resolveConflict(ref: string, keep: "mine" | "saved"): void {
  const { conflict } = entry(ref);
  if (!conflict) return;
  const value = keep === "saved" ? { value: conflict.value } : {};
  update(ref, { acked: conflict, conflict: null, ...value }, keep === "saved");
  schedule(ref, 0);
}

/** Save now what is waiting (a title losing focus). */
export function flushText(ref: string): void {
  if (texts.get(ref)?.timer != null) schedule(ref, 0);
}

export function readText(ref: string): Text | undefined {
  return texts.get(ref);
}

export function useText(ref: string): Text | undefined {
  return useSyncExternalStore(
    subscribe,
    () => texts.get(ref),
    () => undefined,
  );
}

export interface TextTitle {
  readonly title: string;
  readonly acknowledged: { readonly title: string; readonly version: number } | null;
  readonly unsettled: boolean;
  readonly gone: boolean;
}

function titleOf(value: TextValue): string {
  if (typeof value === "string") return value;
  const text = collapseWhitespace(value.body_text.split("\n")[0]!);
  const points = Array.from(text);
  return points.length > 512 ? `${points.slice(0, 511).join("")}…` : text;
}

/** Read-only title evidence; the text owner alone classifies unsettled writing. */
export function readTextTitle(ref: string): TextTitle | null {
  const text = texts.get(ref);
  if (!text) return null;
  return {
    title: titleOf(text.value),
    acknowledged: text.acked && { title: titleOf(text.acked.value), version: text.acked.version },
    unsettled: !text.gone && (text.acked === null || dirty(text) || text.conflict !== null || text.timer !== null || text.queued),
    gone: text.gone,
  };
}

/** One workspace subscription, including edits that do not move editor revision. */
export function useTextTitleRevision(): number {
  return useSyncExternalStore(subscribe, () => titleRevision, () => 0);
}

/** The shell's hud for a save the server refused for good. */
export function setTextFailureReporter(next: (error: unknown) => void): void {
  report = next;
}

function unsaved(): boolean {
  if (writesPending()) return true;
  for (const text of texts.values()) {
    if (!text.gone && (text.conflict || text.timer !== null || dirty(text)))
      return true;
  }
  return false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function schedule(ref: string, delay: number): void {
  const current = entry(ref);
  if (current.timer !== null) window.clearTimeout(current.timer);
  if (current.gone) return;
  const timer = window.setTimeout(() => {
    update(ref, { timer: null });
    if (!entry(ref).queued) enqueueSave(ref);
  }, delay);
  update(ref, { timer, failed: false });
}

/** Save every waiting text now, inside this event handler (hide, pagehide). */
function flushAll(): void {
  for (const [ref, text] of texts) {
    if (text.timer === null) continue;
    window.clearTimeout(text.timer);
    update(ref, { timer: null });
    if (!text.queued) enqueueSave(ref);
  }
}

function enqueueSave(ref: string): void {
  update(ref, { queued: true });
  let sent: TextValue;
  let creator: Creator | null = null;
  enqueueWrite<unknown>({
    build() {
      update(ref, { queued: false });
      const text = entry(ref);
      sent = text.value;
      if (text.gone || text.conflict) return null;
      if (text.acked === null) {
        creator = text.creator;
        return creator && dirty(text) && typeof sent !== "string"
          ? creator.request(sent)
          : null;
      }
      // a blank title stays local until it has text again (titles are 1..200 characters).
      if (same(sent, text.acked.value) || (typeof sent === "string" && !sent.trim())) return null;
      const id = ref.slice(ref.indexOf(":") + 1);
      const expected_version = text.acked.version;
      const command =
        typeof sent === "string"
          ? { kind: "set_title", page_id: id, title: sent, expected_version }
          : {
              kind: "set_body",
              note_id: id,
              body_pm_json: sent.body_pm_json,
              expected_version,
            };
      return {
        path: "/api/notes/outline/commands",
        method: "POST",
        body: { commands: [command] },
      };
    },
    settle(reply) {
      if (creator) return acknowledgeText(ref, sent, creator.settle(reply));
      // justify-type-assertion: the commands route answers OutlineCommandsOut.
      const nodes = (reply as Schema<"OutlineCommandsOut">).nodes;
      const content = nodes.find((node) => node.ref === ref)?.content;
      if (content?.kind === "note") acknowledgeText(ref, sent, content.body_version);
      if (content?.kind !== "page") return;
      acknowledgeText(ref, sent, content.title_version);
    },
    fail(error) {
      const current = isApiError(error) && error.status === 409 ? error.details?.current : null;
      if (current && typeof current === "object") {
        // justify-type-assertion: a 409 on a text carries its NoteBlockOut or title.
        const saved = current as Partial<Schema<"NoteBlockOut">> & {
          title?: string;
          title_version?: number;
        };
        const conflict =
          saved.title !== undefined
            ? { value: saved.title, version: saved.title_version! }
            : {
                value: {
                  body_pm_json: saved.body_pm_json!,
                  body_text: saved.body_text!,
                },
                version: saved.body_version!,
              };
        return update(ref, { conflict });
      }
      update(ref, { failed: true });
      report(error);
    },
  });
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
    else nudgeWrites();
  });
  window.addEventListener("pagehide", flushAll);
  window.addEventListener("online", nudgeWrites);
  window.addEventListener("beforeunload", (event) => {
    if (unsaved()) event.preventDefault();
  });
}
