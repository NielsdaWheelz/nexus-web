/** Same-deploy chat JSON read projections into the owned conversation domain. */

import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  decodeReaderSelectionOut,
  type ReaderSelectionOut,
} from "@/lib/conversations/readerSelection";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { decodeTrustToolCall } from "@/lib/conversations/trustToolCallWire";
import type {
  AssistantTrustTrail,
  ChatRunListResponse,
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
} from "@/lib/conversations/types";
import { normalizeResourceActivation } from "@/lib/resources/activation";

type WireMessage = Schema<"MessageOut">;

function citationFromWire(wire: Schema<"CitationOut">): CitationOut {
  const activation = normalizeResourceActivation(wire.activation);
  if (activation === null) throw new Error("Invalid message citation activation");
  return { ...wire, activation };
}

function trustTrailFromWire(wire: Schema<"AssistantTrustTrailOut">): AssistantTrustTrail {
  return {
    ...wire,
    citations: wire.citations.map((entry) => ({
      ...entry,
      citation: citationFromWire(entry.citation),
    })),
    context_refs_added: wire.context_refs_added.map((entry) => {
      const activation = normalizeResourceActivation(entry.activation);
      if (activation === null) throw new Error("Invalid trust context activation");
      return { ...entry, activation };
    }),
    tool_calls: wire.tool_calls.map(decodeTrustToolCall),
  };
}

function readerSelectionFromWire(
  wire: WireMessage["reader_selection"],
): ConversationMessage["reader_selection"] {
  if (wire.kind === "Absent") return wire;
  const value: ReaderSelectionOut | null = decodeReaderSelectionOut(wire.value);
  if (value === null) throw new Error("Invalid reader_selection wire value");
  return { kind: "Present", value };
}

function messageFromWire(wire: WireMessage): ConversationMessage {
  return {
    ...wire,
    citations: wire.citations.map(citationFromWire),
    trust_trail: wire.trust_trail === null ? null : trustTrailFromWire(wire.trust_trail),
    reader_selection: readerSelectionFromWire(wire.reader_selection),
  };
}

function messagesFromWire(messages: WireMessage[]): ConversationMessage[] {
  return messages.map(messageFromWire);
}

function chatRunDataFromWire(wire: Schema<"ChatRunResponse">): ChatRunResponse["data"] {
  return {
    run: wire.run,
    conversation: wire.conversation,
    user_message: messageFromWire(wire.user_message),
    assistant_message: messageFromWire(wire.assistant_message),
    stream_state: wire.stream_state,
  };
}

export function chatRunFromWire(
  wire: ApiJson<"/chat-runs/{run_id}", "get">,
): ChatRunResponse {
  return { data: chatRunDataFromWire(wire.data) };
}

export function chatRunListFromWire(
  wire: ApiJson<"/chat-runs", "get">,
): ChatRunListResponse {
  return { data: wire.data.map(chatRunDataFromWire) };
}

export function conversationTreeFromWire(
  wire: Schema<"ConversationTreeOut">,
): ConversationTreeResponse {
  const pathCacheByLeafId: Record<string, ConversationMessage[]> = {};
  for (const [leafId, path] of Object.entries(wire.path_cache_by_leaf_id)) {
    pathCacheByLeafId[leafId] = messagesFromWire(path);
  }
  return {
    ...wire,
    selected_path: messagesFromWire(wire.selected_path),
    path_cache_by_leaf_id: pathCacheByLeafId,
  };
}
