/**
 * The conversation-message wire boundary: decode nested transport values once,
 * where server messages enter the client.
 *
 * A `ConversationMessage` arrives from several transports (the messages GET, the
 * conversation tree, and the `POST /chat-runs` family — create, rerun, reconcile,
 * reconnect, active-runs). Each carries a `reader_selection` field that is a
 * `Presence<ReaderSelectionOut>` on the forward wire and absent on older wire.
 * These helpers decode it into the owned `Presence<ReaderSelectionOut>` the model
 * and view code consume (`docs/rules/boundaries.md`: decode once at the boundary).
 *
 * Only a quoted user message carries a `Present` snapshot; the assistant message
 * and every non-quote message is `Absent`. The client never fabricates a
 * snapshot — the optimistic seed leaves it Absent, and the real snapshot rides in
 * only on the server-returned user message.
 */

import { absent, decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodeDurableExecution,
  type DurableExecution,
} from "@/lib/api/executionAdvisory";
import {
  decodeReaderSelectionOut,
  type ReaderSelectionOut,
} from "@/lib/conversations/readerSelection";
import {
  decodeCitationOut,
  type CitationOut,
} from "@/lib/conversations/citationOut";
import { normalizeResourceActivation } from "@/lib/resources/activation";
import {
  TOOL_CONTRACT_PROJECTION,
  type ToolEffect,
  type ToolErrorType,
  type ToolRecordKind,
  type ToolResultKind,
} from "@/lib/conversations/toolContractProjection";
import {
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import type {
  AssistantTrustTrail,
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  MessageToolCall,
} from "@/lib/conversations/types";

const LEGACY_TOOL_PROJECTION_FIELDS = [
  "tool_name",
  "error_code",
  "query_hash",
] as const;

function requireProjectionField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    throw new Error(`Invalid tool projection: missing ${field}`);
  }
  return value[field];
}

export type ToolProjectionFields = Pick<
  MessageToolCall,
  | "record_kind"
  | "canonical_tool_id"
  | "provider_wire_name"
  | "effect"
  | "result_kind"
  | "activity_label"
  | "error_type"
>;

export function decodeToolProjectionFields(raw: unknown): ToolProjectionFields {
  const value = expectRecord(raw, "tool projection");
  const legacy = LEGACY_TOOL_PROJECTION_FIELDS.find((field) => field in value);
  if (legacy !== undefined) {
    throw new Error(`Invalid legacy tool projection field: ${legacy}`);
  }

  const recordKind = expectOneOf(
    requireProjectionField(value, "record_kind"),
    TOOL_CONTRACT_PROJECTION.record_kinds,
    "record_kind",
  ) as ToolRecordKind;
  const canonicalToolId = expectNullableString(
    requireProjectionField(value, "canonical_tool_id"),
    "canonical_tool_id",
  );
  const providerWireName = expectNullableString(
    requireProjectionField(value, "provider_wire_name"),
    "provider_wire_name",
  );
  const rawEffect = requireProjectionField(value, "effect");
  const effect =
    rawEffect === null
      ? null
      : (expectOneOf(
          rawEffect,
          TOOL_CONTRACT_PROJECTION.effects,
          "effect",
        ) as ToolEffect);
  const resultKind = expectOneOf(
    requireProjectionField(value, "result_kind"),
    TOOL_CONTRACT_PROJECTION.result_kinds,
    "result_kind",
  ) as ToolResultKind;
  const activityLabel = expectString(
    requireProjectionField(value, "activity_label"),
    "activity_label",
  );
  if (activityLabel.length === 0) {
    throw new Error("Invalid tool projection: activity_label is empty");
  }
  const rawErrorType = requireProjectionField(value, "error_type");
  const errorType =
    rawErrorType === null
      ? null
      : (expectOneOf(
          rawErrorType,
          TOOL_CONTRACT_PROJECTION.error_types,
          "error_type",
        ) as ToolErrorType);

  const shape = TOOL_CONTRACT_PROJECTION.record_shapes[recordKind];
  const projection = {
    activity_label: activityLabel,
    canonical_tool_id: canonicalToolId,
    effect,
    error_type: errorType,
    provider_wire_name: providerWireName,
    record_kind: recordKind,
    result_kind: resultKind,
  };
  if (shape.non_null_fields.some((field) => projection[field] === null)) {
    throw new Error("Invalid tool projection: tagged field must be non-null");
  }
  if (shape.null_fields.some((field) => projection[field] !== null)) {
    throw new Error("Invalid tool projection: tagged field must be null");
  }
  if (
    recordKind === "current_execution" &&
    providerWireName !== null &&
    providerWireName !== canonicalToolId
  ) {
    throw new Error(
      "Invalid tool projection: current wire name differs from canonical identity",
    );
  }
  if (
    (recordKind === "attached_context" && resultKind !== "attached_context") ||
    (recordKind === "rejected_provider_call" &&
      resultKind !== "rejected_provider_call") ||
    ((recordKind === "current_execution" ||
      recordKind === "historical_execution") &&
      (resultKind === "attached_context" ||
        resultKind === "rejected_provider_call"))
  ) {
    throw new Error("Invalid tool projection: result kind disagrees with record kind");
  }

  return projection;
}

export function decodeMessageToolCall(raw: unknown): MessageToolCall {
  const value = expectRecord(raw, "tool projection");
  return {
    ...value,
    ...decodeToolProjectionFields(value),
  } as unknown as MessageToolCall;
}

/**
 * Decode a wire `reader_selection` field into an owned `Presence<ReaderSelectionOut>`.
 * A missing field (older wire that predates the quote cutover) is Absent; anything
 * present is strictly decoded, so a malformed `Present` snapshot throws.
 */
export function decodeReaderSelectionPresence(
  raw: unknown,
): Presence<ReaderSelectionOut> {
  if (raw === undefined || raw === null) return absent();
  return decodePresence(raw, (value) => {
    const out = decodeReaderSelectionOut(value);
    if (out === null) throw new Error("Invalid reader_selection wire value");
    return out;
  });
}

function decodeCitations(raw: unknown): CitationOut[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid message citations wire value");
  }
  return raw.map((entry) => {
    const citation = decodeCitationOut(entry);
    if (!citation) throw new Error("Invalid message citation wire value");
    return citation;
  });
}

function decodeTrustTrail(
  trail: AssistantTrustTrail | null,
): AssistantTrustTrail | null {
  if (trail === null) return null;
  return {
    ...trail,
    run:
      trail.run === null
        ? null
        : {
            ...trail.run,
            execution: decodeExecutionPresence(trail.run.execution),
          },
    citations: trail.citations.map((entry) => {
      const citation = decodeCitationOut(entry.citation);
      if (!citation) {
        throw new Error("Invalid trust-trail citation wire value");
      }
      return { ...entry, citation };
    }),
    context_refs_added: trail.context_refs_added.map((entry) => {
      const activation = normalizeResourceActivation(entry.activation);
      if (!activation) {
        throw new Error("Invalid trust-trail context activation wire value");
      }
      return { ...entry, activation };
    }),
    tool_calls: trail.tool_calls.map(decodeMessageToolCall),
  };
}

function decodeExecutionPresence(raw: unknown): Presence<DurableExecution> {
  return decodePresence(raw, (value) => decodeDurableExecution(value));
}

/** Decode one wire message, preserving already-owned scalar fields. */
export function decodeConversationMessage(
  message: ConversationMessage,
): ConversationMessage {
  const citations = decodeCitations(message.citations);
  return {
    ...message,
    ...(citations === undefined ? {} : { citations }),
    trust_trail: decodeTrustTrail(message.trust_trail),
    reader_selection: decodeReaderSelectionPresence(message.reader_selection),
  };
}

/** Decode each message of a wire list. */
export function decodeConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.map(decodeConversationMessage);
}

/**
 * Decode the reader-quote snapshot on the user and assistant messages of a
 * `POST /chat-runs` response (`ChatRunData`), preserving the run, conversation,
 * and stream-state fields.
 */
export function decodeChatRunData(
  data: ChatRunResponse["data"],
): ChatRunResponse["data"] {
  return {
    ...data,
    run: {
      ...data.run,
      execution: decodeExecutionPresence(data.run.execution),
    },
    user_message: decodeConversationMessage(data.user_message),
    assistant_message: decodeConversationMessage(data.assistant_message),
  };
}

/**
 * Decode the reader-quote snapshot on every message a conversation tree carries:
 * the selected path plus each cached fork path. Run at the fetch boundary so the
 * cached, decoded tree is applied to state idempotently.
 */
export function decodeConversationTree(
  tree: ConversationTreeResponse,
): ConversationTreeResponse {
  const pathCacheByLeafId: Record<string, ConversationMessage[]> = {};
  for (const [leafId, path] of Object.entries(tree.path_cache_by_leaf_id)) {
    pathCacheByLeafId[leafId] = decodeConversationMessages(path);
  }
  return {
    ...tree,
    selected_path: decodeConversationMessages(tree.selected_path),
    path_cache_by_leaf_id: pathCacheByLeafId,
  };
}
