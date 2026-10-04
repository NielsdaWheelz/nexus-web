/**
 * SSE chat-run event types and dispatcher.
 *
 * Framing rules:
 * 1. Only process `event:` + `data:` lines.
 * 2. Ignore comment lines (`:`); unknown event types are stream errors.
 * 3. `data:` payload is JSON, one object per event.
 * 4. Max event size: 256 KB. Exceeding this is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 */

import type { Schema } from "@/lib/api/wire";
import { isRecord } from "@/lib/validation";
import {
  decodeChatExecutionAdvisory,
  EXECUTION_ADVISORY_EVENT_TYPE,
  type ChatRunExecution,
} from "@/lib/api/executionAdvisory";
import {
  decodeToolProjectionFields,
  type ToolProjectionFields,
} from "@/lib/conversations/toolProjectionWire";
import { TOOL_CONTRACT_PROJECTION } from "@/lib/conversations/toolContractProjection";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { hasOnlyKeys, isOptionalString } from "./guards";

/** Meta event: initial IDs and immutable dispatch selection snapshot. */
interface SSEMetaEvent {
  type: "meta";
  data: Schema<"ChatRunMetaEventPayload">;
}

interface SSEAssistantActivityEvent {
  type: "assistant_activity";
  data: Schema<"ChatRunAssistantActivityEventPayload">;
}

interface SSEExecutionAdvisoryEvent {
  type: "ExecutionAdvisory";
  data: ChatRunExecution;
}

/** Incremental assistant content. */
interface SSEAssistantTextDeltaEvent {
  type: "assistant_text_delta";
  data: Schema<"ChatRunAssistantTextDeltaEventPayload">;
}

/** Done event: stream completion. */
interface SSEDoneEvent {
  type: "done";
  data: Schema<"ChatRunDoneEventPayload">;
}

export interface SSEToolCallEvent {
  type: "tool_call_start";
  data: Schema<"ChatRunToolCallStartEventOut">;
}

type LegacyToolCallData = ToolProjectionFields & {
  tool_call_id?: string | null;
  assistant_message_id: string;
  tool_call_index: number;
  provider_tool_call_id?: string | null;
  provider_event_seq_start: number;
  provider_event_seq_end: number;
};

export interface SSEToolCallDeltaEvent {
  type: "tool_call_delta";
  data: LegacyToolCallData & {
    input_delta: string;
    input_preview?: string | null;
  };
}

export interface SSEToolCallDoneEvent {
  type: "tool_call_done";
  data: Schema<"ChatRunToolCallDoneEventOut">;
}

export interface SSEToolResultEvent {
  type: "tool_result";
  data: Schema<"ChatRunToolResultEventOut">;
}

export interface SSECitationIndexEvent {
  type: "citation_index";
  data: Schema<"ChatRunCitationIndexEventPayload">;
}

/** Enrich the generated wire with the canonical action subject. */
export interface SSEContextRefAddedEvent {
  type: "context_ref_added";
  data: Schema<"ChatRunContextRefAddedEventPayload"> &
    Pick<ContextRefOut, "actionSubject">;
}

export type SSEEvent = (
  | SSEMetaEvent
  | SSEAssistantActivityEvent
  | SSEAssistantTextDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSEToolCallDeltaEvent
  | SSEToolCallDoneEvent
  | SSEToolResultEvent
  | SSECitationIndexEvent
  | SSEContextRefAddedEvent
  | SSEExecutionAdvisoryEvent
) & { seq: number };

function parseToolCallStartData(data: unknown): LegacyToolCallData {
  const projection = decodeToolProjectionFields(data);
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      ...TOOL_CONTRACT_PROJECTION.fields,
      "tool_call_id",
      "assistant_message_id",
      "tool_call_index",
      "provider_tool_call_id",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.tool_call_index !== "number" ||
    !Number.isInteger(data.tool_call_index) ||
    data.tool_call_index < 0 ||
    (data.tool_call_id !== undefined &&
      data.tool_call_id !== null &&
      typeof data.tool_call_id !== "string") ||
    !isOptionalString(data.provider_tool_call_id) ||
    typeof data.provider_event_seq_start !== "number" ||
    !Number.isInteger(data.provider_event_seq_start) ||
    data.provider_event_seq_start < 0 ||
    typeof data.provider_event_seq_end !== "number" ||
    !Number.isInteger(data.provider_event_seq_end) ||
    data.provider_event_seq_end < 0
  ) {
    throw new Error("Invalid SSE payload for tool_call_start");
  }
  // justify-type-assertion: the guards validate this legacy shape; a record spread cannot retain its type.
  return { ...data, ...projection } as LegacyToolCallData;
}

function parseToolCallDeltaData(data: unknown): SSEToolCallDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      ...TOOL_CONTRACT_PROJECTION.fields,
      "tool_call_id",
      "assistant_message_id",
      "tool_call_index",
      "provider_tool_call_id",
      "input_delta",
      "input_preview",
      "provider_event_seq_start",
      "provider_event_seq_end",
    ]) ||
    typeof data.input_delta !== "string" ||
    data.input_delta.length === 0 ||
    !isOptionalString(data.input_preview)
  ) {
    throw new Error("Invalid SSE payload for tool_call_delta");
  }
  const { input_delta, input_preview, ...base } = data;
  return {
    ...parseToolCallStartData(base),
    input_delta: input_delta,
    input_preview,
  };
}

export function toChatSSEEvent(
  eventType: string,
  data: unknown,
  id = "",
): SSEEvent {
  if (eventType === EXECUTION_ADVISORY_EVENT_TYPE) {
    return {
      seq: 0,
      type: EXECUTION_ADVISORY_EVENT_TYPE,
      data: decodeChatExecutionAdvisory(data, id),
    };
  }
  const seq = Number(id || 0);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("Invalid SSE event id");
  }
  switch (eventType) {
    case "meta":
      // justify-type-assertion: chat_run_event_payload_json validates this shape; generic sse json remains unknown.
      return { seq, type: "meta", data: data as SSEMetaEvent["data"] };
    case "assistant_activity":
      // justify-type-assertion: chat_run_event_payload_json validates this shape; generic sse json remains unknown.
      return {
        seq,
        type: "assistant_activity",
        data: data as SSEAssistantActivityEvent["data"],
      };
    case "assistant_text_delta":
      // justify-type-assertion: chat_run_event_payload_json validates this shape; generic sse json remains unknown.
      return {
        seq,
        type: "assistant_text_delta",
        data: data as SSEAssistantTextDeltaEvent["data"],
      };
    case "done":
      // justify-type-assertion: chat_run_event_payload_json validates this shape; generic sse json remains unknown.
      return { seq, type: "done", data: data as SSEDoneEvent["data"] };
    case "tool_call_start":
      // justify-type-assertion: validated storage and public tool projection own this shape; generic sse json remains unknown.
      return {
        seq,
        type: "tool_call_start",
        data: data as SSEToolCallEvent["data"],
      };
    case "tool_call_delta":
      return {
        seq,
        type: "tool_call_delta",
        data: parseToolCallDeltaData(data),
      };
    case "tool_call_done":
      // justify-type-assertion: validated storage and public tool projection own this shape; generic sse json remains unknown.
      return { seq, type: "tool_call_done", data: data as SSEToolCallDoneEvent["data"] };
    case "tool_result":
      // justify-type-assertion: validated storage and public tool projection own this shape; generic sse json remains unknown.
      return { seq, type: "tool_result", data: data as SSEToolResultEvent["data"] };
    case "citation_index":
      // justify-type-assertion: chat_run_event_payload_json validates this shape; generic sse json remains unknown.
      return {
        seq,
        type: "citation_index",
        data: data as SSECitationIndexEvent["data"],
      };
    case "context_ref_added": {
      // justify-type-assertion: validated storage owns this shape; generic sse json remains unknown; ref correlation is checked below.
      const contextRef = data as Schema<"ChatRunContextRefAddedEventPayload">;
      const actionSubject = {
        ref: assumeCanonicalResourceRef(contextRef.resource_ref),
      };
      if (contextRef.activation.resource_ref !== actionSubject.ref) {
        throw new TypeError(
          "context_ref_added.data.activation.resource_ref must equal context_ref_added.data.resource_ref",
        );
      }
      return {
        seq,
        type: "context_ref_added",
        data: { ...contextRef, actionSubject },
      };
    }
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
