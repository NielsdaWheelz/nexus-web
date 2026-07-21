import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Conversation from "@/components/chat/Conversation";
import { __resetChatProfilesCacheForTests } from "@/components/chat/useChatProfiles";
import PaneShell from "@/components/workspace/PaneShell";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";

function paneSizing(input: {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}): EffectivePaneSizing {
  const primaryWidthPx = Math.min(
    input.maxWidthPx,
    Math.max(input.minWidthPx, input.widthPx),
  );
  return {
    primaryWidthPx,
    primaryMinWidthPx: input.minWidthPx,
    primaryMaxWidthPx: input.maxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx,
    renderedPrimarySlotMinWidthPx: input.minWidthPx,
    renderedPrimarySlotMaxWidthPx: input.maxWidthPx,
    fixedChromeWidthPx: 0,
    storedWidthCorrectionPx: null,
  };
}

// Mock only the streaming spine (the SSE boundary). The engine is the sole
// caller of useChatRunTail and owns all other lifecycle state under test.
const tailMocks = vi.hoisted(() => ({
  tailChatRun: vi.fn(),
  abortAll: vi.fn(),
  cancelRun: vi.fn(),
  useChatRunTail: vi.fn(),
}));

vi.mock("@/components/chat/useChatRunTail", () => ({
  useChatRunTail: tailMocks.useChatRunTail,
}));

// PaneShell now consumes the lifted MobileChromeProvider; stub it so the pane
// renders in isolation (matches PaneShell.test.tsx and the body-pane tests).
vi.mock("@/lib/workspace/mobileChrome", () => ({
  useMobileChrome: () => ({
    hidden: false,
    paneChrome: null,
    setPaneChrome: () => {},
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
  usePaneMobileChromeController: () => ({
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
}));

const timestamp = "2026-01-01T00:00:00Z";

const LLM_PROFILES = {
  default_profile_id: "balanced",
  profiles: [
    {
      id: "balanced",
      label: "Balanced",
      description: "Everyday balanced profile",
      provider_label: "Nexus AI",
      model_label: "Sonnet",
      reasoning_options: [{ id: "default", label: "Default" }],
      default_reasoning_option_id: "default",
      privacy_notice: "Processed by Nexus AI.",
    },
  ],
};

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
    trust_trail:
      role === "assistant"
        ? {
            schema_version: "assistant_trust_trail.v1",
            assistant_message_id: id,
            conversation_id: "conversation-1",
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
    conversation: treeResponse().conversation,
    user_message: branchBUser,
    assistant_message: branchBPendingAssistant,
    stream_state: {
      status: "running",
      last_event_seq: 0,
      folded_event_seq: 0,
      assistant_current_text: "",
      tool_calls: [],
      activity: null,
      reconnectable: true,
      terminal: false,
    },
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
    can_rerun: true,
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

function failedRootResendTree(): ConversationTreeResponse {
  const failedUser = message("failed-user", 1, "user", "Original prompt");
  const failedAssistant: ConversationMessage = {
    ...message(
      "failed-assistant",
      2,
      "assistant",
      "The response failed.",
      "failed-user",
      "error",
    ),
    can_rerun: false,
  };
  return {
    conversation: {
      id: "conversation-1",
      title: "Resend chat",
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
      profile_id: "balanced",
      reasoning_option_id: "default",
      provider: null,
      model_name: null,
      reasoning_effort: null,
      error_origin: null,
      support_id: null,
      failure: null,
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
    stream_state: {
      status: "queued",
      last_event_seq: 0,
      folded_event_seq: 0,
      assistant_current_text: "",
      tool_calls: [],
      activity: null,
      reconnectable: true,
      terminal: false,
    },
  };
}

function renderPane(
  options: {
    href?: string;
    pathParams?: Record<string, string>;
    onReplacePane?: (
      paneId: string,
      href: string,
      navOptions?: { titleHint?: string },
    ) => void;
  } = {},
) {
  const href = options.href ?? "/conversations/conversation-1";
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  const onReplacePane = options.onReplacePane ?? vi.fn();
  render(
    <PaneRuntimeProvider
      paneId="pane-1"
      isActive={true}
      href={href}
      routeId={href === "/conversations/new" ? "conversation-new" : "conversation"}
      routeKey={routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={options.pathParams ?? { id: "conversation-1" }}
      onNavigatePane={vi.fn()}
      onReplacePane={onReplacePane}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={vi.fn()}
    >
      <Conversation />
    </PaneRuntimeProvider>,
  );
  return { onReplacePane };
}

let restoreChatGeometry = () => undefined;

// Mock the scrollport + message-row geometry the scroll owner reads so we can
// assert the eye-line is preserved across a branch switch without a layout host.
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

describe("Conversation", () => {
  beforeEach(() => {
    __resetChatProfilesCacheForTests();
    tailMocks.tailChatRun.mockReset();
    tailMocks.abortAll.mockReset();
    tailMocks.cancelRun.mockReset();
    tailMocks.useChatRunTail.mockReset();
    tailMocks.useChatRunTail.mockImplementation(
      (options?: {
        onConversationAvailable?: (
          conversationId: string,
          runId: string,
        ) => void;
      }) => ({
        tailChatRun: tailMocks.tailChatRun.mockImplementation(
          (runData: ChatRunResponse["data"]) => {
            options?.onConversationAvailable?.(
              runData.conversation.id,
              runData.run.id,
            );
          },
        ),
        abortAll: tailMocks.abortAll,
        cancelRun: tailMocks.cancelRun,
        activeRunId: null,
        lostConnections: {},
        reconnectRun: vi.fn(),
      }),
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 320,
      writable: true,
    });
  });

  afterEach(() => {
    restoreChatGeometry();
    vi.unstubAllGlobals();
  });

  it("posts rerun with an idempotency key and tails the returned run", async () => {
    const user = userEvent.setup();
    const rerunData = retryRun();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: failedRootRetryTree() });
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      if (
        path === "/api/messages/failed-assistant/rerun" &&
        init?.method === "POST"
      ) {
        return jsonResponse({ data: rerunData });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Original prompt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() => {
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(rerunData);
    });
    const rerunCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/messages/failed-assistant/rerun" &&
        init?.method === "POST",
    );
    expect(rerunCall).toBeDefined();
    expect(
      (rerunCall?.[1]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toEqual(expect.any(String));
  });

  it("shows a failure card with no Run again action for a non-rerunnable failed root", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: failedRootResendTree() });
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Original prompt")).toBeVisible();
    // The one failure card renders, but a non-rerunnable failure offers no action.
    expect(screen.getByText("Something went wrong")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    // No rerun request is ever issued.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        pathOf(input).endsWith("/rerun"),
      ),
    ).toBe(false);
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
        if (path === "/api/conversations/conversation-1/context-refs") {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
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
    // A genuine user gesture releases the auto-pin; only then does a manual
    // scroll position stick (the scroll owner holds the pinned anchor otherwise).
    fireEvent.wheel(scrollport, { deltaY: -10 });
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
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
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
    fireEvent.wheel(scrollport, { deltaY: -10 });
    scrollport.scrollTop = 60;
    fireEvent.scroll(scrollport);
    expect(tailMocks.tailChatRun).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /switch to fork\. title: branch b/i }),
    );

    await waitFor(() => {
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(activeBranchBRun());
    });
    expect(scrollport.scrollTop).toBe(60);

    resolveActivePath(
      jsonResponse({
        data: treeResponse({ selected: "b", branchBStatus: "pending" }),
      }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/chat-runs"),
      ).not.toHaveLength(0);
    });
    expect(scrollport.scrollTop).toBe(60);
  });

  it("creates a conversation on first send and navigates to it without a run param", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/conversations" && init?.method === "POST") {
        return jsonResponse({ data: { id: "new-conv-id" } });
      }
      if (path === "/api/conversations/new-conv-id/tree") {
        return jsonResponse({
          data: {
            ...treeResponse(),
            conversation: { ...treeResponse().conversation, id: "new-conv-id" },
          },
        });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ChatRunCreateRequest;
        return jsonResponse({
          data: {
            run: {
              id: "run-1",
              status: "complete",
              conversation_id: "new-conv-id",
              user_message_id: "user-message-1",
              assistant_message_id: "assistant-message-1",
              profile_id: body.profile_id,
              reasoning_option_id: body.reasoning_option_id,
                            cancel_requested_at: null,
              started_at: timestamp,
              completed_at: timestamp,
              error_code: null,
              created_at: timestamp,
              updated_at: timestamp,
            },
            conversation: {
              id: "new-conv-id",
              title: "New chat",
              sharing: "private",
              message_count: 2,
              created_at: timestamp,
              updated_at: timestamp,
            },
            user_message: message("user-message-1", 1, "user", body.content),
            assistant_message: message(
              "assistant-message-1",
              2,
              "assistant",
              "Done.",
              "user-message-1",
            ),
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/new",
      pathParams: {},
      onReplacePane,
    });

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(input);
    await user.keyboard("Plain question");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => pathOf(input) === "/api/chat-runs"),
      ).toBe(true);
    });

    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    const body = JSON.parse(String(chatRunCall?.[1]?.body)) as ChatRunCreateRequest;
    expect(body.conversation_id).toBe("new-conv-id");

    await waitFor(() => {
      expect(onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/conversations/new-conv-id",
        undefined,
      );
    });
  });

  it("sends an existing non-empty conversation with the complete assistant leaf as parent", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({ data: treeResponse() });
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs" && method === "GET") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/chat-runs" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
        const followUpUser = message(
          "follow-up-user",
          7,
          "user",
          body.content,
          body.parent_message_id ?? null,
        );
        const followUpAssistant = message(
          "follow-up-assistant",
          8,
          "assistant",
          "",
          followUpUser.id,
          "pending",
        );
        return jsonResponse({
          data: {
            run: {
              id: "follow-up-run",
              status: "running",
              conversation_id: body.conversation_id,
              user_message_id: followUpUser.id,
              assistant_message_id: followUpAssistant.id,
              profile_id: body.profile_id,
              reasoning_option_id: body.reasoning_option_id,
                            cancel_requested_at: null,
              started_at: timestamp,
              completed_at: null,
              error_code: null,
              created_at: timestamp,
              updated_at: timestamp,
            },
            conversation: treeResponse().conversation,
            user_message: followUpUser,
            assistant_message: followUpAssistant,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(input);
    await user.keyboard("Continue from the leaf");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([callInput, callInit]) =>
            pathOf(callInput) === "/api/chat-runs" &&
            callInit?.method === "POST",
        ),
      ).toBe(true);
    });

    const chatRunCall = fetchMock.mock.calls.find(
      ([callInput, callInit]) =>
        pathOf(callInput) === "/api/chat-runs" &&
        callInit?.method === "POST",
    );
    const body = JSON.parse(String(chatRunCall?.[1]?.body)) as ChatRunCreateRequest;
    expect(body).toMatchObject({
      conversation_id: "conversation-1",
      content: "Continue from the leaf",
      parent_message_id: "branch-a-assistant",
      branch_anchor: {
        kind: "assistant_message",
        message_id: "branch-a-assistant",
      },
    });
  });

  it("disables existing conversation sends while the assistant leaf is pending", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse({
          data: treeResponse({ selected: "b", branchBStatus: "pending" }),
        });
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs" && method === "GET") {
        return jsonResponse({ data: [activeBranchBRun()] });
      }
      throw new Error(`Unexpected fetch call: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(
      await screen.findByText(
        "Wait for the assistant response to finish before sending.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          pathOf(input) === "/api/chat-runs" && init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("shows a disabled composer while /tree is pending for an existing conversation", async () => {
    // /tree never resolves: the existing route must show the loading notice and
    // keep the composer blocked until history proves a safe parent.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/conversations/conversation-1/tree") {
        return new Promise<Response>(() => {});
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Loading conversation...")).toBeVisible();
    expect(
      await screen.findByText("Loading conversation history before sending."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeVisible();
  });

  it("shows a not-found/error notice with no composer when /tree 404s", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/conversations/conversation-1/tree") {
        return jsonResponse(
          { error: { code: "E_NOT_FOUND", message: "Conversation not found" } },
          404,
        );
      }
      if (path === "/api/conversations/conversation-1/context-refs") {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(
      await screen.findByText("Failed to load conversation"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "SEND" })).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Ask anything" }),
    ).toBeNull();
  });

  it("renders the composer immediately on the new route (no loading gate)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane({ href: "/conversations/new", pathParams: {} });

    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
    expect(screen.queryByText("Loading conversation...")).toBeNull();
  });

  it("toggles the context secondary pane from chrome toolbar buttons", async () => {
    const user = userEvent.setup();
    const onRequestSecondarySurface = vi.fn();
    const onCloseSecondaryPane = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations/conversation-1/tree") {
          return jsonResponse({ data: treeResponse() });
        }
        if (path === "/api/conversations/conversation-1/context-refs") {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const contextRefsPane: WorkspaceAttachedSecondaryPaneState = {
      id: "pane-1-secondary",
      parentPrimaryPaneId: "pane-1",
      groupId: "conversation-context",
      activeSurfaceId: "conversation-context-refs",
      widthPx: 320,
      visibility: "visible",
    };

    const tree = (secondaryPane: WorkspaceAttachedSecondaryPaneState | null) => (
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href="/conversations/conversation-1"
        routeId="conversation"
        routeKey={
          resolvePaneRouteIdentity("/conversations/conversation-1").routeKey
        }
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        pathParams={{ id: "conversation-1" }}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneTitle={vi.fn()}
        secondaryPane={secondaryPane}
        onRequestSecondarySurface={onRequestSecondarySurface}
        onCloseSecondaryPane={onCloseSecondaryPane}
      >
        <PaneShell
          paneId="pane-1"
          title="Chat"
          navigation={{
            canGoBack: false,
            canGoForward: false,
            onBack: vi.fn(),
            onForward: vi.fn(),
          }}
          sizing={paneSizing({ widthPx: 480, minWidthPx: 320, maxWidthPx: 1400 })}
          bodyMode="contained"
          onResizePrimaryPane={vi.fn()}
        >
          <Conversation />
        </PaneShell>
      </PaneRuntimeProvider>
    );

    const view = render(tree(null));

    // Branch history present -> the Forks toggle joins Context in the chrome.
    expect(await screen.findByText("Answer A")).toBeVisible();
    const contextRefsToggle = screen.getByRole("button", { name: "Context" });
    expect(contextRefsToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Forks" })).toBeInTheDocument();

    await user.click(contextRefsToggle);
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "conversation-context-refs",
    );

    // With the context-ref surface open, the same button collapses it.
    view.rerender(tree(contextRefsPane));
    const activeContextRefsToggle = screen.getByRole("button", {
      name: "Context",
    });
    expect(activeContextRefsToggle).toHaveAttribute("aria-pressed", "true");
    await user.click(activeContextRefsToggle);
    expect(onCloseSecondaryPane).toHaveBeenCalledWith("pane-1-secondary");
  });
});
