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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { decodePresence } from "@/lib/api/presence";
import { parseReaderSelectionKey } from "@/lib/conversations/readerSelectionKey";
import type { BranchAnchor } from "@/lib/conversations/types";
import {
  expectExactRecord,
  expectInteger,
  expectNullableString,
  expectOneOf,
  expectString,
  isRecord,
} from "@/lib/validation";

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

const STORAGE_PREFIX = "nx_chat_draft.v2:";
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READER_SELECTION_REVISION_RE = /^[0-9a-f]{64}$/;

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

function decodeCanonicalUuid(value: unknown, name: string): string {
  const uuid = expectString(value, name);
  if (!CANONICAL_UUID_RE.test(uuid)) {
    throw new TypeError(`${name} must be a canonical UUID`);
  }
  return uuid;
}

function decodeBoundedNullableString(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  const decoded = expectNullableString(value, name);
  if (decoded !== null && decoded.length > maxLength) {
    throw new TypeError(`${name} must be at most ${maxLength} characters`);
  }
  return decoded;
}

function decodeBranchAnchor(value: unknown): BranchAnchor {
  const record = expectExactRecord(
    value,
    isRecord(value) && value.kind === "assistant_message"
      ? ["kind", "message_id"]
      : isRecord(value) &&
          value.kind === "assistant_selection" &&
          value.offset_status === "mapped"
        ? [
            "kind",
            "message_id",
            "exact",
            "prefix",
            "suffix",
            "offset_status",
            "start_offset",
            "end_offset",
            "client_selection_id",
          ]
        : isRecord(value) && value.kind === "assistant_selection"
          ? [
              "kind",
              "message_id",
              "exact",
              "prefix",
              "suffix",
              "offset_status",
              "client_selection_id",
            ]
          : ["kind"],
    "chat send request destination insertion branch_anchor",
  );

  if (record.kind === "none") {
    return { kind: "none" };
  }
  if (record.kind === "assistant_message") {
    return {
      kind: "assistant_message",
      message_id: decodeCanonicalUuid(
        record.message_id,
        "chat send request branch anchor message_id",
      ),
    };
  }
  if (record.kind !== "assistant_selection") {
    throw new TypeError("Invalid chat send request branch anchor kind");
  }

  const exact = expectString(
    record.exact,
    "chat send request branch anchor exact",
  );
  if (exact.length > 20_000 || exact.trim().length === 0) {
    throw new TypeError(
      "chat send request branch anchor exact must be nonblank and at most 20000 characters",
    );
  }
  const common = {
    kind: "assistant_selection" as const,
    message_id: decodeCanonicalUuid(
      record.message_id,
      "chat send request branch anchor message_id",
    ),
    exact,
    prefix: decodeBoundedNullableString(
      record.prefix,
      "chat send request branch anchor prefix",
      1_000,
    ),
    suffix: decodeBoundedNullableString(
      record.suffix,
      "chat send request branch anchor suffix",
      1_000,
    ),
    client_selection_id: expectString(
      record.client_selection_id,
      "chat send request branch anchor client_selection_id",
    ),
  };
  if (
    common.client_selection_id.length === 0 ||
    common.client_selection_id.length > 128
  ) {
    throw new TypeError(
      "chat send request branch anchor client_selection_id must contain 1 to 128 characters",
    );
  }
  const offsetStatus = expectOneOf(
    record.offset_status,
    ["mapped", "unmapped"] as const,
    "chat send request branch anchor offset_status",
  );
  if (offsetStatus === "mapped") {
    return {
      ...common,
      offset_status: "mapped",
      start_offset: expectInteger(
        record.start_offset,
        "chat send request branch anchor start_offset",
      ),
      end_offset: expectInteger(
        record.end_offset,
        "chat send request branch anchor end_offset",
      ),
    };
  }
  return { ...common, offset_status: "unmapped" };
}

function decodeChatRunCreateRequest(value: unknown): ChatRunCreateRequest {
  const request = expectExactRecord(
    value,
    ["destination", "content", "profile_id", "reader_selection"],
    "chat send request",
  );
  const destination = expectExactRecord(
    request.destination,
    isRecord(request.destination) && request.destination.kind === "Existing"
      ? ["kind", "conversation_id", "insertion"]
      : ["kind"],
    "chat send request destination",
  );

  let decodedDestination: ChatRunCreateRequest["destination"];
  if (destination.kind === "New") {
    decodedDestination = { kind: "New" };
  } else if (destination.kind === "Existing") {
    const insertion = expectExactRecord(
      destination.insertion,
      isRecord(destination.insertion) && destination.insertion.kind === "Reply"
        ? ["kind", "parent_message_id", "branch_anchor"]
        : ["kind"],
      "chat send request destination insertion",
    );
    if (insertion.kind === "Empty") {
      decodedDestination = {
        kind: "Existing",
        conversation_id: decodeCanonicalUuid(
          destination.conversation_id,
          "chat send request destination conversation_id",
        ),
        insertion: { kind: "Empty" },
      };
    } else if (insertion.kind === "Reply") {
      decodedDestination = {
        kind: "Existing",
        conversation_id: decodeCanonicalUuid(
          destination.conversation_id,
          "chat send request destination conversation_id",
        ),
        insertion: {
          kind: "Reply",
          parent_message_id: decodeCanonicalUuid(
            insertion.parent_message_id,
            "chat send request destination insertion parent_message_id",
          ),
          branch_anchor: decodeBranchAnchor(insertion.branch_anchor),
        },
      };
    } else {
      throw new TypeError("Invalid chat send request insertion kind");
    }
  } else {
    throw new TypeError("Invalid chat send request destination kind");
  }

  const content = expectString(request.content, "chat send request content");
  if (content.trim().length === 0) {
    throw new TypeError("chat send request content must not be blank");
  }
  const profileId = expectOneOf(
    request.profile_id,
    ["fast", "balanced", "deep"] as const,
    "chat send request profile_id",
  );
  const readerSelection = decodePresence(
    request.reader_selection,
    (rawSelection) => {
      const selection = expectExactRecord(
        rawSelection,
        ["key", "revision"],
        "chat send request reader_selection value",
      );
      const rawKey = expectExactRecord(
        selection.key,
        ["media_id", "highlight_id"],
        "chat send request reader_selection key",
      );
      const key = parseReaderSelectionKey({
        mediaId: rawKey.media_id,
        highlightId: rawKey.highlight_id,
      });
      if (key === null) {
        throw new TypeError(
          "chat send request reader_selection key must contain canonical UUIDs",
        );
      }
      const revision = expectString(
        selection.revision,
        "chat send request reader_selection revision",
      );
      if (!READER_SELECTION_REVISION_RE.test(revision)) {
        throw new TypeError(
          "chat send request reader_selection revision must be a lowercase SHA-256 digest",
        );
      }
      return {
        key: { media_id: key.mediaId, highlight_id: key.highlightId },
        revision,
      };
    },
  );

  return {
    destination: decodedDestination,
    content,
    profile_id: profileId,
    reader_selection: readerSelection,
  };
}

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
    request: decodeChatRunCreateRequest(value.request),
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

function requireSessionStorage(): Storage {
  if (typeof window === "undefined" || window.sessionStorage === undefined) {
    throw new Error("Chat drafts require sessionStorage");
  }
  return window.sessionStorage;
}

function loadRecord(storageKey: string): ChatDraftRecord {
  const raw = requireSessionStorage().getItem(storageKey);
  return raw === null ? EMPTY_DRAFT_RECORD : decodeChatDraftRecord(raw);
}

/** Persist synchronously. A storage failure is a defect (no fallback). */
function persistRecord(storageKey: string, record: ChatDraftRecord): void {
  const storage = requireSessionStorage();
  if (isEmptyRecord(record)) {
    storage.removeItem(storageKey);
  } else {
    storage.setItem(storageKey, JSON.stringify(record));
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Static store for the hydration guard; the snapshot never changes. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

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

  // Hydration guard: false on the server and during the hydration render (so
  // server and first client markup stay byte-identical without touching
  // browser storage), true from the post-hydration commit and for every
  // ordinary client mount's first render.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  // Synchronous record selection: switching keys (and the first hydrated
  // render) loads the record during render (the React "adjust state during
  // render" pattern), so no effect-driven stale record can render or mutate
  // under another key. In particular, a persisted locked reconciliation is
  // visible to every effect of the same commit — the `initialContent` seed
  // below can never race an asynchronous restore and destroy the in-flight
  // command. Storage reads stay strict: unavailable storage or a malformed
  // current record throws.
  const [state, setState] = useState<{
    storageKey: string;
    record: ChatDraftRecord;
    restored: boolean;
  }>(() =>
    hydrated
      ? { storageKey, record: loadRecord(storageKey), restored: true }
      : { storageKey, record: EMPTY_DRAFT_RECORD, restored: false },
  );
  let record = state.record;
  if (state.storageKey !== storageKey) {
    record = hydrated ? loadRecord(storageKey) : EMPTY_DRAFT_RECORD;
    setState({ storageKey, record, restored: hydrated });
  } else if (hydrated && !state.restored) {
    record = loadRecord(storageKey);
    setState({ storageKey, record, restored: true });
  }
  const recordRef = useRef(record);
  recordRef.current = record;

  const write = useCallback(
    (next: ChatDraftRecord) => {
      persistRecord(storageKey, next);
      setState({ storageKey, record: next, restored: true });
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
