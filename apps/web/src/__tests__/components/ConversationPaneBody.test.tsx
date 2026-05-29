import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationPaneBody from "@/app/(authenticated)/conversations/[id]/ConversationPaneBody";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";

const tailMocks = vi.hoisted(() => ({
  tailChatRun: vi.fn(),
  abortAll: vi.fn(),
  useChatRunTail: vi.fn(),
}));

vi.mock("@/components/chat/useChatRunTail", () => ({
  useChatRunTail: tailMocks.useChatRunTail,
}));

const timestamp = "2026-01-01T00:00:00Z";

const MODELS = [
  {
    id: "gpt-5-mini",
    provider: "openai",
    provider_display_name: "OpenAI",
    model_name: "gpt-5-mini",
    model_display_name: "GPT-5 mini",
    model_tier: "light",
    reasoning_modes: ["default"],
    max_context_tokens: 128000,
    available_via: "platform",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
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
const branchBPendingAssistant = message(
  "branch-b-assistant",
  6,
  "assistant",
  "",
  "branch-b-user",
  "pending",
);

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
  id: "branch-b",
  parent_message_id: "root-assistant",
  user_message_id: "branch-b-user",
  assistant_message_id: "branch-b-assistant",
  leaf_message_id: "branch-b-assistant",
  title: "Branch B",
  preview: "Ask B",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 2,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  active: false,
};

function treeResponse({
  selected = "a",
  branchBStatus = "complete",
}: {
  selected?: "a" | "b";
  branchBStatus?: "complete" | "pending";
} = {}): ConversationTreeResponse {
  const pathA = [rootUser, rootAssistant, branchAUser, branchAAssistant];
  const pathB = [
    rootUser,
    rootAssistant,
    branchBUser,
    branchBStatus === "pending" ? branchBPendingAssistant : branchBAssistant,
  ];
  return {
    conversation: {
      id: "conversation-1",
      title: "Branch chat",
      sharing: "private",
      message_count: 6,
      created_at: timestamp,
      updated_at: timestamp,
    },
    selected_path: selected === "a" ? pathA : pathB,
    active_leaf_message_id:
      selected === "a" ? "branch-a-assistant" : "branch-b-assistant",
    fork_options_by_parent_id: {
      "root-assistant": [
        { ...forkA, active: selected === "a" },
        { ...forkB, active: selected === "b", status: branchBStatus },
      ],
    },
    path_cache_by_leaf_id: {
      "branch-a-assistant": pathA,
      "branch-b-assistant": pathB,
    },
    branch_graph: {
      root_message_id: "root-assistant",
      edges: [],
      nodes: [],
    },
    page: { before_cursor: null },
  };
}

function activeBranchBRun(): ChatRunResponse["data"] {
  return {
    run: {
      id: "run-branch-b",
      status: "running",
      conversation_id: "conversation-1",
      user_message_id: "branch-b-user",
      assistant_message_id: "branch-b-assistant",
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
    conversation: treeResponse().conversation,
    user_message: branchBUser,
    assistant_message: branchBPendingAssistant,
  };
}

function failedRootRetryTree(): ConversationTreeResponse {
  const failedUser = message("failed-user", 1, "user", "Original prompt");
  const failedAssistant: ConversationMessage = {
    ...message(
      "failed-assistant",
      2,
      "assistant",
      "An unexpected error occurred. Please try again.",
      "failed-user",
      "error",
    ),
    error_code: "E_INTERNAL",
    can_retry_response: true,
  };
  return {
    conversation: {
      id: "conversation-1",
      title: "Retry chat",
      sharing: "private",
      message_count: 2,
      created_at: timestamp,
      updated_at: timestamp,
    },
    selected_path: [failedUser, failedAssistant],
    active_leaf_message_id: "failed-assistant",
    fork_options_by_parent_id: {},
    path_cache_by_leaf_id: {
      "failed-assistant": [failedUser, failedAssistant],
    },
    branch_graph: {
      root_message_id: "failed-user",
      edges: [],
      nodes: [],
    },
    page: { before_cursor: null },
  };
}

function retryRun(): ChatRunResponse["data"] {
  const retryUser = message("retry-user", 3, "user", "Original prompt");
  const retryAssistant = message(
    "retry-assistant",
    4,
    "assistant",
    "",
    "retry-user",
    "pending",
  );
  return {
    run: {
      id: "retry-run",
      status: "queued",
      conversation_id: "conversation-1",
      user_message_id: "retry-user",
      assistant_message_id: "retry-assistant",
      model_id: "gpt-5-mini",
      reasoning: "default",
      key_mode: "auto",
      cancel_requested_at: null,
      started_at: null,
      completed_at: null,
      error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    conversation: failedRootRetryTree().conversation,
    user_message: retryUser,
    assistant_message: retryAssistant,
  };
}

function renderPane(onSetPaneExtraWidth = vi.fn()) {
  const href = "/conversations/conversation-1";
  const resourceKey = resolvePaneRouteIdentity(href).resourceKey;
  return render(
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="conversation"
      resourceRef="conversation-1"
      resourceKey={resourceKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{ id: "conversation-1" }}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={vi.fn()}
      onSetPaneExtraWidth={onSetPaneExtraWidth}
    >
      <ConversationPaneBody />
    </PaneRuntimeProvider>,
  );
}

let restoreChatGeometry = () => undefined;

function installChatGeometry(scrollport: HTMLElement) {
  restoreChatGeometry();

  let scrollTop = 0;
  const messageTop: Record<string, number> = {
    "root-user": 0,
    "root-assistant": 80,
    "branch-a-user": 200,
    "branch-a-assistant": 300,
    "branch-b-user": 200,
    "branch-b-assistant": 300,
  };
  Object.defineProperty(scrollport, "clientHeight", {
    configurable: true,
    get: () => 220,
  });
  Object.defineProperty(scrollport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = Number(value);
    },
  });
  Object.defineProperty(scrollport, "scrollHeight", {
    configurable: true,
    get: () => 520,
  });

  const topMock = vi
    .spyOn(HTMLElement.prototype, "offsetTop", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.messageId ? messageTop[this.dataset.messageId] ?? 0 : 0;
    });
  const heightMock = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.messageId ? 80 : 0;
    });

  restoreChatGeometry = () => {
    topMock.mockRestore();
    heightMock.mockRestore();
    restoreChatGeometry = () => undefined;
  };
}

describe("ConversationPaneBody", () => {
  beforeEach(() => {
    tailMocks.tailChatRun.mockReset();
    tailMocks.abortAll.mockReset();
    tailMocks.useChatRunTail.mockReset();
    tailMocks.useChatRunTail.mockReturnValue({
      tailChatRun: tailMocks.tailChatRun,
      abortAll: tailMocks.abortAll,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 320,
      writable: true,
    });
  });

  afterEach(() => {
    restoreChatGeometry();
  });

  it("posts retry with an idempotency key and tails the returned run", async () => {
    const user = userEvent.setup();
    const retryData = retryRun();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: failedRootRetryTree() });
      }
      if (path === "/api/models") {
        return jsonResponse({ data: MODELS });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      if (
        path === "/api/messages/failed-assistant/retry" &&
        init?.method === "POST"
      ) {
        return jsonResponse({ data: retryData });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Original prompt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry response" }));

    await waitFor(() => {
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(retryData);
    });
    const retryCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/messages/failed-assistant/retry" &&
        init?.method === "POST",
    );
    expect(retryCall).toBeDefined();
    expect(
      (retryCall?.[1]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toEqual(expect.any(String));
  });

  it("publishes chat context rail width as pane extra width", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
      writable: true,
    });
    const user = userEvent.setup();
    const onSetPaneExtraWidth = vi.fn();
    const resourceKey = resolvePaneRouteIdentity("/conversations/conversation-1")
      .resourceKey;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations/conversation-1/tree") {
          return jsonResponse({ data: treeResponse() });
        }
        if (path === "/api/models") {
          return jsonResponse({ data: MODELS });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { unmount } = renderPane(onSetPaneExtraWidth);

    expect(await screen.findByText("Answer A")).toBeVisible();
    await waitFor(() => {
      expect(onSetPaneExtraWidth).toHaveBeenCalledWith({
        paneId: "pane-1",
        resourceKey,
        widthPx: 320,
      });
    });

    await user.click(screen.getByRole("button", { name: "Collapse secondary rail" }));
    await waitFor(() => {
      expect(onSetPaneExtraWidth).toHaveBeenCalledWith({
        paneId: "pane-1",
        resourceKey,
        widthPx: 36,
      });
    });

    unmount();
    expect(onSetPaneExtraWidth).toHaveBeenLastCalledWith({
      paneId: "pane-1",
      resourceKey,
      widthPx: 0,
    });
  });

  it("preserves the chat viewport while switching cached paths and rolling back a failed active path", async () => {
    const user = userEvent.setup();
    let resolveActivePath: (response: Response) => void = () => undefined;
    const activePathPromise = new Promise<Response>((resolve) => {
      resolveActivePath = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/conversations/conversation-1/tree") {
          return jsonResponse({ data: treeResponse() });
        }
        if (path === "/api/models") {
          return jsonResponse({ data: MODELS });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [] });
        }
        if (
          path === "/api/conversations/conversation-1/active-path" &&
          init?.method === "POST"
        ) {
          return activePathPromise;
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    installChatGeometry(scrollport);
    const composerDock = screen.getByTestId("chat-composer-dock");
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    expect(scrollport).not.toContainElement(input);
    expect(composerDock).toContainElement(input);
    scrollport.scrollTop = 60;
    fireEvent.scroll(scrollport);

    await user.click(
      screen.getByRole("button", { name: /switch to fork\. title: branch b/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("Answer B")).toBeVisible();
    });
    expect(screen.queryByText("Answer A")).not.toBeInTheDocument();
    expect(scrollport.scrollTop).toBe(60);

    resolveActivePath(
      jsonResponse(
        {
          error: {
            code: "E_BRANCH_PATH_INVALID",
            message: "Could not switch active path",
          },
        },
        500,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText("Answer A")).toBeVisible();
    });
    expect(screen.queryByText("Answer B")).not.toBeInTheDocument();
    expect(scrollport.scrollTop).toBe(60);
  });

  it("tails an active sibling run as soon as that cached path becomes visible", async () => {
    const user = userEvent.setup();
    let resolveActivePath: (response: Response) => void = () => undefined;
    const activePathPromise = new Promise<Response>((resolve) => {
      resolveActivePath = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse({ branchBStatus: "pending" }) });
      }
      if (path === "/api/models") {
        return jsonResponse({ data: MODELS });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [activeBranchBRun()] });
      }
      if (
        path === "/api/conversations/conversation-1/active-path" &&
        init?.method === "POST"
      ) {
        return activePathPromise;
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    installChatGeometry(scrollport);
    scrollport.scrollTop = 60;
    fireEvent.scroll(scrollport);
    expect(tailMocks.tailChatRun).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /switch to fork\. title: branch b/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("streaming-cue")).toBeInTheDocument();
    });
    expect(scrollport.scrollTop).toBe(60);
    await waitFor(() => {
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(activeBranchBRun());
    });

    resolveActivePath(
      jsonResponse({
        data: treeResponse({ selected: "b", branchBStatus: "pending" }),
      }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/chat-runs"),
      ).toHaveLength(3);
    });
    expect(scrollport.scrollTop).toBe(60);
  });

});
