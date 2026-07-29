/**
 * useChatDraft — the per-target draft and its durable send attempt.
 *
 * A draft is keyed by the canonical send target (branch selection, branch
 * message, or active path) so in-flight text survives branch/path switches, and
 * — new for the quote-to-chat cutover — it is persisted in `sessionStorage` so
 * text, the complete `ChatProfileSelection`, and the active send attempt survive
 * reload, pane reuse, and mobile unmount.
 *
 * The send attempt is one idempotency key plus its answer-determining payload
 * identity, exact sent profile selection, and reader-selection precondition
 * revision. It drives idempotent retry:
 *   - a send with the same payload identity replays the SAME key (an unchanged
 *     ambiguous-failure retry, or a stale-revision reconfirmation — revision is
 *     a precondition, not identity, so the key stays unconsumed);
 *   - changing answer-determining input after a known failure mints a NEW key;
 *   - while status is `reconciling` (ambiguous loss / interrupted in-flight),
 *     answer-determining edits, removal, and new sends are blocked until the
 *     replay reconciles;
 *   - success clears the whole record.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatDraftKeyFor } from "@/lib/conversations/chatDraftKey";
import {
  isChatProfileSelection,
  type ChatProfileSelection,
} from "@/lib/conversations/chatProfileSelection";
import { createRandomId } from "@/lib/createRandomId";
import type { BranchDraft } from "@/lib/conversations/types";

export type SendAttemptStatus = "in_flight" | "reconciling" | "retryable";

export interface SendAttempt {
  idempotencyKey: string;
  /** A stable digest of the answer-determining inputs (destination, content,
   *  profile, reader-selection key) — NOT the revision. */
  payloadIdentity: string;
  /** Exact product selection sent with this idempotency key. A locked
   *  ambiguous retry replays this snapshot even if the catalog changed. */
  profileSelection: ChatProfileSelection;
  /** The reader-selection precondition revision at send time, or null when the
   *  turn carries no quote. */
  revision: string | null;
  status: SendAttemptStatus;
}

interface ChatDraftRecord {
  text: string;
  profile: ChatProfileSelection | null;
  attempt: SendAttempt | null;
}

const EMPTY_RECORD: ChatDraftRecord = {
  text: "",
  profile: null,
  attempt: null,
};
const STORAGE_PREFIX = "nx_chat_draft:";

function isSendAttempt(value: unknown): value is SendAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !Object.hasOwn(value, "idempotencyKey") ||
    !Object.hasOwn(value, "payloadIdentity") ||
    !Object.hasOwn(value, "profileSelection") ||
    !Object.hasOwn(value, "revision") ||
    !Object.hasOwn(value, "status")
  ) {
    return false;
  }
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.idempotencyKey === "string" &&
    typeof attempt.payloadIdentity === "string" &&
    isChatProfileSelection(attempt.profileSelection) &&
    (typeof attempt.revision === "string" || attempt.revision === null) &&
    (attempt.status === "in_flight" ||
      attempt.status === "reconciling" ||
      attempt.status === "retryable")
  );
}

// ---------------------------------------------------------------------------
// Pure attempt transitions (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** The attempt to send with: a locked reconciliation replays its exact
 *  snapshot; otherwise an unchanged payload identity reuses the key and current
 *  precondition, while changed answer-determining input mints a fresh key. */
export function attemptForSend(
  current: SendAttempt | null,
  payloadIdentity: string,
  profileSelection: ChatProfileSelection,
  revision: string | null,
  mintKey: () => string = createRandomId,
): SendAttempt {
  if (current?.status === "reconciling") {
    return { ...current, status: "in_flight" };
  }
  if (current !== null && current.payloadIdentity === payloadIdentity) {
    return { ...current, profileSelection, revision, status: "in_flight" };
  }
  return {
    idempotencyKey: mintKey(),
    payloadIdentity,
    profileSelection,
    revision,
    status: "in_flight",
  };
}

export function parseChatDraftRecord(
  raw: string | null,
): ChatDraftRecord | null {
  if (raw === null) return EMPTY_RECORD;
  try {
    const parsed = JSON.parse(raw) as {
      text?: unknown;
      profile?: unknown;
      attempt?: unknown;
    };
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length !== 3 ||
      typeof parsed.text !== "string" ||
      !Object.hasOwn(parsed, "text") ||
      !Object.hasOwn(parsed, "profile") ||
      !Object.hasOwn(parsed, "attempt") ||
      (parsed.profile !== null && !isChatProfileSelection(parsed.profile))
    ) {
      return null;
    }
    const profile = parsed.profile;
    const attempt = parsed.attempt;
    if (attempt !== null && !isSendAttempt(attempt)) return null;
    // A persisted in-flight attempt means the tab lost the response: promote it
    // to the locked reconciliation state so the outcome is replayed, not raced.
    const reconciledAttempt =
      attempt?.status === "in_flight"
        ? { ...attempt, status: "reconciling" as const }
        : attempt;
    return { text: parsed.text, profile, attempt: reconciledAttempt };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseChatDraft {
  content: string;
  setContent: (value: string) => void;
  profile: ChatProfileSelection | null;
  setProfile: (value: ChatProfileSelection | null) => void;
  activeDraftKey: string;
  attempt: SendAttempt | null;
  /** True while an ambiguous/interrupted send must be reconciled: the composer
   *  locks edits and offers only "Retry send". */
  reconciling: boolean;
  /** Begin (or replay) a send: returns the attempt to POST with and persists it
   *  as in-flight. */
  beginSendAttempt: (
    payloadIdentity: string,
    profileSelection: ChatProfileSelection,
    revision: string | null,
  ) => SendAttempt;
  /** The server confirmed the run — clear text, profile, and attempt. */
  resolveSuccess: () => void;
  /** A definite server failure — keep the draft editable and retryable. */
  resolveKnownFailure: () => void;
  /** An ambiguous loss — lock the draft for reconciliation. */
  resolveAmbiguous: () => void;
  /** A stale-revision precondition — keep the unconsumed key, refresh revision. */
  reconfirmRevision: (revision: string | null) => void;
  clearDraft: () => void;
}

export function useChatDraft({
  draftKey,
  branchDraft = null,
  parentMessageId = null,
  conversationId = null,
  initialContent = "",
}: {
  draftKey?: string;
  branchDraft?: BranchDraft | null;
  parentMessageId?: string | null;
  conversationId?: string | null;
  initialContent?: string;
}): UseChatDraft {
  const activeDraftKey = useMemo(() => {
    if (draftKey) return draftKey;
    if (branchDraft) return chatDraftKeyFor({ kind: "branch", branchDraft });
    return chatDraftKeyFor({
      kind: "path",
      pathTargetId: parentMessageId ?? conversationId,
    });
  }, [branchDraft, conversationId, draftKey, parentMessageId]);

  // In-memory mirror so private-mode / SSR (where sessionStorage throws) still
  // works within the session, matching the prior in-memory behavior.
  const memoryRef = useRef<Map<string, ChatDraftRecord>>(new Map());

  const load = useCallback((key: string): ChatDraftRecord => {
    try {
      const storageKey = STORAGE_PREFIX + key;
      const parsed = parseChatDraftRecord(sessionStorage.getItem(storageKey));
      if (parsed !== null) return parsed;
      sessionStorage.removeItem(storageKey);
      return EMPTY_RECORD;
    } catch {
      return memoryRef.current.get(key) ?? EMPTY_RECORD;
    }
  }, []);

  const [record, setRecord] = useState<ChatDraftRecord>(() =>
    load(activeDraftKey),
  );

  const persist = useCallback((key: string, next: ChatDraftRecord) => {
    memoryRef.current.set(key, next);
    try {
      if (next.text === "" && next.profile === null && next.attempt === null) {
        sessionStorage.removeItem(STORAGE_PREFIX + key);
      } else {
        sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(next));
      }
    } catch {
      // Best-effort persistence; the in-memory mirror still holds the value.
    }
  }, []);

  const update = useCallback(
    (mutate: (prev: ChatDraftRecord) => ChatDraftRecord) => {
      setRecord((prev) => {
        const next = mutate(prev);
        persist(activeDraftKey, next);
        return next;
      });
    },
    [activeDraftKey, persist],
  );

  // Switch records when the send target changes.
  const activeKeyRef = useRef(activeDraftKey);
  useEffect(() => {
    if (activeKeyRef.current === activeDraftKey) return;
    activeKeyRef.current = activeDraftKey;
    setRecord(load(activeDraftKey));
  }, [activeDraftKey, load]);

  // An explicit `initialContent` change (a user action seeding the composer)
  // overwrites the active draft text. Never overrides a locked reconciliation.
  const initialContentRef = useRef(initialContent);
  useEffect(() => {
    if (initialContentRef.current === initialContent) return;
    initialContentRef.current = initialContent;
    update((prev) =>
      prev.attempt?.status === "reconciling"
        ? prev
        : { ...prev, text: initialContent },
    );
  }, [initialContent, update]);

  const setContent = useCallback(
    (value: string) => update((prev) => ({ ...prev, text: value })),
    [update],
  );
  const setProfile = useCallback(
    (value: ChatProfileSelection | null) =>
      update((prev) => ({ ...prev, profile: value })),
    [update],
  );

  const beginSendAttempt = useCallback(
    (
      payloadIdentity: string,
      profileSelection: ChatProfileSelection,
      revision: string | null,
    ): SendAttempt => {
      const next = attemptForSend(
        record.attempt,
        payloadIdentity,
        profileSelection,
        revision,
      );
      update((prev) => ({ ...prev, attempt: next }));
      return next;
    },
    [record.attempt, update],
  );

  const setAttemptStatus = useCallback(
    (status: SendAttemptStatus) =>
      update((prev) =>
        prev.attempt ? { ...prev, attempt: { ...prev.attempt, status } } : prev,
      ),
    [update],
  );

  const resolveSuccess = useCallback(() => {
    update(() => EMPTY_RECORD);
  }, [update]);

  const resolveKnownFailure = useCallback(
    () => setAttemptStatus("retryable"),
    [setAttemptStatus],
  );
  const resolveAmbiguous = useCallback(
    () => setAttemptStatus("reconciling"),
    [setAttemptStatus],
  );

  const reconfirmRevision = useCallback(
    (revision: string | null) =>
      // A stale-revision rejection is a definite server response (no run/replay
      // row persisted, key unconsumed): refresh the precondition and leave the
      // attempt `retryable` so an explicit resend reuses the key — never
      // `in_flight`, which a later remount would promote to the locked
      // ambiguous-loss reconciliation panel.
      update((prev) =>
        prev.attempt
          ? {
              ...prev,
              attempt: { ...prev.attempt, revision, status: "retryable" },
            }
          : prev,
      ),
    [update],
  );

  const clearDraft = useCallback(() => update(() => EMPTY_RECORD), [update]);

  return {
    content: record.text,
    setContent,
    profile: record.profile,
    setProfile,
    activeDraftKey,
    attempt: record.attempt,
    reconciling: record.attempt?.status === "reconciling",
    beginSendAttempt,
    resolveSuccess,
    resolveKnownFailure,
    resolveAmbiguous,
    reconfirmRevision,
    clearDraft,
  };
}
