import type {
  ChatRunCreateRequest,
  ChatDestinationInput,
} from "@/lib/api/sse/requests";
import type { BranchAnchor } from "@/lib/conversations/types";
import {
  expectExactRecord,
  expectOneOf,
  expectRecord,
  expectString,
  isCanonicalUuid,
} from "@/lib/validation";
import { assertNever } from "@/lib/assertNever";
import { decodeGenerationSelectionSpec } from "./generationCatalog";

const REJECTION_CODES = [
  "E_RATE_LIMITED",
  "E_MESSAGE_TOO_LONG",
  "E_CATALOG_DEFINITION_STALE",
  "E_GENERATION_SELECTION_UNAVAILABLE",
  "E_INVALID_GENERATION_SELECTION",
  "E_INVALID_REQUEST",
  "E_BRANCH_PATH_INVALID",
  "E_BRANCH_ANCHOR_INVALID",
  "E_FORBIDDEN",
  "E_NOT_FOUND",
  "E_CONVERSATION_NOT_FOUND",
  "E_MESSAGE_NOT_FOUND",
  "E_READER_SELECTION_STALE",
  "E_READER_SELECTION_NOT_FOUND",
  "E_READER_SELECTION_FORBIDDEN",
  "E_READER_SELECTION_GEOMETRY_ONLY",
  "E_READER_SELECTION_TOO_LARGE",
  "E_CONVERSATION_NO_LONGER_EMPTY",
  "E_BILLING_REQUIRED",
  "E_GENERATION_CONTEXT_TOO_LARGE",
] as const;
export type ChatAdmissionRejection = { code: (typeof REJECTION_CODES)[number] };
export type AcceptedChatAdmission = Readonly<{
  idempotency_key: string;
  outcome: Readonly<{
    kind: "Accepted";
    conversation_id: string;
    run_id: string;
    assistant_message_id: string;
  }>;
}>;
export type ChatAdmissionReceipt =
  | AcceptedChatAdmission
  | Readonly<{
      idempotency_key: string;
      outcome: Readonly<{ kind: "Rejected"; reason: ChatAdmissionRejection }>;
    }>;

export function decodeIdempotencyKey(raw: unknown): string {
  const key = expectString(raw, "Idempotency key");
  if (!key || key.length > 128 || key !== key.trim())
    throw new Error("Invalid idempotency key");
  return key;
}
function uuid(raw: unknown): string {
  if (!isCanonicalUuid(raw)) throw new Error("Invalid chat identity");
  return raw;
}
export function decodeChatAdmissionReceipt(raw: unknown): ChatAdmissionReceipt {
  const value = expectExactRecord(
    raw,
    ["idempotency_key", "outcome"],
    "Chat admission receipt",
  );
  const idempotency_key = decodeIdempotencyKey(value.idempotency_key);
  const outcome = expectRecord(value.outcome, "Chat admission outcome");
  if (outcome.kind === "Accepted") {
    expectExactRecord(
      outcome,
      ["kind", "conversation_id", "run_id", "assistant_message_id"],
      "Accepted admission",
    );
    return {
      idempotency_key,
      outcome: {
        kind: "Accepted",
        conversation_id: uuid(outcome.conversation_id),
        run_id: uuid(outcome.run_id),
        assistant_message_id: uuid(outcome.assistant_message_id),
      },
    };
  }
  if (outcome.kind === "Rejected") {
    expectExactRecord(outcome, ["kind", "reason"], "Rejected admission");
    const reason = expectExactRecord(
      outcome.reason,
      ["code"],
      "Admission rejection",
    );
    return {
      idempotency_key,
      outcome: {
        kind: "Rejected",
        reason: {
          code: expectOneOf(
            reason.code,
            REJECTION_CODES,
            "Admission rejection code",
          ),
        },
      },
    };
  }
  throw new Error("Invalid chat admission outcome");
}
export function decodeChatAdmissionResponse(
  raw: unknown,
  key: string,
): ChatAdmissionReceipt {
  const body = expectExactRecord(raw, ["data"], "Chat admission response");
  const receipt = decodeChatAdmissionReceipt(body.data);
  if (receipt.idempotency_key !== key)
    throw new Error("Chat admission receipt identity mismatch");
  return receipt;
}
export function chatAdmissionErrorMessage(
  reason: ChatAdmissionRejection,
): string {
  switch (reason.code) {
    case "E_RATE_LIMITED":
      return "Too many messages. Wait a moment, then send again.";
    case "E_MESSAGE_TOO_LONG":
      return "This message is too long. Shorten it and send again.";
    case "E_CATALOG_DEFINITION_STALE":
      return "Model availability changed. Review your selection, then send again.";
    case "E_GENERATION_SELECTION_UNAVAILABLE":
      return "That exact model and effort are unavailable.";
    case "E_INVALID_GENERATION_SELECTION":
      return "That model selection is invalid.";
    case "E_INVALID_REQUEST":
      return "This message is invalid. Review it and send again.";
    case "E_BRANCH_PATH_INVALID":
    case "E_BRANCH_ANCHOR_INVALID":
      return "This reply target changed. Choose a response and send again.";
    case "E_FORBIDDEN":
      return "You don’t have permission to send to this chat.";
    case "E_NOT_FOUND":
    case "E_CONVERSATION_NOT_FOUND":
      return "This chat is no longer available.";
    case "E_MESSAGE_NOT_FOUND":
      return "This reply target is no longer available.";
    case "E_READER_SELECTION_STALE":
      return "The quoted passage changed. Review the refreshed quote and send again.";
    case "E_READER_SELECTION_NOT_FOUND":
      return "The quoted passage is no longer available. Remove it to continue.";
    case "E_READER_SELECTION_FORBIDDEN":
      return "You don’t have permission to use this quoted passage.";
    case "E_READER_SELECTION_GEOMETRY_ONLY":
      return "This selection has no text to quote. Choose a text passage.";
    case "E_READER_SELECTION_TOO_LARGE":
      return "The quoted passage is too long. Choose a shorter passage.";
    case "E_CONVERSATION_NO_LONGER_EMPTY":
      return "This chat already has messages. Review the conversation and send again.";
    case "E_BILLING_REQUIRED":
      return "Billing must be enabled before sending this message.";
    case "E_GENERATION_CONTEXT_TOO_LARGE":
      return "This conversation no longer fits the model’s context window. Start a new chat or choose a larger model.";
    default:
      return assertNever(reason.code);
  }
}

function nonblank(raw: unknown, name: string, max = Infinity): string {
  const value = expectString(raw, name);
  if (!value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function affix(raw: unknown): string | null {
  if (raw === null) return null;
  const value = expectString(raw, "Branch affix");
  if (value.length > 1000) throw new Error("Invalid branch affix");
  return value;
}
function decodeBranchAnchor(raw: unknown): BranchAnchor {
  const value = expectRecord(raw, "Branch anchor");
  if (value.kind === "none") {
    expectExactRecord(value, ["kind"], "Branch anchor");
    return { kind: "none" };
  }
  if (value.kind === "assistant_message") {
    expectExactRecord(value, ["kind", "message_id"], "Branch anchor");
    return { kind: "assistant_message", message_id: uuid(value.message_id) };
  }
  if (value.kind !== "assistant_selection")
    throw new Error("Invalid branch anchor");
  const keys = [
    "kind",
    "message_id",
    "exact",
    "prefix",
    "suffix",
    "offset_status",
    "client_selection_id",
  ];
  const common = {
    kind: "assistant_selection" as const,
    message_id: uuid(value.message_id),
    exact: nonblank(value.exact, "Branch quote", 20000),
    prefix: affix(value.prefix),
    suffix: affix(value.suffix),
    client_selection_id: nonblank(
      value.client_selection_id,
      "Branch selection identity",
      128,
    ),
  };
  if (value.offset_status === "unmapped") {
    expectExactRecord(value, keys, "Branch selection");
    return { ...common, offset_status: "unmapped" };
  }
  expectExactRecord(
    value,
    [...keys, "start_offset", "end_offset"],
    "Branch selection",
  );
  if (
    value.offset_status !== "mapped" ||
    typeof value.start_offset !== "number" ||
    typeof value.end_offset !== "number" ||
    !Number.isSafeInteger(value.start_offset) ||
    !Number.isSafeInteger(value.end_offset) ||
    value.start_offset < 0 ||
    value.end_offset <= value.start_offset
  )
    throw new Error("Invalid branch offsets");
  return {
    ...common,
    offset_status: "mapped",
    start_offset: value.start_offset,
    end_offset: value.end_offset,
  };
}
function decodeDestination(raw: unknown): ChatDestinationInput {
  const value = expectRecord(raw, "Chat destination");
  if (value.kind === "New") {
    expectExactRecord(value, ["kind"], "Chat destination");
    return { kind: "New" };
  }
  expectExactRecord(
    value,
    ["kind", "conversation_id", "insertion"],
    "Chat destination",
  );
  if (value.kind !== "Existing") throw new Error("Invalid chat destination");
  const conversation_id = uuid(value.conversation_id);
  const insertion = expectRecord(value.insertion, "Chat insertion");
  if (insertion.kind === "Empty") {
    expectExactRecord(insertion, ["kind"], "Chat insertion");
    return { kind: "Existing", conversation_id, insertion: { kind: "Empty" } };
  }
  expectExactRecord(
    insertion,
    ["kind", "parent_message_id", "branch_anchor"],
    "Chat insertion",
  );
  if (insertion.kind !== "Reply") throw new Error("Invalid chat insertion");
  return {
    kind: "Existing",
    conversation_id,
    insertion: {
      kind: "Reply",
      parent_message_id: uuid(insertion.parent_message_id),
      branch_anchor: decodeBranchAnchor(insertion.branch_anchor),
    },
  };
}
/** Decode the existing browser command shape without changing replay bytes. */
export function decodeChatRunCreateRequest(raw: unknown): ChatRunCreateRequest {
  const value = expectExactRecord(
    raw,
    [
      "destination",
      "content",
      "catalog_definition_revision",
      "selection",
      "reader_selection",
    ],
    "Chat command request",
  );
  const selection = expectRecord(value.reader_selection, "Reader selection");
  let reader_selection: ChatRunCreateRequest["reader_selection"];
  if (selection.kind === "Absent") {
    expectExactRecord(selection, ["kind"], "Reader selection");
    reader_selection = { kind: "Absent" };
  } else {
    expectExactRecord(selection, ["kind", "value"], "Reader selection");
    if (selection.kind !== "Present")
      throw new Error("Invalid reader selection");
    const present = expectExactRecord(
      selection.value,
      ["key", "revision"],
      "Reader selection input",
    );
    const key = expectExactRecord(
      present.key,
      ["media_id", "highlight_id"],
      "Reader selection key",
    );
    if (
      typeof present.revision !== "string" ||
      !/^[0-9a-f]{64}$/.test(present.revision)
    )
      throw new Error("Invalid reader selection revision");
    reader_selection = {
      kind: "Present",
      value: {
        key: {
          media_id: uuid(key.media_id),
          highlight_id: uuid(key.highlight_id),
        },
        revision: present.revision,
      },
    };
  }
  const revision = expectString(
    value.catalog_definition_revision,
    "Chat catalog revision",
  );
  if (!/^[0-9a-f]{64}$/.test(revision))
    throw new Error("Invalid chat catalog revision");
  return {
    destination: decodeDestination(value.destination),
    content: nonblank(value.content, "Chat content"),
    catalog_definition_revision: revision,
    selection: decodeGenerationSelectionSpec(value.selection),
    reader_selection,
  };
}
