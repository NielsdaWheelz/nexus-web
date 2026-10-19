"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { isRecord } from "@/lib/validation";
import { decodeSelectionDraft, type SelectionDraft } from "./selection";
import {
  getConversationCommands,
  IDLE_COMMAND,
  type CommandOutcome,
  type ExistingSendRequest,
} from "./commands";
import {
  chatFailure,
  type AcceptedReceipt,
  type ChatFailure,
  type RejectionCode,
  type RunCreateRequest,
} from "./wire";

// Draft text/choices keep their existing session storage contract. New-chat
// sends retain their stored pending request; existing-chat commands belong to
// the in-memory chat owner and never put a revision/request into storage.

export type PendingSend = Readonly<{ key: string; request: RunCreateRequest }>;
type DraftSendRequest = Omit<RunCreateRequest, "destination"> & {
  destination:
    | Extract<RunCreateRequest["destination"], { kind: "New" }>
    | Omit<Extract<RunCreateRequest["destination"], { kind: "Existing" }>, "expected_revision">;
};
export type Draft = Readonly<{
  text: string;
  selection: SelectionDraft;
  pending: (PendingSend & { openIntent: OpenIntent }) | null;
}>;
export type SendOutcome =
  | { kind: "Accepted"; receipt: AcceptedReceipt }
  | { kind: "Rejected"; code: RejectionCode }
  | { kind: "Failed"; failure: ChatFailure };
export type ReaderChatOutcome =
  | Exclude<SendOutcome, { kind: "Failed" }>
  | { kind: "DefiniteRefusal"; status: number; code: string; requestId?: string };
const PREFIX = "nx_chat_draft:";
const EMPTY: Draft = {
  text: "",
  selection: { kind: "Uninitialized" },
  pending: null,
};
const listeners = new Map<string, Set<() => void>>();
const decoded = new Map<string, { raw: string | null; draft: Draft }>();
const inFlight = new Map<string, Promise<SendOutcome>>();

/** New-chat drafts and explicit reader New sends share this transport. */
async function sendPending(key: string, body: string): Promise<Exclude<SendOutcome, { kind: "Failed" }>> {
  const { data } = await apiFetch<ApiJson<"/chat-runs", "post">>(
    "/api/chat-runs",
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body,
    },
  );
  const outcome = data.outcome;
  return outcome.kind === "Accepted"
    ? { kind: "Accepted", receipt: { ...data, outcome } }
    : { kind: "Rejected", code: outcome.reason.code };
}

/** One explicit reader new-chat send, retained only while this tab lives. */
export function createReaderChatSend(pending: PendingSend & { request: { destination: { kind: "New" } } }) {
  const key = pending.key;
  const body = JSON.stringify(pending.request);
  let settled: ReaderChatOutcome | null = null;
  let sending: Promise<ReaderChatOutcome> | null = null;
  return {
    send(): Promise<ReaderChatOutcome> {
      if (settled) return Promise.resolve(settled);
      if (sending) return sending;
      sending = (async (): Promise<ReaderChatOutcome> => {
        let outcome: ReaderChatOutcome;
        try {
          outcome = await sendPending(key, body);
        } catch (error) {
          // Rate limits and uncertain transport keep the exact request for retry.
          if (!isApiError(error) || isSameSystemApiDefect(error) ||
              error.status < 400 || error.status >= 500 || error.status === 429 || error.code === "E_NETWORK") throw error;
          outcome = { kind: "DefiniteRefusal", status: error.status, code: error.code,
            ...(error.requestId === undefined ? {} : { requestId: error.requestId }) };
        }
        settled = outcome;
        if (outcome.kind === "Accepted") publishChange("Chats");
        return outcome;
      })().finally(() => { sending = null; });
      return sending;
    },
  };
}

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
        isRecord(pending.request) &&
        pending.request.destination !== null && isRecord(pending.request.destination) && pending.request.destination.kind === "New" &&
        (pending.openIntent === "default" || pending.openIntent === "new_pane")
      )
        return {
          text: value.text,
          selection,
          // justify-type-assertion: replayed verbatim; the server owns its validation.
          pending: {
            key: pending.key,
            request: pending.request as RunCreateRequest,
            openIntent: pending.openIntent,
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
): Promise<SendOutcome> {
  const existing = inFlight.get(storageKey);
  if (existing) return existing;
  const promise = (async (): Promise<SendOutcome> => {
    try {
      const outcome = await sendPending(pending.key, JSON.stringify(pending.request));
      if (outcome.kind === "Accepted") {
        // the chat moved to the top of the index, with one message more
        publishChange("Chats");
        write(storageKey, EMPTY);
        return outcome;
      }
      write(storageKey, { ...read(storageKey), pending: null });
      return outcome;
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

export function useChatDraft(scope: string, viewId: string, expectedRevision: number | null = null) {
  const { accountId } = useAuthenticatedAccount();
  const storageKey = `${PREFIX}${accountId}:${viewId}:${scope}`;
  const owner = useMemo(
    () => scope === "new" ? null : getConversationCommands(accountId, scope),
    [accountId, scope],
  );
  const subscribeCommand = useCallback(
    (listener: () => void) => owner?.subscribe(listener) ?? (() => undefined),
    [owner],
  );
  const command = useSyncExternalStore(
    subscribeCommand,
    () => owner?.getSnapshot() ?? IDLE_COMMAND,
    () => IDLE_COMMAND,
  );
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
    const finishExisting = (outcome: CommandOutcome): SendOutcome => {
      if (outcome.kind === "Gone") return {
        kind: "Failed", failure: { kind: "Feedback", ambiguous: false,
          feedback: { tone: "Neutral", title: "this chat is no longer available" } },
      };
      if (outcome.kind !== "Handled" && outcome.acceptance) {
        return { kind: "Accepted", receipt: outcome.acceptance };
      }
      if (outcome.kind === "Handled") return { kind: "Failed", failure: { kind: "Handled" } };
      if (outcome.kind === "Conflict") return { kind: "Rejected", code: "E_CONVERSATION_CHANGED" };
      if (outcome.kind === "Failed" && outcome.rejection) return { kind: "Rejected", code: outcome.rejection };
      return {
        kind: "Failed",
        failure: {
          kind: "Feedback",
          feedback: "feedback" in outcome ? outcome.feedback : {
            tone: "Neutral", title: "conversation refreshed; review it before sending again",
          },
          ambiguous: outcome.kind === "Unconfirmed" || outcome.kind === "NeedsRefresh",
        },
      };
    };
    return {
      setText: (text: string) => update({ text }),
      setSelection: (selection: SelectionDraft) => update({ selection }),
      /** An explicit launch's text (`?draft=`) fills an empty draft once. */
      seed: (text: string) => {
        if (!read(storageKey).text) update({ text });
      },
      send: async (request: DraftSendRequest, openIntent: OpenIntent): Promise<SendOutcome> => {
        if (request.destination.kind === "Existing") {
          const current = read(storageKey);
          if (!owner || expectedRevision === null) return {
            kind: "Failed", failure: { kind: "Feedback", ambiguous: false,
              feedback: { tone: "Neutral", title: "conversation history is still loading" } },
          };
          const exact: ExistingSendRequest = {
            ...request, destination: { ...request.destination, expected_revision: expectedRevision },
          };
          const runId = createRandomId();
          const submittedText = current.text;
          try {
            return finishExisting(await owner.execute(
              { kind: "Send", runId, request: exact, viewId, openIntent },
              () => {
                const latest = read(storageKey);
                if (latest.text === submittedText && latest.pending === null) write(storageKey, { ...latest, text: "" });
              },
            ));
          } catch (error) {
            return { kind: "Failed", failure: chatFailure(error, "this message couldn’t be sent") };
          }
        }
        const pending = { key: createRandomId(), request: { ...request, destination: request.destination }, openIntent };
        write(storageKey, { ...read(storageKey), pending });
        return post(storageKey, pending);
      },
      /** Retry the frozen command, or only its read after proven acceptance. */
      retry: (openIntent: OpenIntent): Promise<SendOutcome> | null => {
        const pending = read(storageKey).pending;
        if (owner) {
          const state = owner.getSnapshot();
          if (state.kind === "Idle" || state.command.kind !== "Send" || state.command.viewId !== viewId) return null;
          return owner.retry(openIntent).then(finishExisting,
            (error: unknown) => ({ kind: "Failed", failure: chatFailure(error, "this message couldn’t be sent") }));
        }
        if (!pending) return null;
        const frozen = { ...pending, openIntent: openIntent === "new_pane" ? openIntent : pending.openIntent };
        write(storageKey, { ...read(storageKey), pending: frozen });
        return post(storageKey, frozen);
      },
    };
  }, [storageKey, owner, expectedRevision, viewId]);
  const pendingCommand = command.kind !== "Idle" && command.command.kind === "Send" && command.command.viewId === viewId
    ? { openIntent: command.command.openIntent, key: command.command.runId, request: command.command.request }
    : null;
  return {
    draft: pendingCommand ? { ...draft, pending: pendingCommand } : draft,
    sending: owner
      ? pendingCommand !== null && (command.kind === "Sending" || command.kind === "Reconciling")
      : sending,
    command,
    ...commands,
  };
}
