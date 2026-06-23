import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { useChatRunTail } from "./useChatRunTail";
import type { SSEEvent } from "@/lib/api/sse/events";
import type {
  ChatRunResponse,
  ConversationMessage,
  TrustRetrievalPlan,
} from "@/lib/conversations/types";

const apiMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  openGenerationRunStream: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: apiMocks.apiFetch,
  isUnauthenticatedApiError: () => false,
}));

vi.mock("@/lib/api/useGenerationRun", () => ({
  openGenerationRunStream: apiMocks.openGenerationRunStream,
}));

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_ID = "44444444-4444-4444-8444-444444444444";
const RETRIEVAL_PLAN: TrustRetrievalPlan = {
  version: "chat_retrieval_plan.v1",
  route_intent: "private_deep_retrieval",
  source_domain: "private_app",
  mixing_policy: "single_domain",
  query_class: "multi_hop_search_read_inspect_question",
  allowed_tools: ["app_search", "inspect_resource", "read_resource"],
  blocked_tools: ["web_search"],
  candidate_tool_sequence: ["app_search", "inspect_resource", "read_resource"],
  internal_tool_sequence: [],
  reason: "multi_hop_private",
  context_ref_count: 1,
  search_scope_count: 1,
  search_scope_uris: ["media:77777777-7777-4777-8777-777777777777"],
  budget_policy: "tool_output_budget_from_prompt_assembly",
};

function message(
  role: "user" | "assistant",
  id: string,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    seq: role === "user" ? 1 : 2,
    role,
    status,
    error_code: status === "error" ? "E_STREAM_INTERRUPTED" : null,
    can_retry_response: false,
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    message_document: {
      type: "message_document",
      blocks: [],
    },
    trust_trail:
      role === "assistant"
        ? {
            schema_version: "assistant_trust_trail.v1",
            assistant_message_id: id,
            conversation_id: CONVERSATION_ID,
            chat_run_id: RUN_ID,
            status,
            run: {
              run_id: RUN_ID,
              model_id: "55555555-5555-4555-8555-555555555555",
              provider: "openai",
              model_name: "gpt-test",
              reasoning_mode: "default",
              key_mode: "auto",
              status: status === "pending" ? "running" : status,
              usage: null,
              error_code: status === "error" ? "E_STREAM_INTERRUPTED" : null,
              final_chars: null,
              started_at: "2026-06-21T00:00:00Z",
              completed_at: null,
              retrieval_plan: null,
            },
            prompt: null,
            tool_calls: [],
            citations: [],
            context_refs_added: [],
            integrity_notices: [],
            created_at: "2026-06-21T00:00:00Z",
            updated_at: "2026-06-21T00:00:00Z",
          }
        : null,
  };
}

function runResponse(
  status: ChatRunResponse["data"]["run"]["status"] = "running",
): ChatRunResponse {
  return {
    data: {
      run: {
        id: RUN_ID,
        status,
        conversation_id: CONVERSATION_ID,
        user_message_id: USER_ID,
        assistant_message_id: ASSISTANT_ID,
        model_id: "55555555-5555-4555-8555-555555555555",
        reasoning: "default",
        key_mode: "auto",
        cancel_requested_at: null,
        started_at: "2026-06-21T00:00:00Z",
        completed_at: status === "running" ? null : "2026-06-21T00:00:01Z",
        error_code: status === "error" ? "E_STREAM_INTERRUPTED" : null,
        created_at: "2026-06-21T00:00:00Z",
        updated_at: "2026-06-21T00:00:00Z",
      },
      conversation: {
        id: CONVERSATION_ID,
        title: "Chat",
        sharing: "private",
        message_count: 2,
        created_at: "2026-06-21T00:00:00Z",
        updated_at: "2026-06-21T00:00:00Z",
      },
      user_message: message("user", USER_ID),
      assistant_message: message(
        "assistant",
        ASSISTANT_ID,
        status === "running" || status === "queued" ? "pending" : status,
      ),
      stream_state: {
        status,
        last_event_seq: 0,
        folded_event_seq: 0,
        assistant_current_text: "",
        tool_calls: [],
        activity: null,
        reconnectable: status === "running",
        terminal: status !== "running",
      },
    },
  };
}

function renderTail({
  shouldApplyRun,
  onContextRefAdded,
  onRunDone = vi.fn(),
}: {
  shouldApplyRun?: Parameters<typeof useChatRunTail>[0]["shouldApplyRun"];
  onContextRefAdded?: Parameters<typeof useChatRunTail>[0]["onContextRefAdded"];
  onRunDone?: Parameters<typeof useChatRunTail>[0]["onRunDone"];
}) {
  let messages: ConversationMessage[] = [];
  const setMessages: Dispatch<SetStateAction<ConversationMessage[]>> = (value) => {
    messages = typeof value === "function" ? value(messages) : value;
  };
  const view = renderHook(() =>
    useChatRunTail({
      setMessages,
      shouldApplyRun,
      onContextRefAdded,
      onRunDone,
    }),
  );
  return { ...view, messages: () => messages, onRunDone };
}

describe("useChatRunTail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconciles and marks the run interrupted when the stream closes without done", async () => {
    apiMocks.apiFetch.mockResolvedValue(runResponse("running"));
    apiMocks.openGenerationRunStream.mockImplementation(async (_kind, _id, args) => {
      args.onComplete(false);
      return () => {};
    });
    const view = renderTail({});

    await act(async () => {
      await view.result.current.tailChatRun(runResponse("running").data);
    });

    await waitFor(() => {
      expect(view.onRunDone).toHaveBeenCalledWith(
        RUN_ID,
        "error",
        "E_STREAM_INTERRUPTED",
      );
    });
    expect(apiMocks.apiFetch).toHaveBeenCalledWith(`/api/chat-runs/${RUN_ID}`);
    expect(view.messages()[1]?.status).toBe("error");
    expect(view.messages()[1]?.error_code).toBe("E_STREAM_INTERRUPTED");
  });

  it("ignores context refs from a hidden run", async () => {
    const onContextRefAdded = vi.fn();
    apiMocks.apiFetch.mockResolvedValue(runResponse("complete"));
    apiMocks.openGenerationRunStream.mockImplementation(async (_kind, _id, args) => {
      args.onEvent({
        seq: 1,
        type: "context_ref_added",
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          conversation_id: CONVERSATION_ID,
          resource_ref: "media:77777777-7777-4777-8777-777777777777",
          activation: {
            resourceRef: "media:77777777-7777-4777-8777-777777777777",
            kind: "route",
            href: "/media/77777777-7777-4777-8777-777777777777",
            unresolvedReason: null,
          },
          label: "Hidden source",
          summary: "Hidden summary",
          missing: false,
          created_at: "2026-06-21T00:00:00Z",
          citation_edge_id: null,
        },
      } satisfies SSEEvent);
      args.onEvent({
        seq: 2,
        type: "done",
        data: { status: "complete", error_code: null },
      } satisfies SSEEvent);
      args.onComplete(true);
      return () => {};
    });
    const view = renderTail({
      shouldApplyRun: () => false,
      onContextRefAdded,
    });

    await act(async () => {
      await view.result.current.tailChatRun(runResponse("running").data);
    });

    await waitFor(() => {
      expect(view.onRunDone).toHaveBeenCalledWith(RUN_ID, "complete", null);
    });
    expect(onContextRefAdded).not.toHaveBeenCalled();
  });

  it("folds streamed retrieval plans into the live trust trail", async () => {
    apiMocks.openGenerationRunStream.mockImplementation(async (_kind, _id, args) => {
      args.onEvent({
        seq: 1,
        type: "retrieval_plan",
        data: {
          assistant_message_id: ASSISTANT_ID,
          retrieval_plan: RETRIEVAL_PLAN,
        },
      } satisfies SSEEvent);
      return () => {};
    });
    const view = renderTail({});

    await act(async () => {
      await view.result.current.tailChatRun(runResponse("running").data);
    });

    expect(
      view.messages().find((item) => item.id === ASSISTANT_ID)?.trust_trail?.run
        ?.retrieval_plan?.route_intent,
    ).toBe("private_deep_retrieval");
  });
});
