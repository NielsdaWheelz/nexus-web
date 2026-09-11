import { apiFetch } from "@/lib/api/client";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import {
  decodeGenerationSelectionSpec,
  type GenerationSelectionSpec,
} from "./generationCatalog";
import {
  decodeChatAdmissionReceipt,
  decodeChatAdmissionResponse,
  decodeChatRunCreateRequest,
  decodeIdempotencyKey,
  type AcceptedChatAdmission,
  type ChatAdmissionReceipt,
} from "./chatAdmission";
import {
  expectExactRecord,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import { createRandomId } from "@/lib/createRandomId";
import type { AuthenticatedAccount } from "@/lib/account/contract";

export type ChatSendCommand = Readonly<{
  idempotencyKey: string;
  request: ChatRunCreateRequest;
  origin: ChatCommandView;
}>;
export type ChatCommandView = Readonly<{
  identity: string;
  accountId: AuthenticatedAccount["accountId"];
}>;
export type ChatSendOperation =
  | { kind: "Absent" }
  | { kind: "Submitting"; command: ChatSendCommand }
  | { kind: "ReconcileRequired"; command: ChatSendCommand }
  | {
      kind: "Acknowledged";
      command: ChatSendCommand;
      receipt: AcceptedChatAdmission;
    };
export type ChatDraftRecord = Readonly<{
  text: string;
  selection: GenerationSelectionSpec | null;
  toolAuthority: ChatRunCreateRequest["tool_authority"];
  operation: ChatSendOperation;
}>;
export const EMPTY_DRAFT_RECORD: ChatDraftRecord = Object.freeze({
  text: "",
  selection: null,
  toolAuthority: "ReadOnly",
  operation: Object.freeze({ kind: "Absent" }),
});
export const CHAT_DRAFT_STORAGE_PREFIX = "nx_chat_draft.v3:";
const storeListeners = new Set<() => void>();
export function subscribeChatDraftStores(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function decodeCommand(raw: unknown): ChatSendCommand {
  const value = expectExactRecord(
    raw,
    ["idempotencyKey", "request", "origin"],
    "Chat command",
  );
  return freeze({
    idempotencyKey: decodeIdempotencyKey(value.idempotencyKey),
    request: decodeChatRunCreateRequest(value.request),
    origin: decodeCommandView(value.origin),
  });
}
function decodeCommandView(raw: unknown): ChatCommandView {
  const value = expectExactRecord(
    raw,
    ["identity", "accountId"],
    "Chat command origin",
  );
  const identity = expectString(value.identity, "Chat command origin.identity");
  const accountId = expectString(
    value.accountId,
    "Chat command origin.accountId",
  );
  if (!identity.trim() || !accountId.trim())
    throw new TypeError("Chat command origin must not be empty");
  return { identity, accountId };
}
function assertReceiptDestination(
  command: ChatSendCommand,
  receipt: ChatAdmissionReceipt,
): void {
  if (
    receipt.outcome.kind === "Accepted" &&
    command.request.destination.kind === "Existing" &&
    receipt.outcome.conversation_id !==
      command.request.destination.conversation_id
  )
    throw new Error("Chat admission destination identity mismatch");
}
export function decodeChatDraftRecord(raw: string): ChatDraftRecord {
  const value = expectExactRecord(
    JSON.parse(raw),
    ["text", "selection", "toolAuthority", "operation"],
    "Chat draft",
  );
  const input = expectRecord(value.operation, "Chat operation");
  let operation: ChatSendOperation;
  if (input.kind === "Absent") {
    expectExactRecord(input, ["kind"], "Chat operation");
    operation = { kind: "Absent" };
  } else if (
    input.kind === "Submitting" ||
    input.kind === "ReconcileRequired"
  ) {
    expectExactRecord(input, ["kind", "command"], "Chat operation");
    operation = {
      kind: "ReconcileRequired",
      command: decodeCommand(input.command),
    };
  } else if (input.kind === "Acknowledged") {
    expectExactRecord(
      input,
      ["kind", "command", "receipt"],
      "Chat acknowledgment",
    );
    const command = decodeCommand(input.command);
    const receipt = decodeChatAdmissionReceipt(input.receipt);
    if (
      receipt.outcome.kind !== "Accepted" ||
      receipt.idempotency_key !== command.idempotencyKey
    )
      throw new Error("Invalid acknowledged chat identity");
    assertReceiptDestination(command, receipt);
    operation = {
      kind: "Acknowledged",
      command,
      receipt: {
        idempotency_key: receipt.idempotency_key,
        outcome: receipt.outcome,
      },
    };
  } else throw new Error("Invalid chat operation");
  return freeze({
    text: expectString(value.text, "Draft text"),
    selection:
      value.selection === null
        ? null
        : decodeGenerationSelectionSpec(value.selection, "Chat draft.selection"),
    toolAuthority: expectOneOf(
      value.toolAuthority,
      ["ReadOnly", "AdditiveWrites"] as const,
      "Chat draft.toolAuthority",
    ),
    operation,
  });
}

/** One owner per existing sessionStorage key, shared by all mounted subscribers.
 * A command continues to settle its own record even when its view unmounts. */
export class ChatDraftStore {
  private raw: string | null | undefined;
  private record: ChatDraftRecord = EMPTY_DRAFT_RECORD;
  // Explicit same-account presentation claims may supersede the durable origin
  // for this JS lifetime; a reload requires that origin or another explicit claim.
  private commandView: ChatCommandView | null = null;
  private readonly listeners = new Set<() => void>();
  private inFlight: {
    key: string;
    promise: Promise<ChatAdmissionReceipt>;
  } | null = null;
  constructor(readonly storageKey: string) {}
  getSnapshot = (): ChatDraftRecord => {
    const raw = window.sessionStorage.getItem(this.storageKey);
    if (raw !== this.raw) {
      const next =
        raw === null ? EMPTY_DRAFT_RECORD : decodeChatDraftRecord(raw);
      if (
        next.operation.kind === "Absent" ||
        this.record.operation.kind === "Absent" ||
        next.operation.command.idempotencyKey !==
          this.record.operation.command.idempotencyKey
      )
        this.commandView = null;
      this.record = next;
      this.raw = raw;
    }
    return this.record;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private write(next: ChatDraftRecord): void {
    const empty =
      next.text === "" &&
      next.selection === null &&
      next.toolAuthority === "ReadOnly" &&
      next.operation.kind === "Absent";
    const raw = empty ? null : JSON.stringify(next);
    if (raw === null) window.sessionStorage.removeItem(this.storageKey);
    else window.sessionStorage.setItem(this.storageKey, raw);
    this.raw = raw;
    this.record = freeze(next);
    for (const listener of this.listeners) listener();
    for (const listener of storeListeners) listener();
  }
  seedContent = (text: string): void => {
    const record = this.getSnapshot();
    if (this.raw === null && record.operation.kind === "Absent")
      this.write({ ...record, text });
  };
  setContent = (text: string): void => {
    const record = this.getSnapshot();
    if (record.operation.kind === "Absent") this.write({ ...record, text });
  };
  setSelection = (selection: GenerationSelectionSpec | null): void => {
    const record = this.getSnapshot();
    if (record.operation.kind === "Absent")
      this.write({
        ...record,
        selection:
          selection === null ? null : decodeGenerationSelectionSpec(selection),
      });
  };
  setToolAuthority = (
    toolAuthority: ChatRunCreateRequest["tool_authority"],
  ): void => {
    const record = this.getSnapshot();
    if (record.operation.kind === "Absent")
      this.write({ ...record, toolAuthority });
  };
  assertAccount = (accountId: AuthenticatedAccount["accountId"]): void => {
    const operation = this.getSnapshot().operation;
    if (
      operation.kind !== "Absent" &&
      operation.command.origin.accountId !== accountId
    )
      throw new Error("Chat command belongs to another authenticated account");
  };
  beginSubmit = (
    request: ChatRunCreateRequest,
    view: ChatCommandView,
  ): ChatSendCommand | null => {
    this.assertAccount(view.accountId);
    const record = this.getSnapshot();
    if (record.operation.kind !== "Absent") return null;
    const command = freeze({
      idempotencyKey: createRandomId(),
      request: decodeChatRunCreateRequest(request),
      origin: decodeCommandView({
        identity: view.identity,
        accountId: view.accountId,
      }),
    });
    this.write({ ...record, operation: { kind: "Submitting", command } });
    this.commandView = { identity: view.identity, accountId: view.accountId };
    return command;
  };
  retrySubmit = (view: ChatCommandView): ChatSendCommand | null => {
    this.assertAccount(view.accountId);
    const record = this.getSnapshot();
    if (record.operation.kind !== "ReconcileRequired") return null;
    const command = record.operation.command;
    if (command.origin.identity !== view.identity)
      throw new Error("Chat send recovery belongs to another visit");
    this.write({ ...record, operation: { kind: "Submitting", command } });
    this.commandView = { identity: view.identity, accountId: view.accountId };
    return command;
  };
  claimAcknowledgment = (
    command: ChatSendCommand,
    view: ChatCommandView,
    explicit: boolean,
  ): boolean => {
    this.assertAccount(view.accountId);
    if (this.owned(command).operation.kind !== "Acknowledged")
      throw new Error("Chat operation has no acknowledged target");
    if (
      (this.commandView ?? command.origin).identity !== view.identity &&
      !explicit
    )
      return false;
    this.commandView = { identity: view.identity, accountId: view.accountId };
    return true;
  };
  ownsAcknowledgment = (
    command: ChatSendCommand,
    view: ChatCommandView,
  ): boolean => {
    const operation = this.getSnapshot().operation;
    const owner = this.commandView ?? command.origin;
    return (
      operation.kind === "Acknowledged" &&
      operation.command.idempotencyKey === command.idempotencyKey &&
      owner.identity === view.identity &&
      owner.accountId === view.accountId
    );
  };
  private owned(command: ChatSendCommand): ChatDraftRecord {
    const record = this.getSnapshot();
    if (
      record.operation.kind === "Absent" ||
      record.operation.command.idempotencyKey !== command.idempotencyKey
    )
      throw new Error("Chat operation ownership mismatch");
    return record;
  }
  submit = (command: ChatSendCommand): Promise<ChatAdmissionReceipt> => {
    if (this.inFlight?.key === command.idempotencyKey)
      return this.inFlight.promise;
    const record = this.owned(command);
    if (record.operation.kind !== "Submitting" || this.inFlight !== null)
      throw new Error("Chat command is not available for dispatch");
    const promise = this.post(command).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = { key: command.idempotencyKey, promise };
    return promise;
  };
  private async post(command: ChatSendCommand): Promise<ChatAdmissionReceipt> {
    try {
      const body = await apiFetch<unknown>("/api/chat-runs", {
        method: "POST",
        headers: { "Idempotency-Key": command.idempotencyKey },
        body: JSON.stringify(command.request),
      });
      const receipt = decodeChatAdmissionResponse(body, command.idempotencyKey);
      assertReceiptDestination(command, receipt);
      const record = this.owned(command);
      this.write({
        ...record,
        operation:
          receipt.outcome.kind === "Accepted"
            ? {
                kind: "Acknowledged",
                command,
                receipt: {
                  idempotency_key: receipt.idempotency_key,
                  outcome: receipt.outcome,
                },
              }
            : { kind: "Absent" },
      });
      return receipt;
    } catch (error) {
      const record = this.owned(command);
      if (record.operation.kind === "Submitting")
        this.write({
          ...record,
          operation: { kind: "ReconcileRequired", command },
        });
      throw error;
    }
  }
  complete = (command: ChatSendCommand, view: ChatCommandView): void => {
    this.assertAccount(view.accountId);
    if (this.owned(command).operation.kind !== "Acknowledged")
      throw new Error("Chat operation has no acknowledged target");
    if (!this.ownsAcknowledgment(command, view))
      throw new Error("Chat acknowledgment belongs to another visit");
    this.write(EMPTY_DRAFT_RECORD);
  };
}
const stores = new Map<string, ChatDraftStore>();
export function chatDraftStoreFor(storageKey: string): ChatDraftStore {
  let store = stores.get(storageKey);
  if (!store) {
    store = new ChatDraftStore(storageKey);
    stores.set(storageKey, store);
  }
  return store;
}

/** Recover by durable command ownership, independently of the current tree leaf.
 * The original record remains the only persistence owner; there is no second
 * durable index to synchronize with admission or cleanup. Null is an inline
 * ownership conflict, never a choice of one command or a pane render defect. */
export function chatDraftStorageKeyForView(
  editableStorageKey: string,
  view: ChatCommandView,
  conversationId: string | null,
): string | null {
  const editable = chatDraftStoreFor(editableStorageKey);
  editable.assertAccount(view.accountId);
  const editableOperation = editable.getSnapshot().operation;
  if (
    editableOperation.kind !== "Absent" &&
    editableOperation.kind !== "Acknowledged" &&
    editableOperation.command.origin.identity !== view.identity
  )
    return null;
  const candidates = new Set<string>();
  if (editableOperation.kind !== "Absent") candidates.add(editableStorageKey);
  if (conversationId !== null) {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key === null || !key.startsWith(CHAT_DRAFT_STORAGE_PREFIX)) continue;
      const candidate = chatDraftStoreFor(key);
      const operation = candidate.getSnapshot().operation;
      if (operation.kind === "Absent") continue;
      const { origin, request } = operation.command;
      const destinationId =
        operation.kind === "Acknowledged"
          ? operation.receipt.outcome.conversation_id
          : request.destination.kind === "Existing"
            ? request.destination.conversation_id
            : null;
      if (destinationId !== conversationId) continue;
      if (origin.identity === view.identity)
        candidate.assertAccount(view.accountId);
      if (origin.accountId !== view.accountId) continue;
      if (
        operation.kind === "Acknowledged" ||
        origin.identity === view.identity
      )
        candidates.add(key);
    }
  }
  if (candidates.size > 1) return null;
  return candidates.values().next().value ?? editableStorageKey;
}
