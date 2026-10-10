import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";
import { openGenerationRunStream } from "@/lib/api/generationRunStream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { Execution } from "./wire";

// A pending answer's live overlay. The stream only paints; a message's status,
// text and trust trail change only when a server read replaces it.

type Events = {
  meta: Schema<"ChatRunMetaEventPayload">;
  assistant_activity: Schema<"ChatRunAssistantActivityEventPayload">;
  assistant_text_delta: Schema<"ChatRunAssistantTextDeltaEventPayload">;
  tool_call_start: Schema<"ChatRunToolCallStartEventOut">;
  tool_call_done: Schema<"ChatRunToolCallDoneEventOut">;
  tool_result: Schema<"ChatRunToolResultEventOut">;
  citation_index: Schema<"ChatRunCitationIndexEventPayload">;
  context_ref_added: Schema<"ChatRunContextRefAddedEventPayload">;
  done: Schema<"ChatRunDoneEventPayload">;
  ExecutionAdvisory: Execution;
};
export type ChatEvent = { seq: number } & {
  [Type in keyof Events]: { type: Type; data: Events[Type] };
}[keyof Events];
export type Link =
  | { kind: "Live" }
  | { kind: "Lost" }
  | { kind: "Reconnecting" }
  | { kind: "Failed"; feedback: FeedbackContent; retryable: boolean };
export type Live = Readonly<{
  runId: string;
  text: string;
  lastSeq: number;
  link: Link;
  execution: Execution | null;
  /** By tool call index; the activity line is the newest running label. */
  tools: Readonly<Record<number, { label: string; running: boolean }>>;
}>;

const TYPES = new Set<string>([
  "meta",
  "assistant_activity",
  "assistant_text_delta",
  "tool_call_start",
  "tool_call_done",
  "tool_result",
  "citation_index",
  "context_ref_added",
  "done",
  "ExecutionAdvisory",
]);

export function emptyLive(runId: string): Live {
  return {
    runId,
    text: "",
    lastSeq: 0,
    link: { kind: "Live" },
    execution: null,
    tools: {},
  };
}

/** Meta, citation_index and context_ref_added change nothing: the terminal read carries them. */
export function foldLive(live: Live, event: ChatEvent): Live {
  if (event.seq > 0 && event.seq <= live.lastSeq) return live;
  const next = { ...live, lastSeq: Math.max(live.lastSeq, event.seq) };
  switch (event.type) {
    case "assistant_text_delta":
      return { ...next, text: live.text + event.data.text };
    case "tool_call_start":
    case "tool_call_done":
    case "tool_result": {
      const tool = {
        label: event.data.activity_label,
        running: event.type !== "tool_result",
      };
      return {
        ...next,
        tools: { ...live.tools, [event.data.tool_call_index]: tool },
      };
    }
    case "ExecutionAdvisory":
      return { ...next, execution: event.data };
    default:
      return next;
  }
}

/** Tail a run's event log after `after`; `end` fires once unless aborted. */
export function openRunTail(
  runId: string,
  after: number,
  on: { event(event: ChatEvent): void; end(reason: "done" | "lost"): void },
): () => void {
  const controller = new AbortController();
  const end = (reason: "done" | "lost") => {
    if (!controller.signal.aborted) on.end(reason);
    controller.abort();
  };
  openGenerationRunStream<ChatEvent>("chat-runs", runId, {
    decode: (type, data, id) => {
      if (!TYPES.has(type)) throw new Error(`Unknown SSE event type: ${type}`);
      // justify-type-assertion: the same deploy validated each payload on write.
      return { seq: Number(id || 0), type, data } as ChatEvent;
    },
    isTerminal: (event) => event.type === "done",
    onEvent: (event) => {
      if (!controller.signal.aborted) on.event(event);
    },
    onError: (error) => {
      console.error("Chat run stream ended without its terminal event:", error);
      end("lost");
    },
    onComplete: (terminal) => end(terminal ? "done" : "lost"),
    initialAfter: String(after),
    maxReconnects: 8,
    backoff: { baseMs: 1000, maxMs: 8000, jitterMs: 250 },
    signal: controller.signal,
  }).catch((error: unknown) => {
    if (!handleUnauthenticatedApiError(error)) end("lost");
  });
  return () => controller.abort();
}
