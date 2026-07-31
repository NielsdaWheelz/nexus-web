import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Conversation from "@/components/chat/Conversation";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { __resetChatProfilesCacheForTests } from "@/components/chat/useChatProfiles";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import PaneShell from "@/components/workspace/PaneShell";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import {
  assumePaneVisitId,
  type WorkspaceAttachedSecondaryPaneState,
} from "@/lib/workspace/schema";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { MessageUpdateAction } from "@/lib/conversations/messageUpdateReducer";
import { decodeChatRunData } from "@/lib/conversations/messageWire";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

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
      privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
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
            conversation_id: "00000000-0000-4000-8000-000000000101",
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

function assistantWithProfileSelection(
  assistant: ConversationMessage,
  selection: { profileId: string; reasoningOptionId: string },
  runId = `run-${assistant.id}`,
): ConversationMessage {
  if (assistant.role !== "assistant" || assistant.trust_trail === null) {
    throw new Error("Expected an assistant message with a trust trail");
  }
  return {
    ...assistant,
    trust_trail: {
      ...assistant.trust_trail,
      chat_run_id: runId,
      run: {
        run_id: runId,
        profile_id: selection.profileId,
        reasoning_option_id: selection.reasoningOptionId,
        provider: "Not a selection source",
        model_name: "Not a selection source",
        status: assistant.status,
        usage: null,
        error_code: null,
        error_origin: null,
        failure: null,
        reasoning_effort: { kind: "Absent" },
        support_id: { kind: "Absent" },
        publication_warning: { kind: "Absent" },
        final_chars: null,
        started_at: timestamp,
        completed_at: timestamp,
        total_cost_usd_micros: null,
      },
    },
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
const branchAUser = message(
  "branch-a-user",
  3,
  "user",
  "Ask A",
  "root-assistant",
);
const branchAAssistant = message(
  "branch-a-assistant",
  4,
  "assistant",
  "Answer A",
  "branch-a-user",
);
const branchBUser = message(
  "branch-b-user",
  5,
  "user",
  "Ask B",
  "root-assistant",
);
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
      id: "00000000-0000-4000-8000-000000000101",
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
      conversation_id: "00000000-0000-4000-8000-000000000101",
      user_message_id: "branch-b-user",
      assistant_message_id: "branch-b-assistant",
      profile_id: "balanced",
      reasoning_option_id: "default",
      provider: null,
      model_name: null,
      reasoning_effort: null,
      error_origin: null,
      support_id: { kind: "Absent" },
      publication_warning: { kind: "Absent" },
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
      id: "00000000-0000-4000-8000-000000000101",
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
      id: "00000000-0000-4000-8000-000000000101",
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
      conversation_id: "00000000-0000-4000-8000-000000000101",
      user_message_id: "retry-user",
      assistant_message_id: "retry-assistant",
      profile_id: "balanced",
      reasoning_option_id: "default",
      provider: null,
      model_name: null,
      reasoning_effort: null,
      error_origin: null,
      support_id: { kind: "Absent" },
      publication_warning: { kind: "Absent" },
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
      options?: { labelHint?: string },
    ) => void;
    onActivateWorkspaceTarget?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onActivateWorkspaceTarget"];
    onNavigatePane?: ComponentProps<typeof PaneRuntimeProvider>["onNavigatePane"];
    onPreviewTransientSecondaryResult?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onPreviewTransientSecondaryResult"];
    onRequestTransientSecondarySurface?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onRequestTransientSecondarySurface"];
    onCloseTransientSecondarySurface?: ComponentProps<
      typeof PaneRuntimeProvider
    >["onCloseTransientSecondarySurface"];
  } = {},
) {
  const href =
    options.href ?? "/conversations/00000000-0000-4000-8000-000000000101";
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  const onReplacePane = options.onReplacePane ?? vi.fn();
  const publishPrimaryChrome =
    vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
  render(
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive={true}
      href={href}
      routeId={
        href === "/conversations/new" ? "conversation-new" : "conversation"
      }
      routeKey={routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={
        options.pathParams ?? { id: "00000000-0000-4000-8000-000000000101" }
      }
      onNavigatePane={options.onNavigatePane ?? vi.fn()}
      onReplacePane={onReplacePane}
      onActivateWorkspaceTarget={
        options.onActivateWorkspaceTarget ??
        vi.fn(() => ({ kind: "ActivatedExisting" as const, paneId: "pane" }))
      }
      onSetPaneLabel={vi.fn()}
      onPreviewTransientSecondaryResult={
        options.onPreviewTransientSecondaryResult
      }
      onRequestTransientSecondarySurface={
        options.onRequestTransientSecondarySurface
      }
      onCloseTransientSecondarySurface={
        options.onCloseTransientSecondarySurface
      }
    >
      <PanePrimaryChromeProvider publish={publishPrimaryChrome}>
        <Conversation />
      </PanePrimaryChromeProvider>
    </PaneRuntimeProvider>,
  );
  return { onReplacePane, publishPrimaryChrome };
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
      return this.dataset.messageId
        ? (messageTop[this.dataset.messageId] ?? 0)
        : 0;
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
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: failedRootRetryTree() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
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
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Original prompt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() => {
      // The engine decodes the run's reader-selection snapshot at the boundary
      // before tailing it.
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(
        decodeChatRunData(rerunData),
      );
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

  it("keeps Find published when a rerun fails over a loaded transcript", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: failedRootRetryTree() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
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
          return jsonResponse(
            { error: { code: "E_UPSTREAM", message: "Provider unavailable" } },
            503,
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { publishPrimaryChrome } = renderPane();
    expect(await screen.findByText("Original prompt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(await screen.findByText("Failed to run again")).toBeVisible();
    await waitFor(() =>
      expect(
        publishPrimaryChrome.mock.calls.at(-1)?.[0].publication?.search?.kind,
      ).toBe("FindOccurrences"),
    );
  });

  it("shows a failure card with no Run again action for a non-rerunnable failed root", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (
        path === "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
      ) {
        return jsonResponse({ data: failedRootResendTree() });
      }
      if (
        path ===
        "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
      ) {
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
      fetchMock.mock.calls.some(([input]) => pathOf(input).endsWith("/rerun")),
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
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: treeResponse() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [] });
        }
        if (
          path ===
            "/api/conversations/00000000-0000-4000-8000-000000000101/active-path" &&
          init?.method === "POST"
        ) {
          return activePathPromise;
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
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

  it("closes transient Find results and reruns the retained query on a fork switch", async () => {
    const user = userEvent.setup();
    const onRequestTransientSecondarySurface = vi.fn();
    const onCloseTransientSecondarySurface = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: treeResponse() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [] });
        }
        if (
          path ===
            "/api/conversations/00000000-0000-4000-8000-000000000101/active-path" &&
          init?.method === "POST"
        ) {
          return jsonResponse({ data: treeResponse({ selected: "b" }) });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { publishPrimaryChrome } = renderPane({
      onRequestTransientSecondarySurface,
      onCloseTransientSecondarySurface,
    });
    expect(await screen.findByText("Answer A")).toBeVisible();
    const currentFind = () =>
      [...publishPrimaryChrome.mock.calls]
        .reverse()
        .map(([update]) => update.publication?.search)
        .find((search) => search?.kind === "FindOccurrences");
    await waitFor(() => expect(currentFind()?.kind).toBe("FindOccurrences"));
    currentFind()!.onQueryChange("Answer");
    await waitFor(() => expect(currentFind()?.result.kind).toBe("Ready"));
    currentFind()!.onShowResults(document.createElement("button"));
    expect(onRequestTransientSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "conversation:/conversations/00000000-0000-4000-8000-000000000101",
      "resource-search",
      expect.any(HTMLButtonElement),
    );

    await user.click(
      screen.getByRole("button", { name: /switch to fork\. title: branch b/i }),
    );

    await waitFor(() => expect(screen.getByText("Answer B")).toBeVisible());
    expect(onCloseTransientSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "conversation:/conversations/00000000-0000-4000-8000-000000000101",
    );
    await waitFor(() => {
      const publication = currentFind();
      expect(publication?.query).toBe("Answer");
      expect(publication?.result.kind).toBe("Ready");
    });
  });

  it("keeps an exact-message reveal single-flight and retries after active-path rollback", async () => {
    const user = userEvent.setup();
    let resolveFirstActivePath: (response: Response) => void = () => undefined;
    const firstActivePath = new Promise<Response>((resolve) => {
      resolveFirstActivePath = resolve;
    });
    let treeCalls = 0;
    let activePathCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          treeCalls += 1;
          return jsonResponse({ data: treeResponse() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") return jsonResponse({ data: [] });
        if (
          path ===
            "/api/conversations/00000000-0000-4000-8000-000000000101/active-path" &&
          init?.method === "POST"
        ) {
          activePathCalls += 1;
          return activePathCalls === 1
            ? firstActivePath
            : jsonResponse({ data: treeResponse({ selected: "b" }) });
        }
        throw new Error(
          `Unexpected fetch call: ${init?.method ?? "GET"} ${path}`,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/00000000-0000-4000-8000-000000000101?message=branch-b-user",
    });

    expect(await screen.findByText("Answer B")).toBeVisible();
    expect(activePathCalls).toBe(1);

    resolveFirstActivePath(
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

    expect(await screen.findByText("Answer A")).toBeVisible();
    expect(await screen.findByText("Failed to switch fork")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(activePathCalls).toBe(2));
    expect(treeCalls).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText("Answer B")).toBeVisible();
    expect(screen.queryByText("Failed to switch fork")).toBeNull();
  });

  it("recovers an exact-message reveal when refresh observes the committed active path", async () => {
    const user = userEvent.setup();
    let treeCalls = 0;
    let activePathCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          treeCalls += 1;
          return jsonResponse({
            data: treeResponse({ selected: treeCalls === 1 ? "a" : "b" }),
          });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") return jsonResponse({ data: [] });
        if (
          path ===
            "/api/conversations/00000000-0000-4000-8000-000000000101/active-path" &&
          init?.method === "POST"
        ) {
          activePathCalls += 1;
          // Model a committed server mutation whose response was lost or errored.
          return jsonResponse(
            {
              error: {
                code: "E_BRANCH_PATH_RESPONSE_LOST",
                message: "Active-path response unavailable",
              },
            },
            500,
          );
        }
        throw new Error(
          `Unexpected fetch call: ${init?.method ?? "GET"} ${path}`,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/00000000-0000-4000-8000-000000000101?message=branch-b-user",
    });

    expect(await screen.findByText("Failed to switch fork")).toBeVisible();
    expect(screen.getByText("Answer A")).toBeVisible();
    expect(activePathCalls).toBe(1);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(treeCalls).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Answer B")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("Failed to switch fork")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(activePathCalls).toBe(1);
  });

  it("surfaces a missing exact-message target with a refresh-backed Retry action", async () => {
    const user = userEvent.setup();
    let treeCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          treeCalls += 1;
          return jsonResponse({ data: treeResponse() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") return jsonResponse({ data: [] });
        throw new Error(
          `Unexpected fetch call: ${init?.method ?? "GET"} ${path}`,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/00000000-0000-4000-8000-000000000101?message=missing-message",
    });

    expect(
      await screen.findByText(
        "This message is not available in this conversation.",
      ),
    ).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(treeCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(
        screen.getByText("This message is not available in this conversation."),
      ).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          pathOf(input) ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/active-path",
      ),
    ).toHaveLength(0);
  });

  it("keeps exact-message Retry available when the refresh itself fails", async () => {
    const user = userEvent.setup();
    let treeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          treeCalls += 1;
          return treeCalls === 1
            ? jsonResponse({ data: treeResponse() })
            : jsonResponse(
                {
                  error: {
                    code: "E_TREE_REFRESH_FAILED",
                    message: "Tree refresh unavailable",
                  },
                },
                500,
              );
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") return jsonResponse({ data: [] });
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    renderPane({
      href: "/conversations/00000000-0000-4000-8000-000000000101?message=missing-message",
    });
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Failed to refresh forks")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("tails an active sibling run as soon as that cached path becomes visible", async () => {
    const user = userEvent.setup();
    let resolveActivePath: (response: Response) => void = () => undefined;
    const activePathPromise = new Promise<Response>((resolve) => {
      resolveActivePath = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({
            data: treeResponse({ branchBStatus: "pending" }),
          });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs") {
          return jsonResponse({ data: [activeBranchBRun()] });
        }
        if (
          path ===
            "/api/conversations/00000000-0000-4000-8000-000000000101/active-path" &&
          init?.method === "POST"
        ) {
          return activePathPromise;
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    installChatGeometry(scrollport);
    fireEvent.wheel(scrollport, { deltaY: -10 });
    scrollport.scrollTop = 60;
    fireEvent.scroll(scrollport);
    expect(tailMocks.tailChatRun).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /switch to fork\. title: branch b/i }),
    );

    await waitFor(() => {
      expect(tailMocks.tailChatRun).toHaveBeenCalledWith(
        decodeChatRunData(activeBranchBRun()),
      );
    });
    expect(scrollport.scrollTop).toBe(60);

    resolveActivePath(
      jsonResponse({
        data: treeResponse({ selected: "b", branchBStatus: "pending" }),
      }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => pathOf(input) === "/api/chat-runs",
        ),
      ).not.toHaveLength(0);
    });
    expect(scrollport.scrollTop).toBe(60);
  });

  it("finalizes the new-route current visit on first send without opening another pane", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    const onActivateWorkspaceTarget = vi.fn(() => ({
      kind: "CreatedPane" as const,
      paneId: "unexpected-pane",
    }));
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000102/tree"
        ) {
          return jsonResponse({
            data: {
              ...treeResponse(),
              conversation: {
                ...treeResponse().conversation,
                id: "00000000-0000-4000-8000-000000000102",
              },
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
                conversation_id: "00000000-0000-4000-8000-000000000102",
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
                id: "00000000-0000-4000-8000-000000000102",
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
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/new",
      pathParams: {},
      onReplacePane,
      onActivateWorkspaceTarget,
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
        fetchMock.mock.calls.some(
          ([input]) => pathOf(input) === "/api/chat-runs",
        ),
      ).toBe(true);
    });

    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    const body = JSON.parse(
      String(chatRunCall?.[1]?.body),
    ) as ChatRunCreateRequest;
    // The atomic New send creates the conversation; no eager POST /conversations.
    expect(body.destination).toEqual({ kind: "New" });
    expect(
      fetchMock.mock.calls.some(
        ([callInput, callInit]) =>
          pathOf(callInput) === "/api/conversations" &&
          callInit?.method === "POST",
      ),
    ).toBe(false);

    await waitFor(() => {
      expect(onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/conversations/00000000-0000-4000-8000-000000000102",
        { modality: "Programmatic" },
      );
    });
    expect(onActivateWorkspaceTarget).not.toHaveBeenCalled();
  });

  it("uses the causal leaf selection and makes the new run the next source", async () => {
    const user = userEvent.setup();
    tailMocks.useChatRunTail.mockImplementation(
      (options: {
        dispatch: (action: MessageUpdateAction) => void;
        onConversationAvailable?: (
          conversationId: string,
          runId: string,
        ) => void;
      }) => ({
        tailChatRun: tailMocks.tailChatRun.mockImplementation(
          (runData: ChatRunResponse["data"]) => {
            options.dispatch({
              type: "merge_run_pair",
              run: runData,
              idsToReplace: [
                runData.user_message.id,
                runData.assistant_message.id,
              ],
            });
            options.onConversationAvailable?.(
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
    const inheritedLeaf = assistantWithProfileSelection(branchAAssistant, {
      profileId: "balanced",
      reasoningOptionId: "default",
    });
    const inheritedTree = treeResponse();
    inheritedTree.selected_path = [
      rootUser,
      rootAssistant,
      branchAUser,
      inheritedLeaf,
    ];
    inheritedTree.path_cache_by_leaf_id["branch-a-assistant"] =
      inheritedTree.selected_path;
    const profiles = {
      ...LLM_PROFILES,
      profiles: [
        ...LLM_PROFILES.profiles,
        {
          id: "deep",
          label: "Deep",
          description: "Deep profile",
          provider_label: "Nexus AI",
          model_label: "Sonnet",
          reasoning_options: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          default_reasoning_option_id: "high",
          privacy: {
            kind: "Standard" as const,
            notice: "Processed by Nexus AI.",
          },
        },
      ],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: inheritedTree });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: profiles });
        }
        if (path === "/api/chat-runs" && method === "GET") {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/chat-runs" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
          const destination = body.destination;
          const bodyConversationId =
            destination.kind === "Existing"
              ? destination.conversation_id
              : "00000000-0000-4000-8000-000000000101";
          const bodyParentMessageId =
            destination.kind === "Existing" &&
            destination.insertion.kind === "Reply"
              ? destination.insertion.parent_message_id
              : null;
          const followUpUser = message(
            "follow-up-user",
            7,
            "user",
            body.content,
            bodyParentMessageId,
          );
          const followUpAssistant = message(
            "follow-up-assistant",
            8,
            "assistant",
            "",
            followUpUser.id,
            "pending",
          );
          const followUpAssistantWithSelection = assistantWithProfileSelection(
            followUpAssistant,
            {
              profileId: body.profile_id,
              reasoningOptionId: body.reasoning_option_id,
            },
            "follow-up-run",
          );
          return jsonResponse({
            data: {
              run: {
                id: "follow-up-run",
                status: "running",
                conversation_id: bodyConversationId,
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
              assistant_message: followUpAssistantWithSelection,
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${method} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(await screen.findByText("Answer A")).toBeVisible();
    const profilePicker = await screen.findByRole("combobox", {
      name: "AI profile",
    });
    expect(profilePicker).toHaveValue("balanced");
    expect(
      screen.queryByRole("combobox", { name: "Reasoning" }),
    ).not.toBeInTheDocument();

    await user.selectOptions(profilePicker, "deep");
    const reasoningPicker = screen.getByRole("combobox", {
      name: "Reasoning",
    });
    expect(profilePicker).toHaveValue("deep");
    expect(reasoningPicker).toHaveValue("high");

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
        pathOf(callInput) === "/api/chat-runs" && callInit?.method === "POST",
    );
    const body = JSON.parse(
      String(chatRunCall?.[1]?.body),
    ) as ChatRunCreateRequest;
    expect(body.content).toBe("Continue from the leaf");
    expect(body.profile_id).toBe("deep");
    expect(body.reasoning_option_id).toBe("high");
    expect(body.destination).toMatchObject({
      kind: "Existing",
      conversation_id: "00000000-0000-4000-8000-000000000101",
      insertion: {
        kind: "Reply",
        parent_message_id: "branch-a-assistant",
        branch_anchor: {
          kind: "assistant_message",
          message_id: "branch-a-assistant",
        },
      },
    });
    await waitFor(() => {
      expect(profilePicker).toHaveValue("deep");
      expect(reasoningPicker).toHaveValue("high");
    });
  });

  it("disables existing conversation sends while the assistant leaf is pending", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({
            data: treeResponse({ selected: "b", branchBStatus: "pending" }),
          });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
          return jsonResponse({ data: [] });
        }
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs" && method === "GET") {
          return jsonResponse({ data: [activeBranchBRun()] });
        }
        throw new Error(`Unexpected fetch call: ${method} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPane();

    expect(
      await screen.findByText(
        "Assistant response in progress. Your draft is still editable.",
      ),
    ).toHaveAttribute("aria-live", "polite");
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
      if (
        path === "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
      ) {
        return new Promise<Response>(() => {});
      }
      if (
        path ===
        "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
      ) {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { publishPrimaryChrome } = renderPane();

    expect(await screen.findByText("Loading conversation...")).toBeVisible();
    expect(
      await screen.findByText("Conversation history is loading."),
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeVisible();
    expect(
      publishPrimaryChrome.mock.calls.some(
        ([update]) => update.publication?.search?.kind === "FindOccurrences",
      ),
    ).toBe(false);
  });

  it("shows a not-found/error notice with no composer when /tree 404s", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (
        path === "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
      ) {
        return jsonResponse(
          { error: { code: "E_NOT_FOUND", message: "Conversation not found" } },
          404,
        );
      }
      if (
        path ===
        "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
      ) {
        return jsonResponse({ data: [] });
      }
      if (path === "/api/chat-runs") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { publishPrimaryChrome } = renderPane();

    expect(
      await screen.findByText("Failed to load conversation"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "SEND" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Ask anything" })).toBeNull();
    expect(
      publishPrimaryChrome.mock.calls.some(
        ([update]) => update.publication?.menu?.kind === "ResourceMenu",
      ),
    ).toBe(false);
    expect(
      publishPrimaryChrome.mock.calls.some(
        ([update]) => update.publication?.search?.kind === "FindOccurrences",
      ),
    ).toBe(false);
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

    const { publishPrimaryChrome } = renderPane({
      href: "/conversations/new",
      pathParams: {},
    });

    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
    expect(screen.queryByText("Loading conversation...")).toBeNull();
    expect(
      publishPrimaryChrome.mock.calls.some(
        ([update]) => update.publication?.search?.kind === "FindOccurrences",
      ),
    ).toBe(false);
  });

  it("reports a malformed reader-Highlight intent hash as a route error, never degrading to generic chat", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      // A malformed hash must NOT trigger a reader-selection hydration fetch.
      if (path.startsWith("/api/chat-reader-selections")) {
        throw new Error(`Unexpected hydration for a malformed hash: ${path}`);
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPane({
      href: "/conversations/new#mediaId=not-a-uuid&highlightId=also-bad",
      pathParams: {},
    });

    expect(
      await screen.findByText("This quote link is malformed"),
    ).toBeVisible();
    // No pending quote card was fabricated from the invalid hash.
    expect(screen.queryByRole("figure", { name: "Quoted passage" })).toBeNull();
  });

  it("opens the Conversation Resource Inspector from Companion", async () => {
    const user = userEvent.setup();
    const onRequestSecondarySurface = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
        ) {
          return jsonResponse({ data: treeResponse() });
        }
        if (
          path ===
          "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
        ) {
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

    const tree = (secondaryPane: WorkspaceAttachedSecondaryPaneState | null) =>
      withRenderEnvironment(
        <MobileChromeProvider>
          <FeedbackProvider>
            <ShareControllerProvider>
              <LibraryPlacementControllerProvider>
                <PaneReturnMementoProvider>
                  <PaneRuntimeProvider
                    paneId="pane-1"
                    visitId={TEST_VISIT_ID}
                    isActive={true}
                    href="/conversations/00000000-0000-4000-8000-000000000101"
                    routeId="conversation"
                    routeKey={
                      resolvePaneRouteIdentity(
                        "/conversations/00000000-0000-4000-8000-000000000101",
                      ).routeKey
                    }
                    canGoBack={false}
                    canGoForward={false}
                    onGoBackPane={vi.fn()}
                    onGoForwardPane={vi.fn()}
                    pathParams={{
                      id: "00000000-0000-4000-8000-000000000101",
                    }}
                    onNavigatePane={vi.fn()}
                    onReplacePane={vi.fn()}
                    onActivateWorkspaceTarget={vi.fn(() => ({
                      kind: "ActivatedExisting" as const,
                      paneId: "pane",
                    }))}
                    onSetPaneLabel={vi.fn()}
                    secondaryPane={secondaryPane}
                    onRequestSecondarySurface={onRequestSecondarySurface}
                    onCloseSecondaryPane={vi.fn()}
                  >
                    <PaneShell
                      paneId="pane-1"
                      routeKey={
                        resolvePaneRouteIdentity(
                          "/conversations/00000000-0000-4000-8000-000000000101",
                        ).routeKey
                      }
                      routeHeader={{
                        kind: "section",
                        destinationId: "chats",
                        defaultFolio: "none",
                      }}
                      label="Chat"
                      returnMementoEnabled={false}
                      sizing={paneSizing({
                        widthPx: 480,
                        minWidthPx: 320,
                        maxWidthPx: 1400,
                      })}
                      bodyMode="contained"
                      onResizePrimaryPane={vi.fn()}
                    >
                      <Conversation />
                    </PaneShell>
                  </PaneRuntimeProvider>
                </PaneReturnMementoProvider>
              </LibraryPlacementControllerProvider>
            </ShareControllerProvider>
          </FeedbackProvider>
        </MobileChromeProvider>,
      );

    render(tree(null));

    // Context and Forks are Inspector tabs, not independent chrome controls.
    expect(await screen.findByText("Answer A")).toBeVisible();
    const companion = screen.getByRole("button", { name: "Companion" });
    expect(companion).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forks" })).toBeNull();

    await user.click(companion);
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-context",
      expect.any(HTMLButtonElement),
    );
  });

  it("publishes Find for a loaded empty existing conversation", async () => {
    const emptyTree: ConversationTreeResponse = {
      ...treeResponse(),
      conversation: {
        ...treeResponse().conversation,
        message_count: 0,
      },
      selected_path: [],
      active_leaf_message_id: null,
      fork_options_by_parent_id: {},
      path_cache_by_leaf_id: {},
      branch_graph: {
        root_message_id: null,
        edges: [],
        nodes: [],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (
        path ===
        "/api/conversations/00000000-0000-4000-8000-000000000101/tree"
      ) {
        return jsonResponse({ data: emptyTree });
      }
      if (
        path ===
        "/api/conversations/00000000-0000-4000-8000-000000000101/context-refs"
      ) {
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

    const { publishPrimaryChrome } = renderPane();
    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        publishPrimaryChrome.mock.calls.at(-1)?.[0].publication?.search?.kind,
      ).toBe("FindOccurrences"),
    );
    const publication =
      publishPrimaryChrome.mock.calls.at(-1)?.[0].publication?.search;
    if (publication?.kind !== "FindOccurrences") {
      throw new Error("Expected Conversation Find publication");
    }
    expect(publication.inputLabel).toBe("Find in conversation");
    expect(publication.placeholder).toBe("Find in conversation");
  });
});
