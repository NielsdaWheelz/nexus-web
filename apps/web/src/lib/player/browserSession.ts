/**
 * This device's durable browser queue. Every write replaces absolute state at an
 * exact revision. A lost answer retains the identical request and blocks later
 * edits; retry resends it, including terminal consumption, without rebasing.
 * Knowledge begins with a successful read or acknowledged save; failed reads
 * retain the last confirmed state, and the first one's error stands as `unread`
 * until a read lands. A first refused write keeps nothing. A refused replay retains its
 * original uncertainty until acceptance or an authoritative identity/revision fence proves
 * it cannot still apply. Equal queue state alone cannot confirm terminal consumption.
 * `unanswered` counts recovery attempts for the retained unanswered write.
 * Only the account's Web Lock holder may call this owner.
 */
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, outcomeUnknown, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { transportOf } from "@/lib/api/failure";
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
  let unanswered = 0;
  const publish = () => changed();
  const load = async () => (await readSharedValue({ accountId, key: "/me/playback-session", signal: new AbortController().signal, timeoutMs: 5_000, invalidate: true,
    load: signal => apiFetch<ApiJson<"/me/playback-session", "get">>("/api/me/playback-session", { signal, cache: "no-store" }) })).data;
  const read = async () => {
    if (pending !== null) throw new QueueCommandError("Unsettled");
    try {
      const current = await load();
      if (saved?.state.queue_id !== current?.state.queue_id || saved?.revision !== current?.revision) previous = null;
      saved = current;
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
      unanswered = 0;
      phase = "Ready";
      publish();
      return saved;
    } catch (cause) {
      handleUnauthenticatedApiError(cause);
      const stayUnanswered = () => {
        unanswered += 1;
        phase = "Uncertain";
        publish();
      };
      if (isAbortError(cause) || outcomeUnknown(cause)) {
        stayUnanswered();
        throw new QueueCommandError("Unsettled");
      }
      if (!isRefusal(cause)) {
        stayUnanswered();
        throw cause;
      }
      const answered = transportOf(cause) === "Refused";
      if (unanswered > 0) {
        if (cause.status === 409) {
          let current: Session | null;
          try { current = await load(); }
          catch (error) {
            handleUnauthenticatedApiError(error);
            stayUnanswered();
            throw error;
          }
          const desired = request.state;
          const sameState = current !== null && current.state.queue_id === desired.queue_id &&
            current.state.current_entry_id === desired.current_entry_id && current.state.entries.length === desired.entries.length &&
            current.state.entries.every((entry, index) => entry.id === desired.entries[index].id && entry.media_id === desired.entries[index].media_id);
          // A different identity or advanced incompatible revision fences the old CAS. An
          // unchanged head, absence or equal terminal queue cannot settle the original send.
          if (current !== null && (current.id !== request.id || current.revision !== request.expected_revision && !sameState)) {
            saved = current;
            known = true;
            unread = null;
            previous = null;
            pending = null;
            frozenBody = null;
            pendingPrevious = null;
            unanswered = 0;
            phase = "Ready";
            publish();
            throw new QueueCommandError("Changed");
          }
        }
        stayUnanswered();
        throw cause;
      }
      pending = null;
      frozenBody = null;
      pendingPrevious = null;
      unanswered = 0;
      phase = "Ready";
      publish();
      if (!answered) throw cause;
      if (cause.code === "E_LIMIT") throw new QueueCommandError("TooMany");
      if (cause.status !== 409) throw new QueueCommandError("Refused");
      // A generic conflict proves no change. Read current state without reapplying the refusal.
      await read();
      throw new QueueCommandError("Refused");
    }
  };
  return {
    snapshot: () => ({ saved, known, phase, unread, canRestore: previous !== null, unanswered }),
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
