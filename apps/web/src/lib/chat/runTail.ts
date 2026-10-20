import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";
import { openStream } from "@/lib/api/stream";
import { assertNever } from "@/lib/assertNever";
import type { Execution, Message } from "./wire";

// A pending answer's live overlay. The stream only paints; a message's status,
// text and trust trail change only when a server read replaces it.

type Events = {
  assistant_text_delta: Schema<"ChatRunAssistantTextDeltaEventPayload">;
  tool_call_start: Schema<"ChatRunToolCallStartEventOut">;
  tool_result: Schema<"ChatRunToolResultEventOut">;
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
export type MessageAction = Omit<Schema<"TrustToolCallOut">, "id"> & {
  readonly id: Schema<"TrustToolCallOut">["id"] | null;
};
type LiveAction = Omit<MessageAction, "id" | "machine_authorships" | "reverted_at">;
export type Live = Readonly<{
  runId: string;
  text: string;
  lastSeq: number;
  link: Link;
  execution: Execution | null;
  /** by call position; saved reads alone supply ids and undo state. */
  tools: Readonly<Record<number, LiveAction>>;
}>;

const TYPES = new Set<string>([
  "assistant_text_delta",
  "tool_call_start",
  "tool_result",
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

/** context_ref_added changes nothing: the terminal read carries it. */
export function foldLive(live: Live, event: ChatEvent): Live {
  if (event.seq > 0 && event.seq <= live.lastSeq) return live;
  const next = { ...live, lastSeq: Math.max(live.lastSeq, event.seq) };
  switch (event.type) {
    case "assistant_text_delta":
      return { ...next, text: live.text + event.data.text };
    case "tool_call_start":
    case "tool_result": {
      const previous = live.tools[event.data.tool_call_index];
      if (event.type === "tool_call_start" && previous) return next;
      const tool: LiveAction = {
        tool_call_index: event.data.tool_call_index,
        canonical_tool_id: event.data.canonical_tool_id,
        effect: event.data.effect,
        result_kind: event.data.result_kind,
        activity: event.data.activity,
        error_type: event.data.error_type,
        status: event.type === "tool_result" ? event.data.status : "running",
        retrievals: event.type === "tool_result" ? event.data.retrievals : [],
        created_refs: event.type === "tool_result" ? event.data.created_refs : [],
      };
      return {
        ...next,
        tools: { ...live.tools, [event.data.tool_call_index]: tool },
      };
    }
    case "ExecutionAdvisory":
      return { ...next, execution: event.data };
    case "context_ref_added":
    case "done":
      return next;
    default:
      return assertNever(event);
  }
}

/** saved terminal calls win over replay; stream-only calls cannot authorize undo. */
export function messageActions(
  message: Message,
  live: Pick<Live, "runId" | "tools"> | null,
): readonly MessageAction[] {
  const saved = message.trust_trail?.tool_calls ?? [];
  if (message.status !== "pending" || !live || live.runId !== message.trust_trail?.run.run_id) {
    return saved;
  }
  const actions = new Map<number, MessageAction>(saved.map((call) => [call.tool_call_index, call]));
  for (const call of Object.values(live.tools)) {
    const recorded = actions.get(call.tool_call_index);
    if (recorded && recorded.status !== "running") continue;
    actions.set(call.tool_call_index, recorded ? { ...recorded, ...call } : {
      ...call,
      id: null,
      machine_authorships: [],
      reverted_at: null,
    });
  }
  return [...actions.values()].sort((left, right) => left.tool_call_index - right.tool_call_index);
}

/** Tail a run's event log after `after`; `end` fires once unless stopped. */
export function openRunTail(
  runId: string,
  after: number,
  on: { event(event: ChatEvent): void; end(reason: "done" | "lost"): void },
): () => void {
  return openStream<ChatEvent>({
    path: `/api/stream/chat-runs/${encodeURIComponent(runId)}/events`,
    after: String(after),
    decode: (type, data, id) => {
      if (!TYPES.has(type)) throw new Error(`Unknown chat event type: ${type}`);
      // justify-type-assertion: the same deploy validates each public payload before emission.
      return { seq: Number(id || 0), type, data } as ChatEvent;
    },
    isTerminal: (event) => event.type === "done",
    onEvent: on.event,
    onError: (error) => {
      console.error("Chat run stream ended without its terminal event:", error);
      on.end("lost");
    },
    onComplete: () => on.end("done"),
    maxBackoffMs: 8_000,
  });
}
