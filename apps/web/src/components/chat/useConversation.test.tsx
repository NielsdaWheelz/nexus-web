import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversation } from "@/components/chat/useConversation";
import type { SSEReferenceAddedEvent } from "@/lib/api/sse/events";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";

// Mock the streaming spine at its boundary: useConversation is the only caller
// of useChatRunTail, and the SSE transport is out of scope for the engine.
const tailMocks = vi.hoisted(() => ({
  tailChatRun: vi.fn(),
  abortAll: vi.fn(),
  useChatRunTail: vi.fn(),
}));

vi.mock("@/components/chat/useChatRunTail", () => ({
  useChatRunTail: tailMocks.useChatRunTail,
}));

const timestamp = "2026-01-01T00:00:00Z";

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

function searchOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).search;
  return new URL(String(input), "http://localhost").search;
}

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
      version: 1,
      blocks: content.trim()
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
    tool_calls: [],
    status,
    error_code: null,
    can_retry_response: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const conversationSummary = {
  id: "conversation-1",
  title: "Branch chat",
  sharing: "private",
  message_count: 4,
  created_at: timestamp,
  updated_at: timestamp,
};

const rootUser = message("root-user", 1, "user", "Start");
const rootAssistant = message(
  "root-assistant",
  2,
  "assistant",
  "Choose a branch",
  "root-user",
);
const branchAUser = message("branch-a-user", 3, "user", "Ask A", "root-assistant");
const branchAAssistant = message(
  "branch-a-assistant",
  4,
  "assistant",
  "Answer A",
  "branch-a-user",
);
const branchBUser = message("branch-b-user", 5, "user", "Ask B", "root-assistant");
const branchBAssistant = message(
  "branch-b-assistant",
  6,
  "assistant",
  "Answer B",
  "branch-b-user",
);

const pathA = [rootUser, rootAssistant, branchAUser, branchAAssistant];
const pathB = [rootUser, rootAssistant, branchBUser, branchBAssistant];

const forkA: ForkOption = {
  id: "branch-a",
  parent_message_id: "root-assistant",
  user_message_id: "branch-a-user",
  assistant_message_id: "branch-a-assistant",
  leaf_message_id: "branch-a-assistant",
  title: "Branch A",
  preview: "Ask A",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 2,
  created_at: timestamp,
  updated_at: timestamp,
  active: true,
};

const forkB: ForkOption = {
  ...forkA,
  id: "branch-b",
  user_message_id: "branch-b-user",
  assistant_message_id: "branch-b-assistant",
  leaf_message_id: "branch-b-assistant",
  title: "Branch B",
  preview: "Ask B",
  active: false,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

function treeResponse(selected: "a" | "b" = "a"): ConversationTreeResponse {
  return {
    conversation: conversationSummary,
    selected_path: selected === "a" ? pathA : pathB,
    active_leaf_message_id:
      selected === "a" ? "branch-a-assistant" : "branch-b-assistant",
    fork_options_by_parent_id: {
      "root-assistant": [
        { ...forkA, active: selected === "a" },
        { ...forkB, active: selected === "b" },
      ],
    },
    path_cache_by_leaf_id: {
      "branch-a-assistant": pathA,
      "branch-b-assistant": pathB,
    },
    branch_graph: { root_message_id: "root-assistant", edges: [], nodes: [] },
    page: { before_cursor: null },
  };
}

function emptyTreeResponse(): ConversationTreeResponse {
  return {
    ...treeResponse(),
    conversation: { ...conversationSummary, message_count: 0 },
    selected_path: [],
    active_leaf_message_id: null,
    fork_options_by_parent_id: {},
    path_cache_by_leaf_id: {},
    branch_graph: { root_message_id: null, edges: [], nodes: [] },
  };
}

function chatRunData(): ChatRunResponse["data"] {
  return {
    run: {
      id: "run-1",
      status: "running",
      conversation_id: "conversation-1",
      user_message_id: "user-new",
      assistant_message_id: "assistant-new",
      model_id: "gpt-5-mini",
      reasoning: "default",
      key_mode: "auto",
      cancel_requested_at: null,
      started_at: timestamp,
      completed_at: null,
      error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    conversation: conversationSummary,
    user_message: message("user-new", 1, "user", "Hello there"),
    assistant_message: message("assistant-new", 2, "assistant", "", "user-new", "pending"),
  };
}

function retryRunData(): ChatRunResponse["data"] {
  return {
    ...chatRunData(),
    run: { ...chatRunData().run, id: "retry-run" },
    user_message: message("retry-user", 3, "user", "Original prompt"),
    assistant_message: message(
      "retry-assistant",
      4,
      "assistant",
      "",
      "retry-user",
      "pending",
    ),
  };
}

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input, init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A fake scroll handle so we can assert the engine calls captureAnchor before
// path-changing setMessages (the view normally populates scrollRef.current).
function fakeScrollHandle() {
  return { captureAnchor: vi.fn(), scrollToMessage: vi.fn() };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useConversation", () => {
  beforeEach(() => {
    tailMocks.tailChatRun.mockReset();
    tailMocks.abortAll.mockReset();
    tailMocks.useChatRunTail.mockReset();
    tailMocks.useChatRunTail.mockReturnValue({
      tailChatRun: tailMocks.tailChatRun,
      abortAll: tailMocks.abortAll,
      activeRunId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolve-on-send creates a conversation and seeds optimistic messages", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations" && init?.method === "POST") {
        return jsonResponse({ data: { id: "created-1" } });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: null, branching: false }),
    );

    // No history fetch for a not-yet-created conversation.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();

    let resolvedId = "";
    await act(async () => {
      resolvedId = await result.current.resolveConversation();
    });

    // POST /conversations created the conversation and the engine adopted its id.
    expect(resolvedId).toBe("created-1");
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input as RequestInfo | URL) === "/api/conversations" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeDefined();
    await waitFor(() =>
      expect(result.current.conversationId).toBe("created-1"),
    );

    // The first run seeds the optimistic user+assistant pair and tails the run.
    const run = {
      ...chatRunData(),
      run: {
        ...chatRunData().run,
        conversation_id: "created-1",
      },
      conversation: {
        ...conversationSummary,
        id: "created-1",
        title: "Created chat",
      },
    };
    act(() => {
      result.current.onChatRunCreated(run);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "user-new",
      "assistant-new",
    ]);
    expect(tailMocks.tailChatRun).toHaveBeenCalledWith(run);
    // Linear (reader) mode is single-stream: the prior run is aborted BEFORE the
    // new one is tailed.
    expect(tailMocks.abortAll).toHaveBeenCalled();
    expect(tailMocks.abortAll.mock.invocationCallOrder[0]).toBeLessThan(
      tailMocks.tailChatRun.mock.invocationCallOrder[0],
    );
  });

  it("forwards reference_added events from the tail to the reference owner", async () => {
    const onReferenceAdded = vi.fn();
    const referenceAdded: SSEReferenceAddedEvent["data"] = {
      reference_id: "ref-1",
      conversation_id: "conversation-1",
      resource_uri: "chunk:chunk-1",
      label: "Evidence chunk",
      summary: "Relevant context",
      inline_body: "Evidence body",
      fetch_hint: "inline",
      missing: false,
      created_at: timestamp,
    };

    renderHook(() =>
      useConversation({
        conversationId: null,
        branching: false,
        onReferenceAdded,
      }),
    );

    const tailOptions = tailMocks.useChatRunTail.mock.calls[0]?.[0];
    expect(tailOptions?.onReferenceAdded).toBeDefined();

    act(() => {
      tailOptions?.onReferenceAdded?.(referenceAdded);
    });

    expect(onReferenceAdded).toHaveBeenCalledWith(referenceAdded);
  });

  it("attaches initialReferences to an existing conversation on resolve", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1") {
        return jsonResponse({ data: { title: "Existing chat" } });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (
        path === "/api/conversations/conversation-1/references" &&
        init?.method === "POST"
      ) {
        return jsonResponse({ data: { id: "ref-1" } });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({
        conversationId: "conversation-1",
        initialReferences: ["media:media-1"],
        branching: false,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolvedId = "";
    await act(async () => {
      resolvedId = await result.current.resolveConversation();
    });
    expect(resolvedId).toBe("conversation-1");

    const refCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input as RequestInfo | URL) ===
          "/api/conversations/conversation-1/references" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(refCall).toBeDefined();
    expect(JSON.parse((refCall?.[1] as RequestInit).body as string)).toEqual({
      resource_uri: "media:media-1",
    });
  });

  it("retry posts to the message retry endpoint and tracks the busy id", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1") {
        return jsonResponse({ data: { title: "Retry chat" } });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({
          data: [message("a", 1, "assistant", "boom", null, "error")],
          page: { next_cursor: null },
        });
      }
      if (path === "/api/messages/a/retry" && init?.method === "POST") {
        return jsonResponse({ data: retryRunData() });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.retryAssistantResponse("a");
    });

    const retryCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input as RequestInfo | URL) === "/api/messages/a/retry" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(retryCall).toBeDefined();
    // Idempotency-Key header is preserved on retry.
    expect(
      (retryCall?.[1] as RequestInit).headers,
    ).toMatchObject({ "Idempotency-Key": expect.any(String) });
    // The retry run is tailed and the busy id is cleared after completion.
    expect(tailMocks.tailChatRun).toHaveBeenCalled();
    expect(result.current.retryingAssistantMessageIds.has("a")).toBe(false);
  });

  it("branching mode loads /tree, keeps olderCursor null, and loadOlder is a no-op", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse("a") });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(
      pathA.map((m) => m.id),
    );
    expect(result.current.title).toBe("Branch chat");
    expect(result.current.olderCursor).toBeNull();
    expect(result.current.branch).toBeDefined();

    // The /tree request carries no query string (no pane pagination).
    const treeCall = fetchMock.mock.calls.find(
      ([input]) =>
        pathOf(input as RequestInfo | URL) ===
        "/api/conversations/conversation-1/tree",
    );
    expect(searchOf(treeCall?.[0] as RequestInfo | URL)).toBe("");

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("branching mode renders empty conversations without waiting on active runs", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: emptyTreeResponse() });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toEqual([]);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => pathOf(input as RequestInfo | URL) === "/api/chat-runs",
      ),
    ).toBe(false);
  });

  it("does not refetch history when the stream tail callback identity changes", async () => {
    tailMocks.useChatRunTail.mockImplementation(() => ({
      tailChatRun: vi.fn(),
      abortAll: tailMocks.abortAll,
      activeRunId: null,
    }));
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: emptyTreeResponse() });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          pathOf(input as RequestInfo | URL) ===
          "/api/conversations/conversation-1/tree",
      ),
    ).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("(branching) switchToLeaf swaps the path, captures the anchor, and POSTs active-path", async () => {
    const fetchMock = stubFetch((input, init) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse("a") });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      if (
        path === "/api/conversations/conversation-1/active-path" &&
        init?.method === "POST"
      ) {
        return jsonResponse({ data: treeResponse("b") });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Simulate the view having mounted: it owns scrollRef.current.
    const scroll = fakeScrollHandle();
    result.current.scrollRef.current = scroll;

    await act(async () => {
      await result.current.branch?.switchToLeaf(
        "branch-b-assistant",
        "root-assistant",
      );
    });

    // The path swapped to branch B.
    expect(result.current.messages.map((m) => m.id)).toEqual(
      pathB.map((m) => m.id),
    );
    expect(result.current.branch?.activeLeafMessageId).toBe("branch-b-assistant");
    // The scroll owner was asked to capture the eye-line before the swap.
    expect(scroll.captureAnchor).toHaveBeenCalledWith("root-assistant");
    // active-path was persisted.
    const activePathCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input as RequestInfo | URL) ===
          "/api/conversations/conversation-1/active-path" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(activePathCall).toBeDefined();
    expect(
      JSON.parse((activePathCall?.[1] as RequestInit).body as string),
    ).toEqual({ active_leaf_message_id: "branch-b-assistant" });
  });

  it("(branching) onChatRunCreated tails the run without aborting concurrent branch runs", async () => {
    const fetchMock = stubFetch((input) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse("a") });
      }
      if (path === "/api/chat-runs") return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialTreeCalls = fetchMock.mock.calls.filter(
      ([input]) =>
        pathOf(input as RequestInfo | URL) ===
        "/api/conversations/conversation-1/tree",
    ).length;

    const run = chatRunData();
    act(() => {
      result.current.onChatRunCreated(run);
    });

    expect(tailMocks.tailChatRun).toHaveBeenCalledWith(run);
    // Branching mode intentionally allows concurrent branch runs — it must not
    // abort the others (the linear/branching split is the key behavioural diff).
    expect(tailMocks.abortAll).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          pathOf(input as RequestInfo | URL) ===
          "/api/conversations/conversation-1/tree",
      ),
    ).toHaveLength(initialTreeCalls);
  });

  it("(linear) loadOlder prepends older messages and captures the anchor", async () => {
    const older = message("older-1", 0, "user", "Earlier question");
    const newest = message("newest-1", 5, "user", "Latest question");
    stubFetch((input) => {
      const path = pathOf(input);
      const search = searchOf(input);
      if (path === "/api/conversations/conversation-1") {
        return jsonResponse({ data: { title: "Linear chat" } });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        if (search.includes("before_cursor=cursor-older")) {
          return jsonResponse({
            data: [older],
            page: { before_cursor: null, next_cursor: null },
          });
        }
        return jsonResponse({
          data: [newest],
          page: { before_cursor: "cursor-older", next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch: ${path}${search}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-1", branching: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(["newest-1"]);
    expect(result.current.olderCursor).toBe("cursor-older");
    const initialMessagesCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input]) =>
          pathOf(input as RequestInfo | URL) ===
            "/api/conversations/conversation-1/messages" &&
          searchOf(input as RequestInfo | URL).includes("window=latest"),
      );
    expect(initialMessagesCall).toBeDefined();

    const scroll = fakeScrollHandle();
    result.current.scrollRef.current = scroll;

    await act(async () => {
      await result.current.loadOlder();
    });

    // Older messages are prepended ahead of the existing window.
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "older-1",
      "newest-1",
    ]);
    expect(result.current.olderCursor).toBeNull();
    expect(scroll.captureAnchor).toHaveBeenCalledWith(null);
  });

  it("clears conversation-scoped state when the route id changes", async () => {
    const firstMessage = message("first-user", 1, "user", "First route");
    const secondMessage = message("second-user", 1, "user", "Second route");
    const fetchMock = stubFetch((input) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1") {
        return jsonResponse({ data: { title: "First chat" } });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({
          data: [firstMessage],
          page: { before_cursor: "older-first", next_cursor: null },
        });
      }
      if (path === "/api/conversations/conversation-2") {
        return jsonResponse({ data: { title: "Second chat" } });
      }
      if (path === "/api/conversations/conversation-2/messages") {
        return jsonResponse({
          data: [secondMessage],
          page: { before_cursor: null, next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useConversation({ conversationId, branching: false }),
      { initialProps: { conversationId: "conversation-1" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(["first-user"]);
    expect(result.current.olderCursor).toBe("older-first");

    rerender({ conversationId: "conversation-2" });

    expect(result.current.conversationId).toBe("conversation-2");
    expect(result.current.messages).toEqual([]);
    expect(result.current.olderCursor).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(tailMocks.abortAll).toHaveBeenCalled();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(["second-user"]);
    expect(result.current.title).toBe("Second chat");
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          pathOf(input as RequestInfo | URL) ===
          "/api/conversations/conversation-2/messages",
      ),
    ).toBe(true);
  });

  it("does not tail active runs returned for a stale route conversation", async () => {
    const activeRunsResponse = deferred<Response>();
    const staleRun = {
      ...chatRunData(),
      run: {
        ...chatRunData().run,
        id: "stale-run",
        conversation_id: "conversation-1",
        user_message_id: branchAUser.id,
        assistant_message_id: branchAAssistant.id,
      },
      user_message: branchAUser,
      assistant_message: {
        ...branchAAssistant,
        status: "pending" as const,
      },
    };
    const fetchMock = stubFetch((input) => {
      const path = pathOf(input);
      const search = searchOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse("a") });
      }
      if (
        path === "/api/chat-runs" &&
        search.includes("conversation_id=conversation-1")
      ) {
        return activeRunsResponse.promise;
      }
      if (path === "/api/conversations/conversation-2/tree") {
        return jsonResponse({ data: emptyTreeResponse() });
      }
      throw new Error(`Unexpected fetch: ${path}${search}`);
    });

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useConversation({ conversationId, branching: true }),
      { initialProps: { conversationId: "conversation-1" } },
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) => pathOf(input as RequestInfo | URL) === "/api/chat-runs",
        ),
      ).toBe(true);
    });

    rerender({ conversationId: "conversation-2" });
    activeRunsResponse.resolve(jsonResponse({ data: [staleRun] }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversationId).toBe("conversation-2");
    expect(tailMocks.tailChatRun).not.toHaveBeenCalledWith(staleRun);
  });

  it("ignores a run-created payload for a different active conversation", async () => {
    stubFetch((input) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-2") {
        return jsonResponse({ data: { title: "Second chat" } });
      }
      if (path === "/api/conversations/conversation-2/messages") {
        return jsonResponse({ data: [], page: { before_cursor: null } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const { result } = renderHook(() =>
      useConversation({ conversationId: "conversation-2", branching: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const staleRun = chatRunData();
    act(() => {
      result.current.onChatRunCreated(staleRun);
    });

    expect(result.current.conversationId).toBe("conversation-2");
    expect(tailMocks.tailChatRun).not.toHaveBeenCalledWith(staleRun);
  });

  it("refetches an existing conversation when returning after a send", async () => {
    const firstMessage = message("first-user", 1, "user", "First route");
    const secondMessage = message("second-user", 1, "user", "Second route");
    const fetchMock = stubFetch((input) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1") {
        return jsonResponse({ data: { title: "First chat" } });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({
          data: [firstMessage],
          page: { before_cursor: null, next_cursor: null },
        });
      }
      if (path === "/api/conversations/conversation-2") {
        return jsonResponse({ data: { title: "Second chat" } });
      }
      if (path === "/api/conversations/conversation-2/messages") {
        return jsonResponse({
          data: [secondMessage],
          page: { before_cursor: null, next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useConversation({ conversationId, branching: false }),
      { initialProps: { conversationId: "conversation-1" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(["first-user"]);

    act(() => {
      result.current.onChatRunCreated({
        ...chatRunData(),
        user_message: message(
          "follow-up-user",
          2,
          "user",
          "Follow up",
          "first-user",
        ),
        assistant_message: message(
          "follow-up-assistant",
          3,
          "assistant",
          "",
          "follow-up-user",
          "pending",
        ),
      });
    });

    rerender({ conversationId: "conversation-2" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(["second-user"]);

    rerender({ conversationId: "conversation-1" });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            pathOf(input as RequestInfo | URL) ===
            "/api/conversations/conversation-1/messages",
        ),
      ).toHaveLength(2);
    });
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual(["first-user"]),
    );
  });

  it("preserves optimistic messages when a newly created route adopts its id", async () => {
    const fetchMock = stubFetch((input) => {
      throw new Error(`Unexpected fetch: ${pathOf(input)}`);
    });
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useConversation({ conversationId, branching: false }),
      { initialProps: { conversationId: null as string | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const run = {
      ...chatRunData(),
      run: {
        ...chatRunData().run,
        conversation_id: "created-1",
      },
      conversation: {
        ...conversationSummary,
        id: "created-1",
        title: "Created chat",
      },
    };
    act(() => {
      result.current.onChatRunCreated(run);
    });
    expect(result.current.conversationId).toBe("created-1");
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "user-new",
      "assistant-new",
    ]);

    rerender({ conversationId: "created-1" });

    expect(result.current.conversationId).toBe("created-1");
    expect(result.current.messages.map((m) => m.id)).toEqual([
      "user-new",
      "assistant-new",
    ]);
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tailMocks.abortAll).toHaveBeenCalledTimes(1);
  });
});
