import { useEffect, useReducer, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import {
  TOOL_PROJECTION_REVISION,
  type ToolProjectionField,
} from "@/lib/conversations/toolContractProjection";
import {
  messageUpdateReducer,
} from "@/lib/conversations/messageUpdateReducer";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";
import { useChatRunTail } from "./useChatRunTail";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const TOOL_CALL_ID = "55555555-5555-4555-8555-555555555555";
const CITATION_EDGE_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = "77777777-7777-4777-8777-777777777777";
const CREATED_AT = "2026-08-25T12:00:00Z";
const STREAM_PATH = `/stream/chat-runs/${RUN_ID}/events`;
const encoder = new TextEncoder();

const TOOL_PROJECTION: Record<ToolProjectionField, string | null> = {
  activity_label: "Searching the web",
  canonical_tool_id: "web.search",
  effect: "Read",
  error_type: null,
  provider_wire_name: "web.search",
  record_kind: "current_execution",
  result_kind: "retrieval",
};

function message(
  role: "user" | "assistant",
  id: string,
): ConversationMessage {
  return {
    id,
    seq: role === "user" ? 1 : 2,
    role,
    message_document: {
      type: "message_document",
      blocks:
        role === "user"
          ? [{ type: "text", format: "markdown", text: "Find the source." }]
          : [],
    },
    parent_message_id: role === "assistant" ? USER_MESSAGE_ID : null,
    reader_selection: { kind: "Absent" },
    trust_trail: null,
    citations: [],
    status: role === "user" ? "complete" : "pending",
    can_rerun: false,
    can_regenerate: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function runData(
  assistantCurrentText: string,
  foldedEventSeq: number,
): ChatRunResponse["data"] {
  return {
    run: {
      id: RUN_ID,
      status: "running",
      conversation_id: CONVERSATION_ID,
      user_message_id: USER_MESSAGE_ID,
      assistant_message_id: ASSISTANT_MESSAGE_ID,
      profile_id: "balanced",
      model_name: null,
      reasoning_effort: null,
      support_id: { kind: "Absent" },
      publication_warning: { kind: "Absent" },
      failure: null,
      execution: { kind: "Absent" },
      cancel_requested_at: null,
      started_at: CREATED_AT,
      completed_at: null,
      error_code: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    conversation: {
      id: CONVERSATION_ID,
      title: "Reconnect proof",
      sharing: "private",
      message_count: 2,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    user_message: message("user", USER_MESSAGE_ID),
    assistant_message: message("assistant", ASSISTANT_MESSAGE_ID),
    stream_state: {
      status: "running",
      last_event_seq: foldedEventSeq,
      folded_event_seq: foldedEventSeq,
      assistant_current_text: assistantCurrentText,
      tool_calls: [],
      activity: null,
      reconnectable: true,
      terminal: false,
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(id: number, type: string, data: unknown): Uint8Array {
  return encoder.encode(
    `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.origin);
}

function TranscriptHarness({ initialRun }: { initialRun: ChatRunResponse["data"] }) {
  const [messages, dispatch] = useReducer(messageUpdateReducer, []);
  const started = useRef(false);
  const { abortAll, tailChatRun } = useChatRunTail({
    dispatch,
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void tailChatRun(initialRun);
    return abortAll;
  }, [abortAll, initialRun, tailChatRun]);

  const assistant = messages.find(
    (candidate) => candidate.id === ASSISTANT_MESSAGE_ID,
  );
  if (!assistant) return <p role="status">Connecting</p>;

  return (
    <AssistantMessage
      message={assistant}
      messageOrdinal={1}
      forkOptions={[]}
      timestampLabel=""
    />
  );
}

describe("Chat generation stream lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders incremental text and folds a reconciled reconnect, tool, and citation exactly once", async () => {
    let firstController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let secondController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let tokenSequence = 0;
    const reconciliationPaths: string[] = [];
    const streamRequests: Array<{
      after: string | null;
      attempt: string | null;
      authorization: string | null;
      projection: string | null;
    }> = [];

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/stream-token") {
          tokenSequence += 1;
          return json({
            data: {
              token: `stream-token-${tokenSequence}`,
              stream_base_url: "https://stream.nexus.test",
              expires_at: "2026-08-25T12:01:00Z",
            },
          });
        }
        if (url.pathname === `/api/chat-runs/${RUN_ID}`) {
          reconciliationPaths.push(url.pathname);
          return json({ data: runData("Hello ", 2) });
        }
        if (url.pathname !== STREAM_PATH) {
          throw new Error(`Unexpected chat lifecycle request: ${url.pathname}`);
        }

        const headers = new Headers(init?.headers);
        streamRequests.push({
          after: url.searchParams.get("after"),
          attempt: headers.get("X-Nexus-SSE-Attempt"),
          authorization: headers.get("Authorization"),
          projection: headers.get(TOOL_PROJECTION_HEADER),
        });
        const streamIndex = streamRequests.length;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (streamIndex === 1) {
              firstController = controller;
              controller.enqueue(encoder.encode("retry: 0\n\n"));
              controller.enqueue(
                sse(1, "assistant_text_delta", {
                  assistant_message_id: ASSISTANT_MESSAGE_ID,
                  text: "Hel",
                  provider_event_seq_start: 1,
                  provider_event_seq_end: 1,
                }),
              );
              return;
            }
            if (streamIndex !== 2) {
              throw new Error(`Unexpected stream attempt ${streamIndex}`);
            }
            secondController = controller;
            init?.signal?.addEventListener(
              "abort",
              () =>
                controller.error(
                  new DOMException("Stream aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );

    const view = render(
      withRenderEnvironment(
        <FeedbackProvider>
          <TranscriptHarness initialRun={runData("", 0)} />
        </FeedbackProvider>,
      ),
    );

    const firstBlock = await screen.findByText("Hel");
    await expect.element(firstBlock).toBeVisible();

    await waitFor(() => expect(firstController).toBeDefined());
    const first = firstController;
    if (!first) throw new Error("The initial stream never opened.");
    first.close();

    await screen.findByText("Hello");
    await waitFor(() => expect(secondController).toBeDefined());
    const second = secondController;
    if (!second) throw new Error("The reconnect stream never opened.");

    // Event 2 was already present in the reconciled snapshot. A replayed copy
    // must be ignored before event 3 is appended.
    second.enqueue(
      sse(2, "assistant_text_delta", {
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        text: "lo ",
        provider_event_seq_start: 2,
        provider_event_seq_end: 2,
      }),
    );
    second.enqueue(
      sse(3, "assistant_text_delta", {
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        text: "world[1]",
        provider_event_seq_start: 3,
        provider_event_seq_end: 3,
      }),
    );
    second.enqueue(
      sse(4, "tool_call_start", {
        ...TOOL_PROJECTION,
        tool_call_id: TOOL_CALL_ID,
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        tool_call_index: 0,
        provider_tool_call_id: "provider-call-1",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      }),
    );

    const activeTool = await screen.findByText("Searching the web");
    expect(activeTool).toBeVisible();
    await userEvent.click(screen.getByText("Details"));
    expect(
      screen.getByText("#0 Searching the web - running"),
    ).toBeVisible();

    second.enqueue(
      sse(5, "tool_result", {
        ...TOOL_PROJECTION,
        tool_call_id: TOOL_CALL_ID,
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        tool_call_index: 0,
        status: "complete",
        scope: "provider_tool",
        types: [],
        result_count: 0,
        selected_count: 0,
        latency_ms: 7,
        provider_request_ids: ["provider-request-1"],
        filters: {},
        results: [],
      }),
    );
    second.enqueue(
      sse(6, "citation_index", {
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        citations: [
          {
            citation_edge_id: CITATION_EDGE_ID,
            citation: {
              ordinal: 1,
              role: "supports",
              target_ref: { type: "media", id: SOURCE_ID },
              activation: {
                resource_ref: `media:${SOURCE_ID}`,
                kind: "route",
                href: `/media/${SOURCE_ID}`,
                unresolved_reason: null,
              },
              media_id: SOURCE_ID,
              locator: null,
              deep_link: `/media/${SOURCE_ID}`,
              snapshot: { title: "Source one" },
            },
          },
        ],
      }),
    );

    await waitFor(() => expect(activeTool).not.toBeInTheDocument());
    expect(
      await screen.findByText("#0 Searching the web - complete"),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Open citation 1" }),
    ).toBeVisible();
    expect(screen.getAllByText(/Hello world/)).toHaveLength(1);
    expect(screen.queryByText(/Hello lo world/)).toBeNull();
    expect(reconciliationPaths).toEqual([`/api/chat-runs/${RUN_ID}`]);
    expect(streamRequests).toEqual([
      {
        after: "0",
        attempt: "0",
        authorization: "Bearer stream-token-1",
        projection: TOOL_PROJECTION_REVISION,
      },
      {
        after: "2",
        attempt: "1",
        authorization: "Bearer stream-token-2",
        projection: TOOL_PROJECTION_REVISION,
      },
    ]);

    view.unmount();
  });
});
