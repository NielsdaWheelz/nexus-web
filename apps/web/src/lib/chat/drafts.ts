"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { isRecord } from "@/lib/validation";
import { decodeSelectionDraft, type SelectionDraft } from "./selection";
import {
  chatFailure,
  type AcceptedReceipt,
  type ChatFailure,
  type RejectionCode,
  type RunCreateRequest,
} from "./wire";

// One draft per (account, conversation | "new") in this tab's sessionStorage.
// A send is written here before its POST and leaves only with a receipt or a
// definite rejection, so a lost response replays the same key and bytes.

export type PendingSend = Readonly<{ key: string; request: RunCreateRequest }>;
export type Draft = Readonly<{
  text: string;
  selection: SelectionDraft;
  pending: PendingSend | null;
}>;
export type SendOutcome =
  | { kind: "Accepted"; receipt: AcceptedReceipt }
  | { kind: "Rejected"; code: RejectionCode }
  | { kind: "Failed"; failure: ChatFailure };

const PREFIX = "nx_chat_draft.v6:";
const EMPTY: Draft = {
  text: "",
  selection: { kind: "Uninitialized" },
  pending: null,
};
const listeners = new Map<string, Set<() => void>>();
const decoded = new Map<string, { raw: string | null; draft: Draft }>();
const inFlight = new Map<string, Promise<SendOutcome>>();

function decode(storageKey: string, raw: string): Draft {
  try {
    const value: unknown = JSON.parse(raw);
    const selection = isRecord(value)
      ? decodeSelectionDraft(value.selection)
      : null;
    if (isRecord(value) && typeof value.text === "string" && selection) {
      const pending = value.pending;
      if (pending === null)
        return { text: value.text, selection, pending: null };
      if (
        isRecord(pending) &&
        typeof pending.key === "string" &&
        pending.key.length >= 1 &&
        pending.key.length <= 128 &&
        isRecord(pending.request)
      )
        return {
          text: value.text,
          selection,
          // justify-type-assertion: replayed verbatim; the server owns its validation.
          pending: {
            key: pending.key,
            request: pending.request as RunCreateRequest,
          },
        };
    }
  } catch {
    // an unparseable record is discarded below, like an unreadable one
  }
  console.error("Discarding an unreadable chat draft", storageKey);
  window.sessionStorage.removeItem(storageKey);
  return EMPTY;
}

function read(storageKey: string): Draft {
  const raw = window.sessionStorage.getItem(storageKey);
  const cached = decoded.get(storageKey);
  if (cached?.raw === raw) return cached.draft;
  const draft = raw === null ? EMPTY : decode(storageKey, raw);
  decoded.set(storageKey, {
    raw: window.sessionStorage.getItem(storageKey),
    draft,
  });
  return draft;
}

function notify(storageKey: string): void {
  for (const listener of listeners.get(storageKey) ?? []) listener();
}

function write(storageKey: string, draft: Draft): void {
  const empty =
    !draft.text && !draft.pending && draft.selection.kind === "Uninitialized";
  if (empty) window.sessionStorage.removeItem(storageKey);
  else window.sessionStorage.setItem(storageKey, JSON.stringify(draft));
  notify(storageKey);
}

function post(
  storageKey: string,
  pending: PendingSend,
  keepSelection: boolean,
): Promise<SendOutcome> {
  const existing = inFlight.get(storageKey);
  if (existing) return existing;
  const promise = (async (): Promise<SendOutcome> => {
    try {
      const { data } = await apiFetch<ApiJson<"/chat-runs", "post">>(
        "/api/chat-runs",
        {
          method: "POST",
          headers: { "Idempotency-Key": pending.key },
          body: JSON.stringify(pending.request),
        },
      );
      const outcome = data.outcome;
      if (outcome.kind === "Accepted") {
        // the next turn keeps the choice just sent; a new chat starts from the seed
        const { selection } = read(storageKey);
        write(storageKey, keepSelection ? { ...EMPTY, selection } : EMPTY);
        return { kind: "Accepted", receipt: { ...data, outcome } };
      }
      write(storageKey, { ...read(storageKey), pending: null });
      return { kind: "Rejected", code: outcome.reason.code };
    } catch (error) {
      const failure = chatFailure(error, "This message couldn’t be sent.");
      if (failure.kind === "Feedback" && !failure.ambiguous)
        write(storageKey, { ...read(storageKey), pending: null });
      return { kind: "Failed", failure };
    } finally {
      inFlight.delete(storageKey);
      notify(storageKey);
    }
  })();
  inFlight.set(storageKey, promise);
  notify(storageKey);
  return promise;
}

export function useChatDraft(scope: string) {
  const { accountId } = useAuthenticatedAccount();
  const storageKey = `${PREFIX}${accountId}:${scope}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(storageKey) ?? new Set();
      listeners.set(storageKey, set.add(listener));
      return () => void set.delete(listener);
    },
    [storageKey],
  );
  const draft = useSyncExternalStore(
    subscribe,
    () => read(storageKey),
    () => EMPTY,
  );
  const sending = useSyncExternalStore(
    subscribe,
    () => inFlight.has(storageKey),
    () => false,
  );
  const commands = useMemo(() => {
    const update = (change: Partial<Draft>) => {
      const current = read(storageKey);
      if (!current.pending) write(storageKey, { ...current, ...change });
    };
    return {
      setText: (text: string) => update({ text }),
      setSelection: (selection: SelectionDraft) => update({ selection }),
      /** An explicit launch's text (`?draft=`) fills an empty draft once. */
      seed: (text: string) => {
        if (!read(storageKey).text) update({ text });
      },
      send: (request: RunCreateRequest): Promise<SendOutcome> => {
        const pending = { key: createRandomId(), request };
        write(storageKey, { ...read(storageKey), pending });
        return post(storageKey, pending, scope !== "new");
      },
      /** Replay the stored command: the same key and the same bytes. */
      retry: (): Promise<SendOutcome> | null => {
        const pending = read(storageKey).pending;
        return pending && post(storageKey, pending, scope !== "new");
      },
    };
  }, [storageKey, scope]);
  return { draft, sending, ...commands };
}
