/**
 * useChatDraft — the per-key chat draft and its exact send operation.
 *
 * A draft is keyed by a structured `ChatDraftKey` (a new-chat pane visit, an
 * existing path, or a branch reply) and persisted in `sessionStorage` so its
 * text, explicit `ChatProfileSelection`, and in-flight send operation survive
 * reload, pane reuse, and mobile unmount.
 *
 * The send operation is an exact command — one idempotency key plus the one
 * immutable `ChatRunCreateRequest` assembled before dispatch:
 *
 *   Absent            — nothing in flight; the composer is editable.
 *   Submitting        — the command is persisted and POST is in progress.
 *   ReconcileRequired — the outcome is unknown (network loss or a reload of a
 *                       persisted Submitting); the composer locks and offers
 *                       only "Retry send", which replays the SAME command.
 *
 * A definite server rejection consumes the command (back to Absent), so the next
 * explicit send assembles a new command with a new key. Success deletes the
 * whole record. Storage is parsed once at ingress; malformed current data is a
 * defect — there is no old-shape decoder, in-memory fallback, or swallowed error.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  serializeChatDraftKey,
  type ChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import {
  isChatProfileSelection,
  type ChatProfileSelection,
} from "@/lib/conversations/chatProfileSelection";
import { createRandomId } from "@/lib/createRandomId";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import { isRecord } from "@/lib/validation";

export type ChatSendCommand = Readonly<{
  idempotencyKey: string;
  request: ChatRunCreateRequest;
}>;

export type ChatSendOperation =
  | { kind: "Absent" }
  | { kind: "Submitting"; command: ChatSendCommand }
  | { kind: "ReconcileRequired"; command: ChatSendCommand };

export type ChatDraftRecord = Readonly<{
  text: string;
  profile: ChatProfileSelection | null;
  operation: ChatSendOperation;
}>;

export const EMPTY_DRAFT_RECORD: ChatDraftRecord = {
  text: "",
  profile: null,
  operation: { kind: "Absent" },
};

const STORAGE_PREFIX = "nx_chat_draft:";

// ---------------------------------------------------------------------------
// Pure operation transitions (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** Persist the exact command before dispatch. */
export function withSubmitting(
  record: ChatDraftRecord,
  command: ChatSendCommand,
): ChatDraftRecord {
  return { ...record, operation: { kind: "Submitting", command } };
}

/** Lock the in-flight command for replay after an unknown outcome. Only a
 *  `Submitting` operation can require reconciliation. */
export function withReconcileRequired(record: ChatDraftRecord): ChatDraftRecord {
  if (record.operation.kind !== "Submitting") {
    throw new Error(
      `withReconcileRequired expects a Submitting operation, got ${record.operation.kind}`,
    );
  }
  return {
    ...record,
    operation: { kind: "ReconcileRequired", command: record.operation.command },
  };
}

/** A definite rejection consumes the command; editable text/profile survive. */
export function withClearedOperation(record: ChatDraftRecord): ChatDraftRecord {
  return { ...record, operation: { kind: "Absent" } };
}

// ---------------------------------------------------------------------------
// Storage codec (strict; malformed current data is a defect)
// ---------------------------------------------------------------------------

function decodeCommand(value: unknown): ChatSendCommand {
  if (!isRecord(value)) {
    throw new Error("Invalid chat send command");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    typeof value.idempotencyKey !== "string" ||
    !isRecord(value.request)
  ) {
    throw new Error("Invalid chat send command");
  }
  return {
    idempotencyKey: value.idempotencyKey,
    request: value.request as unknown as ChatRunCreateRequest,
  };
}

function decodeOperation(value: unknown): ChatSendOperation {
  if (!isRecord(value)) {
    throw new Error("Invalid chat send operation");
  }
  if (value.kind === "Absent") {
    if (Object.keys(value).length !== 1) {
      throw new Error("Invalid chat send operation");
    }
    return { kind: "Absent" };
  }
  if (value.kind === "Submitting" || value.kind === "ReconcileRequired") {
    if (Object.keys(value).length !== 2 || !("command" in value)) {
      throw new Error("Invalid chat send operation");
    }
    return { kind: value.kind, command: decodeCommand(value.command) };
  }
  throw new Error("Invalid chat send operation");
}

/**
 * Decode a stored record. A persisted `Submitting` means the tab lost the
 * response, so it is promoted to `ReconcileRequired` at ingress. Malformed data
 * throws — a defect, never a silent fresh draft.
 */
export function decodeChatDraftRecord(raw: string): ChatDraftRecord {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    typeof parsed.text !== "string" ||
    !("profile" in parsed) ||
    !("operation" in parsed) ||
    (parsed.profile !== null && !isChatProfileSelection(parsed.profile))
  ) {
    throw new Error("Malformed chat draft record");
  }
  const operation = decodeOperation(parsed.operation);
  const record: ChatDraftRecord = {
    text: parsed.text,
    profile: parsed.profile,
    operation,
  };
  return operation.kind === "Submitting"
    ? withReconcileRequired(record)
    : record;
}

function isEmptyRecord(record: ChatDraftRecord): boolean {
  return (
    record.text === "" &&
    record.profile === null &&
    record.operation.kind === "Absent"
  );
}

function loadRecord(storageKey: string): ChatDraftRecord {
  const raw = sessionStorage.getItem(storageKey);
  return raw === null ? EMPTY_DRAFT_RECORD : decodeChatDraftRecord(raw);
}

/** Persist synchronously. A storage failure is a defect (no fallback). */
function persistRecord(storageKey: string, record: ChatDraftRecord): void {
  if (isEmptyRecord(record)) {
    sessionStorage.removeItem(storageKey);
  } else {
    sessionStorage.setItem(storageKey, JSON.stringify(record));
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
  /** The serialized storage key — a stable string for effect dependencies. */
  activeDraftKey: string;
  operation: ChatSendOperation;
  /** True while an unknown send outcome must be reconciled: the composer locks
   *  edits and offers only "Retry send". */
  reconciling: boolean;
  /** Mint a key for `request`, persist `Submitting` before dispatch, and return
   *  the command to POST. A persistence failure throws — the caller reports a
   *  defect and never POSTs. */
  beginSubmit: (request: ChatRunCreateRequest) => ChatSendCommand;
  /** Replay the reconcile-required command: re-persist `Submitting` with the
   *  SAME command and return it. */
  retrySubmit: () => ChatSendCommand;
  /** An unknown outcome (network loss): lock the command for reconciliation. */
  requireReconcile: () => void;
  /** A definite rejection: consume the command, keep editable text/profile. */
  clearOperation: () => void;
  /** The server confirmed the run — delete the whole record. */
  resolveSuccess: () => void;
}

export function useChatDraft({
  draftKey,
  initialContent = "",
}: {
  draftKey: ChatDraftKey;
  initialContent?: string;
}): UseChatDraft {
  const storageKey = useMemo(
    () => STORAGE_PREFIX + serializeChatDraftKey(draftKey),
    [draftKey],
  );

  // Synchronous record selection: switching keys loads the new record during
  // render (the React "adjust state during render" pattern), so no effect-driven
  // stale record can render or mutate under another key.
  const [state, setState] = useState<{
    storageKey: string;
    record: ChatDraftRecord;
  }>(() => ({ storageKey, record: loadRecord(storageKey) }));
  let record = state.record;
  if (state.storageKey !== storageKey) {
    record = loadRecord(storageKey);
    setState({ storageKey, record });
  }
  const recordRef = useRef(record);
  recordRef.current = record;

  const write = useCallback(
    (next: ChatDraftRecord) => {
      persistRecord(storageKey, next);
      setState({ storageKey, record: next });
    },
    [storageKey],
  );

  // An explicit `initialContent` change (a user action seeding the composer)
  // overwrites the active draft text. It never overrides a locked reconciliation.
  const initialContentRef = useRef(initialContent);
  useEffect(() => {
    if (initialContentRef.current === initialContent) return;
    initialContentRef.current = initialContent;
    if (recordRef.current.operation.kind === "ReconcileRequired") return;
    write({ ...recordRef.current, text: initialContent });
  }, [initialContent, write]);

  const setContent = useCallback(
    (value: string) => write({ ...recordRef.current, text: value }),
    [write],
  );
  const setProfile = useCallback(
    (value: ChatProfileSelection | null) =>
      write({ ...recordRef.current, profile: value }),
    [write],
  );

  const beginSubmit = useCallback(
    (request: ChatRunCreateRequest): ChatSendCommand => {
      const command: ChatSendCommand = {
        idempotencyKey: createRandomId(),
        request,
      };
      write(withSubmitting(recordRef.current, command));
      return command;
    },
    [write],
  );

  const retrySubmit = useCallback((): ChatSendCommand => {
    const operation = recordRef.current.operation;
    if (operation.kind !== "ReconcileRequired") {
      throw new Error(
        `retrySubmit expects a ReconcileRequired operation, got ${operation.kind}`,
      );
    }
    write(withSubmitting(recordRef.current, operation.command));
    return operation.command;
  }, [write]);

  const requireReconcile = useCallback(
    () => write(withReconcileRequired(recordRef.current)),
    [write],
  );
  const clearOperation = useCallback(
    () => write(withClearedOperation(recordRef.current)),
    [write],
  );
  const resolveSuccess = useCallback(() => write(EMPTY_DRAFT_RECORD), [write]);

  return {
    content: record.text,
    setContent,
    profile: record.profile,
    setProfile,
    activeDraftKey: storageKey,
    operation: record.operation,
    reconciling: record.operation.kind === "ReconcileRequired",
    beginSubmit,
    retrySubmit,
    requireReconcile,
    clearOperation,
    resolveSuccess,
  };
}
