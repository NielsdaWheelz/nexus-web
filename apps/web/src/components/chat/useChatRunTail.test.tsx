import { renderHook, act, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import { messageUpdateReducer } from "@/lib/conversations/messageUpdateReducer";
import type { RunVisibilityContext } from "@/lib/conversations/runVisibility";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";
import type { SSEEvent } from "@/lib/api/sse/events";

// Drive the live orchestrator (real PerRunStreamContext + real messageUpdate
// reducer + real useChatMessageUpdates fold layer) and mock only the external
// streaming boundary: the BFF stream-token mint and the direct SSE client. The
// real `openGenerationRunStream` runs, so token-mint → connect wiring, the
// supersession/first-delta/abort lifecycle, the visibility gate, and the
// reconnect→reconcile path are all exercised end to end. fetch (apiFetch for
// reconcile) is stubbed at the boundary. This is the integration seam the
// engine suite (useConversation.test.tsx) cannot cover because it mocks the
// whole hook.
const streamMocks = vi.hoisted(() => ({
  fetchStreamToken: vi.fn(),
  sseClientDirect: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: streamMocks.fetchStreamToken,
}));

vi.mock("@/lib/api/sse-client", () => ({
  sseClientDirect: streamMocks.sseClientDirect,
}));

const timestamp = "2026-01-01T00:00:00Z";
const RUN_ID = "run-1";
const CONVERSATION_ID = "conversation-1";
const USER_ID = "user-1";
const ASSISTANT_ID = "assistant-1";

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  content: string,
  parentMessageId: string | null = null,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: content
        ? [
            {
              type: "text",
              format: role === "assistant" ? "markdown" : "plain",
              text: content,
            },
          ]
        : [],
    },
    parent_message_id: parentMessageId,
    trust_trail:
      role === "assistant"
        ? {
            schema_version: "assistant_trust_trail.v1",
            assistant_message_id: id,
            conversation_id: CONVERSATION_ID,
            chat_run_id: null,
            status,
            run: null,
            prompt: null,
            tool_calls: [],
            citations: [],
            context_refs_added: [],
            integrity_notices: [],
            created_at: timestamp,
            updated_at: timestamp,
          }
        : null,
    status,
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const conversationSummary = {
  id: CONVERSATION_ID,
  title: "Tail chat",
  sharing: "private" as const,
  message_count: 2,
  created_at: timestamp,
  updated_at: timestamp,
};

/** The optimistic pair the engine seeds before tailing; ids match the run. */
function seededPair(): ConversationMessage[] {
  return [
    message(USER_ID, 1, "user", "Hello there"),
    message(ASSISTANT_ID, 2, "assistant", "", USER_ID, "pending"),
  ];
}

function chatRunData(foldedSeq = 0): ChatRunResponse["data"] {
  return {
    run: {
      id: RUN_ID,
      status: "running",
      conversation_id: CONVERSATION_ID,
      user_message_id: USER_ID,
      assistant_message_id: ASSISTANT_ID,
      profile_id: "balanced",
      reasoning_option_id: "default",
      provider: null,
      model_name: null,
      reasoning_effort: null,
      error_origin: null,
      support_id: null,
      failure: null,
      cancel_requested_at: null,
      started_at: timestamp,
      completed_at: null,
      error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    conversation: conversationSummary,
    user_message: message(USER_ID, 1, "user", "Hello there"),
    assistant_message: message(ASSISTANT_ID, 2, "assistant", "", USER_ID, "pending"),
    stream_state: {
      status: "running",
      last_event_seq: foldedSeq,
      folded_event_seq: foldedSeq,
      assistant_current_text: "",
      tool_calls: [],
      activity: null,
      reconnectable: true,
      terminal: false,
    },
  };
}

function metaEvent(seq: number): SSEEvent {
  return {
    seq,
    type: "meta",
    data: {
      run_id: RUN_ID,
      conversation_id: CONVERSATION_ID,
      user_message_id: USER_ID,
      assistant_message_id: ASSISTANT_ID,
      profile_id: "balanced",
      reasoning_option_id: "default",
      chat_subject: null,
    },
  };
}

function deltaEvent(seq: number, text: string): SSEEvent {
  return {
    seq,
    type: "assistant_text_delta",
    data: {
      assistant_message_id: ASSISTANT_ID,
      text,
      provider_event_seq_start: seq,
      provider_event_seq_end: seq,
    },
  };
}

function doneEvent(
  seq: number,
  status: "complete" | "error" | "cancelled" = "complete",
  errorCode: string | null = null,
): SSEEvent {
  return { seq, type: "done", data: { status, error_code: errorCode } };
}

// The slice of the sseClientDirect options the tailer wires up and the test drives.
interface CapturedSse {
  onEvent: (event: SSEEvent) => void;
  onReconnect?: (attempt: number) => Promise<unknown>;
  onComplete?: (terminalEventSeen: boolean) => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
  initialAfter?: string;
}

function lastSse(): CapturedSse {
  const calls = streamMocks.sseClientDirect.mock.calls as unknown as Array<
    [CapturedSse]
  >;
  const options = calls.at(-1)?.[0];
  if (!options) throw new Error("sseClientDirect was not called");
  return options;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(input, init),
    ),
  );
}

function useHarness(opts: {
  onFirstDelta?: (runId: string) => void;
  onRunDone?: (
    runId: string,
    status: "complete" | "error" | "cancelled",
  ) => void;
  onRunFinished?: (runId: string) => void;
  shouldStartRun?: (ctx: RunVisibilityContext) => boolean;
  shouldApplyRun?: (ctx: RunVisibilityContext) => boolean;
}) {
  const [messages, dispatch] = useReducer(
    messageUpdateReducer,
    [] as ConversationMessage[],
  );
  const tail = useChatRunTail({ dispatch, ...opts });
  return { messages, dispatch, ...tail };
}

function assistantText(messages: ConversationMessage[]): string {
  const assistant = messages.find((m) => m.id === ASSISTANT_ID);
  return (assistant?.message_document?.blocks ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

describe("useChatRunTail", () => {
  beforeEach(() => {
    streamMocks.fetchStreamToken.mockReset();
    streamMocks.fetchStreamToken.mockResolvedValue({
      token: "stream-token",
      stream_base_url: "http://stream.test",
    });
    streamMocks.sseClientDirect.mockReset();
    streamMocks.sseClientDirect.mockReturnValue(vi.fn());
    stubFetch(() => jsonResponse({}, 404));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams meta → deltas → done through the real reducer and per-run context", async () => {
    const onFirstDelta = vi.fn();
    const onRunDone = vi.fn();
    const { result } = renderHook(() => useHarness({ onFirstDelta, onRunDone }));

    act(() => {
      result.current.dispatch({ type: "set_all", messages: seededPair() });
    });
    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    const sse = lastSse();
    await act(async () => {
      sse.onEvent(metaEvent(1));
      sse.onEvent(deltaEvent(2, "Hello "));
      sse.onEvent(deltaEvent(3, "world"));
    });

    expect(onFirstDelta).toHaveBeenCalledTimes(1);

    await act(async () => {
      sse.onEvent(doneEvent(4, "complete"));
    });

    expect(onRunDone).toHaveBeenCalledWith(RUN_ID, "complete");
    await waitFor(() =>
      expect(assistantText(result.current.messages)).toBe("Hello world"),
    );
    const assistant = result.current.messages.find((m) => m.id === ASSISTANT_ID);
    expect(assistant?.status).toBe("complete");
  });

  it("drops superseded events and aborts the live stream after abortAll", async () => {
    const onFirstDelta = vi.fn();
    const { result } = renderHook(() => useHarness({ onFirstDelta }));

    act(() => {
      result.current.dispatch({ type: "set_all", messages: seededPair() });
    });
    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    const sse = lastSse();
    await act(async () => {
      sse.onEvent(metaEvent(1));
      sse.onEvent(deltaEvent(2, "early"));
    });
    expect(onFirstDelta).toHaveBeenCalledTimes(1);
    expect(sse.signal?.aborted).toBe(false);
    expect(result.current.activeRunId).toBe(RUN_ID);

    act(() => {
      result.current.abortAll();
    });
    expect(sse.signal?.aborted).toBe(true);
    expect(result.current.activeRunId).toBeNull();

    // Every event after supersession is a no-op (token bumped); the latch does
    // not re-arm and no late text reaches the transcript.
    await act(async () => {
      sse.onEvent(deltaEvent(3, "LATE"));
    });
    expect(onFirstDelta).toHaveBeenCalledTimes(1);
    expect(assistantText(result.current.messages)).not.toContain("LATE");
  });

  it("latches the first delta exactly once per run", async () => {
    const onFirstDelta = vi.fn();
    const { result } = renderHook(() => useHarness({ onFirstDelta }));

    act(() => {
      result.current.dispatch({ type: "set_all", messages: seededPair() });
    });
    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    const sse = lastSse();
    await act(async () => {
      sse.onEvent(metaEvent(1));
      sse.onEvent(deltaEvent(2, "a"));
      sse.onEvent(deltaEvent(3, "b"));
      sse.onEvent(deltaEvent(4, "c"));
    });

    expect(onFirstDelta).toHaveBeenCalledTimes(1);
    expect(onFirstDelta).toHaveBeenCalledWith(RUN_ID);
  });

  it("gates apply when the run is not visible but still opens the stream", async () => {
    const onFirstDelta = vi.fn();
    const { result } = renderHook(() =>
      useHarness({ onFirstDelta, shouldApplyRun: () => false }),
    );

    act(() => {
      result.current.dispatch({ type: "set_all", messages: seededPair() });
    });
    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    // start gate (shouldStartRun default true) lets the stream open...
    expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1);
    const sse = lastSse();
    await act(async () => {
      sse.onEvent(metaEvent(1));
      sse.onEvent(deltaEvent(2, "hidden"));
    });

    // ...but the apply gate suppresses the transcript write + first-delta.
    expect(onFirstDelta).not.toHaveBeenCalled();
    expect(assistantText(result.current.messages)).toBe("");
  });

  it("never opens a stream for a run that fails the start gate", async () => {
    const { result } = renderHook(() =>
      useHarness({ shouldStartRun: () => false }),
    );

    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    expect(streamMocks.sseClientDirect).not.toHaveBeenCalled();
    expect(result.current.activeRunId).toBeNull();
  });

  it("reconnect reconciles against the persisted run and resumes from the folded cursor", async () => {
    stubFetch((input) =>
      pathOf(input).endsWith(`/api/chat-runs/${RUN_ID}`)
        ? jsonResponse({ data: chatRunData(5) })
        : jsonResponse({}, 404),
    );
    const { result } = renderHook(() => useHarness({}));

    act(() => {
      result.current.dispatch({ type: "set_all", messages: seededPair() });
    });
    await act(async () => {
      await result.current.tailChatRun(chatRunData());
    });

    const sse = lastSse();
    let decision: unknown;
    await act(async () => {
      decision = await sse.onReconnect?.(1);
    });
    expect(decision).toEqual({ after: "5" });

    // After supersession the reconnect path bails out rather than resuming.
    act(() => {
      result.current.abortAll();
    });
    let supersededDecision: unknown;
    await act(async () => {
      supersededDecision = await sse.onReconnect?.(2);
    });
    expect(supersededDecision).toBe("stop");
  });
});
