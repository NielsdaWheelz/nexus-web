/**
 * The conversation-message wire boundary: decode nested transport values once,
 * where server messages enter the client.
 *
 * A `ConversationMessage` arrives from several transports (the messages GET,
 * conversation tree, canonical run reads, candidate actions, reconnect, and
 * active-runs). Each carries a `reader_selection` field that is a
 * `Presence<ReaderSelectionOut>` on the forward wire. These helpers decode it
 * into the owned `Presence<ReaderSelectionOut>` the model and view code consume
 * (`docs/rules/boundaries.md`: decode once at the boundary).
 *
 * Only a quoted user message carries a `Present` snapshot; the assistant message
 * and every non-quote message is `Absent`. The client never fabricates a
 * snapshot — the optimistic seed leaves it Absent, and the real snapshot rides in
 * only on the server-returned user message.
 */

import {
  decodeChatRunExecution,
  type ChatRunExecution,
} from "@/lib/api/executionAdvisory";
import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodeReaderSelectionOut,
  type ReaderSelectionOut,
} from "@/lib/conversations/readerSelection";
import {
  decodeCitationOut,
  type CitationOut,
} from "@/lib/conversations/citationOut";
import { decodeTrustToolCall } from "@/lib/conversations/trustToolCallWire";
import { decodeNullableExpectedChatFailure } from "@/lib/conversations/chatFailureContract";
import { decodeRunSelectionOut } from "@/lib/conversations/generationCatalog";
import type {
  AssistantTrustTrail,
  ChatPublicationWarning,
  ChatRun,
  ChatRunListResponse,
  ChatRunResponse,
  ChatRunStreamState,
  ConversationMessage,
  ConversationTreeResponse,
} from "@/lib/conversations/types";
import { normalizeResourceActivation } from "@/lib/resources/activation";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectNonnegativeInteger,
  expectNullableNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

const RUN_STATUSES = [
  "queued",
  "running",
  "complete",
  "error",
  "cancelled",
] as const;
const TRUST_RUN_STATUSES = [
  "pending",
  "running",
  "complete",
  "error",
  "cancelled",
] as const;
const STREAM_ACTIVITY_PHASES = [
  "queued",
  "thinking",
  "writing",
  "tool_calling",
  "waiting",
  "retrying",
  "cancelling",
] as const;

const CHAT_RUN_KEYS = [
  "id",
  "status",
  "conversation_id",
  "user_message_id",
  "assistant_message_id",
  "run_selection",
  "support_id",
  "publication_warning",
  "failure",
  "execution",
  "started_at",
  "completed_at",
  "error_code",
  "created_at",
  "updated_at",
] as const;

const TRUST_TRAIL_KEYS = [
  "schema_version",
  "assistant_message_id",
  "conversation_id",
  "chat_run_id",
  "status",
  "run",
  "prompt",
  "tool_calls",
  "citations",
  "context_refs_added",
  "integrity_notices",
  "created_at",
  "updated_at",
] as const;

const TRUST_RUN_KEYS = [
  "run_id",
  "run_selection",
  "status",
  "usage",
  "error_code",
  "support_id",
  "publication_warning",
  "failure",
  "execution",
  "final_chars",
  "started_at",
  "completed_at",
] as const;

const RETIRED_GENERATION_FIELDS = [
  "provider",
  "provider_label",
  "reasoning_option_id",
  "total_cost_usd_micros",
  "attempts",
] as const;

function rejectRetiredGenerationFields(
  value: Record<string, unknown>,
  name: string,
): void {
  const retired = RETIRED_GENERATION_FIELDS.find((key) => key in value);
  if (retired !== undefined) {
    throw new TypeError(`${name} contains retired field ${retired}`);
  }
}

/**
 * Decode a wire `reader_selection` field into an owned `Presence<ReaderSelectionOut>`.
 * Both variants are strictly decoded; omission, null, and a malformed `Present`
 * snapshot are same-system defects.
 */
export function decodeReaderSelectionPresence(
  raw: unknown,
): Presence<ReaderSelectionOut> {
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

function decodePublicationWarningPresence(
  raw: unknown,
): Presence<ChatPublicationWarning> {
  return decodePresence(raw, (value) => {
    const warning = expectExactRecord(
      value,
      ["code"],
      "chat publication warning",
    );
    if (warning.code !== "CitationsUnavailable") {
      throw new TypeError(
        'chat publication warning.code must be "CitationsUnavailable"',
      );
    }
    return { code: "CitationsUnavailable" };
  });
}

function decodeNullableRecord(
  raw: unknown,
  name: string,
): Record<string, unknown> | null {
  return raw === null ? null : expectRecord(raw, name);
}

function decodeChatRun(raw: unknown): ChatRun {
  const run = expectExactRecord(raw, CHAT_RUN_KEYS, "chat run");
  return {
    id: expectString(run.id, "chat run.id"),
    status: expectOneOf(run.status, RUN_STATUSES, "chat run.status"),
    conversation_id: expectString(
      run.conversation_id,
      "chat run.conversation_id",
    ),
    user_message_id: expectString(
      run.user_message_id,
      "chat run.user_message_id",
    ),
    assistant_message_id: expectString(
      run.assistant_message_id,
      "chat run.assistant_message_id",
    ),
    run_selection: decodeRunSelectionOut(
      run.run_selection,
      "chat run.run_selection",
    ),
    support_id: decodePresence(run.support_id, (value) =>
      expectString(value, "chat run.support_id.value"),
    ),
    publication_warning: decodePublicationWarningPresence(
      run.publication_warning,
    ),
    failure: decodeNullableExpectedChatFailure(run.failure),
    execution: decodeExecutionPresence(run.execution),
    started_at: expectNullableString(run.started_at, "chat run.started_at"),
    completed_at: expectNullableString(
      run.completed_at,
      "chat run.completed_at",
    ),
    error_code: expectNullableString(run.error_code, "chat run.error_code"),
    created_at: expectString(run.created_at, "chat run.created_at"),
    updated_at: expectString(run.updated_at, "chat run.updated_at"),
  };
}

function decodeTrustRun(
  raw: unknown,
): NonNullable<AssistantTrustTrail["run"]> | null {
  if (raw === null) return null;
  const run = expectExactRecord(raw, TRUST_RUN_KEYS, "assistant trust run");
  const usage = decodeNullableRecord(run.usage, "assistant trust run.usage");
  return {
    run_id: expectString(run.run_id, "assistant trust run.run_id"),
    run_selection: decodeRunSelectionOut(
      run.run_selection,
      "assistant trust run.run_selection",
    ),
    status: expectOneOf(
      run.status,
      TRUST_RUN_STATUSES,
      "assistant trust run.status",
    ),
    usage,
    error_code: expectNullableString(
      run.error_code,
      "assistant trust run.error_code",
    ),
    support_id: decodePresence(run.support_id, (value) =>
      expectString(value, "assistant trust run.support_id.value"),
    ),
    publication_warning: decodePublicationWarningPresence(
      run.publication_warning,
    ),
    failure: decodeNullableExpectedChatFailure(run.failure),
    execution: decodeExecutionPresence(run.execution),
    final_chars: expectNullableNonnegativeInteger(
      run.final_chars,
      "assistant trust run.final_chars",
    ),
    started_at: expectNullableString(
      run.started_at,
      "assistant trust run.started_at",
    ),
    completed_at: expectNullableString(
      run.completed_at,
      "assistant trust run.completed_at",
    ),
  };
}

function decodeTrustTrail(raw: unknown): AssistantTrustTrail | null {
  if (raw === null) return null;
  const value = expectExactRecord(raw, TRUST_TRAIL_KEYS, "assistant trust trail");
  if (value.schema_version !== "assistant_trust_trail.v1") {
    throw new TypeError(
      'assistant trust trail.schema_version must be "assistant_trust_trail.v1"',
    );
  }
  const trail = value as unknown as AssistantTrustTrail;
  return {
    ...trail,
    run: decodeTrustRun(value.run),
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
    tool_calls: trail.tool_calls.map(decodeTrustToolCall),
  };
}

function decodeExecutionPresence(raw: unknown): Presence<ChatRunExecution> {
  return decodePresence(raw, (value) => decodeChatRunExecution(value));
}

/** Decode one wire message, preserving already-owned scalar fields. */
export function decodeConversationMessage(raw: unknown): ConversationMessage {
  const record = expectRecord(raw, "conversation message");
  rejectRetiredGenerationFields(record, "conversation message");
  const message = record as unknown as ConversationMessage;
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
  messages: unknown,
): ConversationMessage[] {
  return expectArray(
    messages,
    (message) => decodeConversationMessage(message),
    "conversation messages",
  );
}

/**
 * Decode the reader-quote snapshot on the user and assistant messages of a
 * rich `ChatRunData` projection from canonical run reads and candidate-action
 * responses, preserving the run, conversation, and stream-state fields. Send
 * admission returns a receipt and is decoded by its separate boundary.
 */
export function decodeChatRunData(raw: unknown): ChatRunResponse["data"] {
  const data = expectExactRecord(
    raw,
    [
      "run",
      "conversation",
      "user_message",
      "assistant_message",
      "stream_state",
    ],
    "chat run response data",
  );
  return {
    run: decodeChatRun(data.run),
    conversation: expectRecord(
      data.conversation,
      "chat run response conversation",
    ) as unknown as ChatRunResponse["data"]["conversation"],
    user_message: decodeConversationMessage(data.user_message),
    assistant_message: decodeConversationMessage(data.assistant_message),
    stream_state: decodeChatRunStreamState(data.stream_state),
  };
}

/** Decode the common read/cancel/rerun chat-run response envelope. */
export function decodeChatRunResponse(raw: unknown): ChatRunResponse {
  const response = expectExactRecord(raw, ["data"], "chat run response");
  return { data: decodeChatRunData(response.data) };
}

/** Decode the active-runs collection without trusting its generic fetch type. */
export function decodeChatRunListResponse(raw: unknown): ChatRunListResponse {
  const response = expectExactRecord(raw, ["data"], "chat run list response");
  return {
    data: expectArray(
      response.data,
      (entry) => decodeChatRunData(entry),
      "chat run list response.data",
    ),
  };
}

function decodeChatRunStreamState(raw: unknown): ChatRunStreamState {
  const stream = expectExactRecord(
    raw,
    [
      "status",
      "last_event_seq",
      "folded_event_seq",
      "assistant_current_text",
      "tool_calls",
      "activity",
      "reconnectable",
      "terminal",
    ],
    "chat run stream state",
  );
  let activity: ChatRunStreamState["activity"] = null;
  if (stream.activity !== null) {
    const value = expectExactRecord(
      stream.activity,
      ["phase", "label"],
      "chat run stream state.activity",
    );
    activity = {
      phase: expectOneOf(
        value.phase,
        STREAM_ACTIVITY_PHASES,
        "chat run stream state.activity.phase",
      ),
      label: expectNullableString(
        value.label,
        "chat run stream state.activity.label",
      ),
    };
  }
  const toolCalls = expectArray(
    stream.tool_calls,
    (value) => expectRecord(value, "chat run stream state.tool_calls[]"),
    "chat run stream state.tool_calls",
  ) as unknown as ChatRunStreamState["tool_calls"];
  return {
    status: expectOneOf(
      stream.status,
      RUN_STATUSES,
      "chat run stream state.status",
    ),
    last_event_seq: expectNonnegativeInteger(
      stream.last_event_seq,
      "chat run stream state.last_event_seq",
    ),
    folded_event_seq: expectNonnegativeInteger(
      stream.folded_event_seq,
      "chat run stream state.folded_event_seq",
    ),
    assistant_current_text: expectString(
      stream.assistant_current_text,
      "chat run stream state.assistant_current_text",
    ),
    tool_calls: toolCalls,
    activity,
    reconnectable: expectBoolean(
      stream.reconnectable,
      "chat run stream state.reconnectable",
    ),
    terminal: expectBoolean(stream.terminal, "chat run stream state.terminal"),
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
