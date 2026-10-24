/**
 * This device's durable browser queue. Every write replaces absolute state at an
 * exact revision. A lost answer retains the identical request and blocks later
 * edits; check resends it, including terminal consumption, without rebasing.
 * Knowledge begins with a successful read or acknowledged save; failed reads
 * retain the last confirmed state. Only the account's Web Lock holder may call this owner.
 */
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, isUnauthenticatedApiError, requestWithDeadline } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { readSharedValue } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { QueueCommandError, type QueueState } from "@/lib/player/queue";

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
  let error: string | null = null;
  let previous: QueueState | null = null;
  const publish = () => changed();
  const read = async () => {
    if (pending !== null) throw new QueueCommandError("couldn’t confirm queue change");
    try {
      const response = await requestWithDeadline({ signal: new AbortController().signal, timeoutMs: 5_000,
        request: signal => readSharedValue({ accountId, key: "playback-session", signal, revalidate: true,
          load: requestSignal => apiFetch<ApiJson<"/me/playback-session", "get">>("/api/me/playback-session", { signal: requestSignal, cache: "no-store" }) }) });
      saved = response.data;
      known = true;
      previous = null;
      error = null;
      phase = "Ready";
      publish();
      return saved;
    } catch (cause) {
      handleUnauthenticatedApiError(cause);
      throw cause;
    }
  };
  const send = async () => {
    const request = pending;
    if (request === null) return saved;
    phase = "Saving";
    error = null;
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
      if (isRefusal(cause)) {
        pending = null;
        frozenBody = null;
        pendingPrevious = null;
        phase = "Ready";
        error = isApiError(cause) && cause.code === "E_LIMIT" ? "too many episodes; narrow this view" : "queue changed; check before trying again";
        if (isApiError(cause) && cause.status === 409) {
          // Refresh reports the other writer's result. The refused command is never reapplied.
          await read();
          error = "queue changed; try again";
        }
      } else {
        phase = "Uncertain";
        error = "couldn’t confirm queue change";
      }
      publish();
      if (isSameSystemApiDefect(cause) || (!isApiError(cause) && !isAbortError(cause))) throw cause;
      throw new QueueCommandError(error ?? "couldn’t save queue change");
    }
  };
  return {
    snapshot: () => ({ saved, known, phase, error, canRestore: previous !== null }),
    read,
    async save(state: QueueState, terminal: QueueTerminal | null = null, replacement = false) {
      if (pending !== null) throw new QueueCommandError("couldn’t confirm queue change");
      const before = saved?.state ?? null;
      previous = null;
      pendingPrevious = replacement ? before : null;
      pending = { id: saved?.id ?? crypto.randomUUID(), expected_revision: saved?.revision ?? null, state, terminal };
      frozenBody = JSON.stringify(pending);
      const result = await send();
      publish();
      return result;
    },
    check: () => pending === null ? read() : send(),
    async restore() {
      if (previous === null) return saved;
      const state = { ...previous, queue_id: crypto.randomUUID() };
      previous = null;
      pendingPrevious = null;
      pending = { id: saved?.id ?? crypto.randomUUID(), expected_revision: saved?.revision ?? null, state, terminal: null };
      frozenBody = JSON.stringify(pending);
      return send();
    },
    preparing(on: boolean) { phase = on ? "Preparing" : pending === null ? "Ready" : "Saving"; if (known) error = null; publish(); },
    uncertain: () => pending !== null,
  };
}
