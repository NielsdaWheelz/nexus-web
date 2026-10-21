"use client";

/**
 * One account-wide fifo drainer, serialized across tabs by a web lock. Requests
 * seal in indexeddb before transport and retry exactly those bytes. Unknown
 * outcomes fence later work; definitive refusals park causal dependents only.
 * Presentation listeners run after the acknowledgement transaction and cannot
 * govern delivery, settlement or retries.
 */
import { useSyncExternalStore } from "react";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiPath } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  WritingDecisionError, failWritingStorage, parkWriting, readWriting,
  assertWritingRuntimeToken, type WritingRuntimeToken,
  runWritingAttempt, settleWriting, subscribeWriting, updateOutbox,
  type Dispatch, type LaneDependency, type OutboxRow, type WritingCommand,
  type WritingIntent, type WritingPosition, type WritingAck,
} from "./journal";

export type WriteStatus = "idle" | "saving" | "retrying";
const REQUEST_DEADLINE_MS = 30_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const REJECTIONS = new Set([
  "E_FORBIDDEN", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND", "E_INVALID_REQUEST",
  "E_INVALID_KIND", "E_NOTE_CONFLICT", "E_RESOURCE_CONFLICT", "E_CONTEXT_CHANGED",
  "E_READER_CONTENT_CHANGED", "E_READER_STATE_CONFLICT", "E_MEDIA_NOT_READY",
  "E_MEDIA_NOT_FOUND", "E_MEDIA_DELETING", "E_HIGHLIGHT_INVALID_RANGE",
  "E_HIGHLIGHT_CONFLICT", "E_LINK_SELF", "E_LINK_CAPABILITY",
  "E_LINK_TARGET_AMBIGUOUS", "E_LINK_TARGET_STALE", "E_WRITING_DEPENDENCY_GONE",
  "E_WRITING_IDENTITY_REUSED", "E_WRITING_IDENTITY_CONFLICT",
]);
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let status: WriteStatus = "idle";
const listeners = new Set<() => void>();

export function isWriteRejection(error: unknown): boolean {
  return error instanceof WritingDecisionError ||
    (isApiError(error) && !isSameSystemApiDefect(error) && error.status >= 400 && error.status < 500 && REJECTIONS.has(error.code));
}
function version(value: LaneDependency): number {
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
function freeze(intent: WritingIntent): Extract<Dispatch, { kind: "sealed" }> {
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
    case "attach_link": method = "PUT"; path = `/api/resource-graph/links/${intent.link_id}/note`; body = intent.request; break;
    case "detach_highlight": method = "DELETE"; path = `/api/highlights/${intent.highlight_id}/note/${intent.note_id}?link_id=${intent.link_id}`; break;
    case "detach_link": method = "DELETE"; path = `/api/resource-graph/links/${intent.link_id}/note/${intent.note_id}?source_link_id=${intent.source_link_id}&target_link_id=${intent.target_link_id}`; break;
    case "highlight_update": method = "PATCH"; path = `/api/highlights/${intent.highlight_id}`; body = intent.request; break;
    case "highlight_delete": method = "DELETE"; path = `/api/highlights/${intent.highlight_id}`; break;
    case "highlight_note_delete": method = "POST"; path = `/api/highlights/${intent.highlight_id}/note/delete`; body = intent.request; break;
    case "resource_delete": method = "DELETE"; path = `/api/notes/pages/${intent.resource_id}`; break;
  }
  return { kind: "sealed", method, path, body_json: body === null ? null : JSON.stringify(body), wire_revision: WIRE_REVISION };
}
function publish(next: WriteStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) {
    try { listener(); } catch (error) { reportError(error); }
  }
}
function head(): OutboxRow | null {
  for (const row of readWriting().outbox) {
    if (row.blocked === null || row.uncertain) return row;
  }
  return null;
}
function delayFor(row: OutboxRow): number {
  return Math.max(0, row.dispatch_after - Date.now(), (row.retry_at ?? 0) - Date.now());
}
async function attempt(row: OutboxRow, signal: AbortSignal): Promise<void> {
  const priorUncertainty = row.dispatch.kind === "sealed" || row.uncertain;
  if (row.dispatch.kind === "sealed" && !row.uncertain) {
    const restored = await updateOutbox({ ...row, uncertain: true });
    if (restored === null) return;
    row = restored;
  }
  if (row.dispatch.kind === "unsealed") {
    let dispatch: Extract<Dispatch, { kind: "sealed" }>;
    try { dispatch = freeze(row.intent); }
    catch (error) {
      if (!(error instanceof WritingDecisionError)) throw error;
      await parkWriting(row, { code: "E_WRITING_DEPENDENCY_REVIEW", request_id: null, current: error.message }, true); return;
    }
    const sealed = await updateOutbox({ ...row, dispatch });
    if (sealed === null) return;
    row = sealed;
  }
  if (row.dispatch.kind !== "sealed") return;
  if (row.dispatch.wire_revision !== WIRE_REVISION) {
    await parkWriting(row, { code: "E_WIRE_MISMATCH", request_id: null, current: null }, false); return;
  }
  publish("saving");
  const deadline = new AbortController();
  const abort = () => deadline.abort();
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_DEADLINE_MS);
  let ack: WritingAck;
  try {
    const reply = await apiFetch<ApiJson<"/resource-graph/commands", "post">>(row.dispatch.path, {
      method: row.dispatch.method, body: row.dispatch.body_json, signal: deadline.signal,
    });
    ack = reply.data;
  } catch (error) {
    const failure = { code: isApiError(error) ? error.code : "E_WRITING_UNCONFIRMED", request_id: isApiError(error) ? error.requestId ?? null : null, current: isApiError(error) ? error.details?.current ?? null : null };
    if (isApiError(error) && (error.status === 401 || error.code === "E_WIRE_MISMATCH")) {
      await parkWriting(row, failure, false); return;
    }
    if (!priorUncertainty && isWriteRejection(error)) { await parkWriting(row, failure, true); return; }
    const transient = isApiError(error) && [0, 429, 502, 503, 504].includes(error.status);
    if (transient || deadline.signal.aborted) {
      const backoff = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Date.now() - row.first_admitted_at));
      const retryAfter = isApiError(error) ? error.retryAfterMs ?? 0 : 0;
      const delay = Math.max(retryAfter, RETRY_MIN_MS, Math.round(backoff * (0.5 + Math.random() * 0.5)));
      await updateOutbox({ ...row, uncertain: true, retry_at: Date.now() + delay });
    } else await parkWriting(row, failure, false);
    publish("retrying"); return;
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  await settleWriting(row, ack);
}
async function pump(signingOut = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (true) {
      const state = readWriting();
      const next = head();
      if ((!signingOut && state.paused) || state.storage_error !== null || state.incompatible.length > 0 || next === null) break;
      if (next.blocked !== null || (typeof navigator !== "undefined" && !navigator.onLine)) { publish("retrying"); break; }
      const delay = signingOut ? 0 : delayFor(next);
      if (delay > 0) break;
      let advanced = false;
      await runWritingAttempt(async signal => {
        const current = head();
        if (!current || current.blocked !== null || (!signingOut && delayFor(current) > 0)) return;
        advanced = true; await attempt(current, signal);
      }, signingOut);
      if (!advanced) break;
      const remaining = head();
      if (remaining?.intent_id === next.intent_id) break;
    }
  } catch (error) { failWritingStorage(error); }
  finally {
    running = false;
    if (head() === null) publish("idle");
    const next = head();
    if (!signingOut && next !== null && next.blocked === null && delayFor(next) > 0 && !readWriting().paused)
      timer = setTimeout(nudgeWrites, delayFor(next));
  }
}
export function nudgeWrites(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  void pump();
}
export async function syncForSignOut(token: WritingRuntimeToken): Promise<void> {
  assertWritingRuntimeToken(token); await pump(true); assertWritingRuntimeToken(token);
}
export function writesPending(): boolean { return readWriting().outbox.length > 0; }
export function useWriteStatus(): WriteStatus {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => void listeners.delete(listener); }, () => status, () => "idle");
}
subscribeWriting(nudgeWrites);
if (typeof window !== "undefined") {
  window.addEventListener("online", nudgeWrites);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudgeWrites(); });
}
