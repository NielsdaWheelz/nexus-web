/**
 * This device's durable browser queue. Every write replaces absolute state at an
 * exact revision. A lost answer retains the identical request and blocks later
 * edits; check resends it, including terminal consumption, without rebasing.
 * Knowledge begins with a successful read or acknowledged save; failed reads
 * retain the last confirmed state, and the first one's error stands as `unread`
 * until a read lands. A refused write throws its refusal and keeps nothing.
 * Only the account's Web Lock holder may call this owner.
 */
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, isUnauthenticatedApiError, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { readSharedValue } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { QueueCommandError, type QueueRequest, type QueueState } from "@/lib/player/queue";

type Session = Schema<"BrowserSessionOut">;
type Put = Schema<"PutPlaybackSessionRequest">;
export type QueueTerminal = Schema<"TerminalEnd">;
export type QueueSavePhase = "Ready" | "Preparing" | "Saving" | "Uncertain" | "Unavailable";

export function createBrowserSession(accountId: string, changed: () => void) {
  let saved: Session | null = null;
  let known = false;
  let pending: Put | null = null;
  let frozenBody: string | null = null;
  let pendingPrevious: QueueState | null = null;
  let phase: QueueSavePhase = "Ready";
  let unread: ApiError | null = null;
  let previous: QueueState | null = null;
  const publish = () => changed();
  const read = async () => {
    if (pending !== null) throw new QueueCommandError("Unsettled");
    try {
      const response = await readSharedValue({ accountId, key: "/me/playback-session", signal: new AbortController().signal, timeoutMs: 5_000, invalidate: true,
        load: signal => apiFetch<ApiJson<"/me/playback-session", "get">>("/api/me/playback-session", { signal, cache: "no-store" }) });
      if (saved?.state.queue_id !== response.data?.state.queue_id || saved?.revision !== response.data?.revision) previous = null;
      saved = response.data;
      known = true;
      unread = null;
      phase = "Ready";
      publish();
      return saved;
    } catch (cause) {
      handleUnauthenticatedApiError(cause);
      if (!known && isApiError(cause) && !isSameSystemApiDefect(cause)) {
        unread = cause;
        publish();
      }
      throw cause;
    }
  };
  const send = async () => {
    const request = pending;
    if (request === null) return saved;
    phase = "Saving";
    publish();
    try {
      const response = await requestWithDeadline({ signal: new AbortController().signal, timeoutMs: 5_000,
        request: signal => apiFetch<ApiJson<"/me/playback-session", "put">>("/api/me/playback-session", {
          method: "PUT", signal, body: frozenBody,
        }) });
      saved = response.data;
      known = true;
      previous = pendingPrevious;
      pendingPrevious = null;
      pending = null;
      frozenBody = null;
      phase = "Ready";
      publish();
      return saved;
    } catch (cause) {
      if (isUnauthenticatedApiError(cause)) {
        handleUnauthenticatedApiError(cause);
        throw cause;
      }
      if (isSameSystemApiDefect(cause) || (!isApiError(cause) && !isAbortError(cause))) {
        phase = "Uncertain";
        publish();
        throw cause;
      }
      if (!isRefusal(cause)) {
        phase = "Uncertain";
        publish();
        throw new QueueCommandError("Unsettled");
      }
      pending = null;
      frozenBody = null;
      pendingPrevious = null;
      phase = "Ready";
      publish();
      if (cause.code === "E_LIMIT") throw new QueueCommandError("TooMany");
      if (cause.status !== 409) throw new QueueCommandError("Refused");
      // Refresh reports the other writer's result. The refused command is never reapplied.
      await read();
      throw new QueueCommandError("Changed");
    }
  };
  return {
    snapshot: () => ({ saved, known, phase, unread, canRestore: previous !== null }),
    read,
    async save(state: QueueState, terminal: QueueTerminal | null = null, replacement = false) {
      if (pending !== null) throw new QueueCommandError("Unsettled");
      const before = saved?.state ?? null;
      pendingPrevious = replacement && before !== null && before.entries.length > 0 ? before : null;
      pending = { id: saved?.id ?? crypto.randomUUID(), expected_revision: saved?.revision ?? null, state, terminal };
      frozenBody = JSON.stringify(pending);
      const result = await send();
      publish();
      return result;
    },
    check: () => pending === null ? read() : send(),
    async restore(request: QueueRequest) {
      if (pending !== null) throw new QueueCommandError("Unsettled");
      if (saved?.state.queue_id !== request.queue_id || saved.revision !== request.expected_revision || previous === null)
        throw new QueueCommandError("Changed");
      const state = { ...previous, queue_id: crypto.randomUUID() };
      pendingPrevious = null;
      pending = { id: saved?.id ?? crypto.randomUUID(), expected_revision: saved?.revision ?? null, state, terminal: null };
      frozenBody = JSON.stringify(pending);
      return send();
    },
    preparing(on: boolean) { phase = on ? "Preparing" : pending === null ? "Ready" : "Saving"; publish(); },
    uncertain: () => pending !== null,
  };
}
