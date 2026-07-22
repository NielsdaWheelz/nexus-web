import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ChatComposer from "@/components/chat/ChatComposer";
import { __resetChatProfilesCacheForTests } from "@/components/chat/useChatProfiles";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { BranchDraft } from "@/lib/conversations/types";

const LLM_PROFILES = {
  default_profile_id: "balanced",
  profiles: [
    {
      id: "balanced",
      label: "Balanced",
      description: "Everyday balanced profile",
      provider_label: "Nexus AI",
      model_label: "Sonnet",
      reasoning_options: [
        { id: "default", label: "Default" },
        { id: "high", label: "High" },
      ],
      default_reasoning_option_id: "default",
      privacy_notice: "Processed by Nexus AI.",
    },
    {
      id: "fast",
      label: "Fast",
      description: "Low-latency profile",
      provider_label: "Nexus AI",
      model_label: "Haiku",
      reasoning_options: [{ id: "default", label: "Default" }],
      default_reasoning_option_id: "default",
      privacy_notice: "Processed by Nexus AI.",
    },
  ],
};

const originalInnerWidth = window.innerWidth;
const originalBodyMargin = document.body.style.margin;

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

function chatRunResponse(body: ChatRunCreateRequest) {
  return {
    data: {
      run: {
        id: "run-1",
        status: "queued",
        conversation_id: "conversation-1",
        user_message_id: "user-message-1",
        assistant_message_id: "assistant-message-1",
        profile_id: body.profile_id,
        reasoning_option_id: body.reasoning_option_id,
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
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      conversation: { id: "conversation-1" },
      user_message: {
        id: "user-message-1",
        seq: 1,
        role: "user",
        message_document: {
          type: "message_document",
          blocks: [{ type: "text", format: "plain", text: body.content }],
        },
        trust_trail: null,
        status: "complete",
        can_rerun: false,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      assistant_message: {
        id: "assistant-message-1",
        seq: 2,
        role: "assistant",
        message_document: { type: "message_document", blocks: [] },
        trust_trail: {
          schema_version: "assistant_trust_trail.v1",
          assistant_message_id: "assistant-message-1",
          conversation_id: "conversation-1",
          chat_run_id: "run-1",
          status: "pending",
          run: null,
          prompt: null,
          tool_calls: [],
          citations: [],
          context_refs_added: [],
          integrity_notices: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        status: "pending",
        can_rerun: false,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
}

function installChatComposerFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (path === "/api/llm-profiles") {
      return jsonResponse({ data: LLM_PROFILES });
    }
    if (path === "/api/chat-runs" && init?.method === "POST") {
      return jsonResponse(
        chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
      );
    }
    throw new Error(`Unexpected fetch call: ${path}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatRunCalls(fetchMock: ReturnType<typeof installChatComposerFetchMock>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("ChatComposer", () => {
  beforeEach(() => {
    __resetChatProfilesCacheForTests();
    document.body.style.margin = "";
    setViewportWidth(1024);
  });

  afterEach(() => {
    document.body.style.margin = originalBodyMargin;
    setViewportWidth(originalInnerWidth);
  });

  it("shares the cached profile catalog across multiple composer mounts", async () => {
    const fetchMock = installChatComposerFetchMock();

    render(
      <>
        <ChatComposer conversationId="conversation-1" />
        <ChatComposer conversationId="conversation-2" />
      </>,
    );

    expect(
      await screen.findAllByRole("combobox", { name: "AI profile" }),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => pathOf(input) === "/api/llm-profiles",
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it("selects a non-default profile and sends its profile + default reasoning", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onChatRunCreated = vi.fn();

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-current"
        onChatRunCreated={onChatRunCreated}
      />,
    );

    const profilePicker = await screen.findByRole("combobox", {
      name: "AI profile",
    });
    await user.selectOptions(profilePicker, "fast");

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Explain this quote");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest & {
      conversation_id?: string;
    };

    expect(body).toMatchObject({
      conversation_id: "conversation-1",
      parent_message_id: "assistant-current",
      branch_anchor: {
        kind: "assistant_message",
        message_id: "assistant-current",
      },
      content: "Explain this quote",
      profile_id: "fast",
      reasoning_option_id: "default",
    });
    // The browser owns no provider/model/reasoning/key policy — those raw fields
    // are never sent.
    expect(body).not.toHaveProperty("model_id");
    expect(body).not.toHaveProperty("key_mode");
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("conversation_scope");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "Idempotency-Key": expect.any(String),
      }),
    );
    expect(onChatRunCreated).toHaveBeenCalledOnce();
  });

  it("selects a reasoning option on the default profile and sends it", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    await screen.findByRole("combobox", { name: "AI profile" });
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Reasoning" }),
      "high",
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Think hard about this");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.profile_id).toBe("balanced");
    expect(body.reasoning_option_id).toBe("high");
  });

  it("keeps Shift+Enter as a newline and sends on Enter", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("First line{Shift>}{Enter}{/Shift}Second line");

    expect(message).toHaveValue("First line\nSecond line");
    expect(chatRunCalls(fetchMock)).toHaveLength(0);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.content).toBe("First line\nSecond line");
  });

  it("shows branch reply mode and sends the branch anchor payload", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onClearBranchDraft = vi.fn();
    const onJumpToBranchParent = vi.fn();
    const branchDraft: BranchDraft = {
      parentMessageId: "assistant-parent",
      parentMessageSeq: 4,
      parentMessagePreview: "The complete assistant answer.",
      anchor: {
        kind: "assistant_selection",
        message_id: "assistant-parent",
        exact: "assistant answer",
        prefix: "The complete ",
        suffix: ".",
        offset_status: "mapped",
        start_offset: 13,
        end_offset: 29,
        client_selection_id: "selection-1",
      },
    };

    render(
      <ChatComposer
        conversationId="conversation-1"
        branchDraft={branchDraft}
        onClearBranchDraft={onClearBranchDraft}
        onJumpToBranchParent={onJumpToBranchParent}
      />,
    );

    expect(await screen.findByText("Fork reply")).toBeInTheDocument();
    expect(screen.getByText("Parent message 4")).toBeInTheDocument();
    expect(screen.getByText("The complete assistant answer.")).toBeInTheDocument();
    expect(screen.getByText("assistant answer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel branch reply" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Jump to parent message" }));
    expect(onJumpToBranchParent).toHaveBeenCalledWith("assistant-parent");

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Take this branch");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest & {
      conversation_id?: string;
    };

    expect(body).toMatchObject({
      conversation_id: "conversation-1",
      content: "Take this branch",
      parent_message_id: "assistant-parent",
      branch_anchor: branchDraft.anchor,
    });
    expect(onClearBranchDraft).toHaveBeenCalledOnce();
  });

  it("restores local drafts when switching between active path and branch mode", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    const branchDraft: BranchDraft = {
      parentMessageId: "assistant-parent",
      parentMessageSeq: 4,
      parentMessagePreview: "The complete assistant answer.",
      anchor: {
        kind: "assistant_message",
        message_id: "assistant-parent",
      },
    };

    const { rerender } = render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-current"
        branchDraft={branchDraft}
      />,
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("branch draft");

    rerender(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-current"
      />,
    );

    await waitFor(() => {
      expect(message).toHaveValue("");
    });
    await user.keyboard("path draft");

    rerender(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-current"
        branchDraft={branchDraft}
      />,
    );

    await waitFor(() => {
      expect(message).toHaveValue("branch draft");
    });

    rerender(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-current"
      />,
    );

    await waitFor(() => {
      expect(message).toHaveValue("path draft");
    });
  });

  it("sends a valid assistant-message branch anchor for full-message forks", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const branchDraft: BranchDraft = {
      parentMessageId: "assistant-parent",
      parentMessageSeq: 4,
      parentMessagePreview: "The complete assistant answer.",
      anchor: {
        kind: "assistant_message",
      },
    };

    render(
      <ChatComposer
        conversationId="conversation-1"
        branchDraft={branchDraft}
      />,
    );

    expect(await screen.findByText("Fork reply")).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Fork from the whole answer");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body).toMatchObject({
      parent_message_id: "assistant-parent",
      branch_anchor: {
        kind: "assistant_message",
        message_id: "assistant-parent",
      },
    });
  });

  it("sends an explicit no-branch anchor for root continuation messages", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Start a new root chat");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body.conversation_id).toBe("conversation-1");
    expect(body.parent_message_id).toBeUndefined();
    expect(body.branch_anchor).toEqual({ kind: "none" });
    expect(body).not.toHaveProperty("conversation_scope");
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("singleton");
    expect(body).not.toHaveProperty("chat_subject");
  });

  it("keeps a stable-key draft when conversation identity changes", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();

    const { rerender } = render(
      <ChatComposer conversationId={null} draftKey="new-conversation" />,
    );

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Draft during resolution");

    rerender(
      <ChatComposer conversationId="conversation-1" draftKey="new-conversation" />,
    );

    expect(message).toHaveValue("Draft during resolution");
  });

  it("resolves the conversation on send and uses the resolved id with chat_subject for a new resource-chat first message", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onResolveConversation = vi.fn(async () => "resolved-id");

    render(
      <ChatComposer
        conversationId={null}
        onResolveConversation={onResolveConversation}
        chatSubject={{ resource_ref: "media:media-1" }}
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("First message into the doc chat");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    expect(onResolveConversation).toHaveBeenCalledOnce();

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body.conversation_id).toBe("resolved-id");
    expect(body).not.toHaveProperty("singleton");
    expect(body.chat_subject).toEqual({ resource_ref: "media:media-1" });
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("conversation_scope");
  });

  it("does not send when onResolveConversation returns null", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onResolveConversation = vi.fn(async () => null);

    render(
      <ChatComposer
        conversationId={null}
        onResolveConversation={onResolveConversation}
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("This should not send");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(onResolveConversation).toHaveBeenCalledOnce();
    });
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("renders pending context-ref chips and removes them on click", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    const onRemovePendingContextRef = vi.fn();

    render(
      <ChatComposer
        conversationId="conversation-1"
        pendingContextRefs={[
          { uri: "media:media-1#p3", label: "On the Origin of Species" },
        ]}
        onRemovePendingContextRef={onRemovePendingContextRef}
      />,
    );

    expect(
      await screen.findByText("On the Origin of Species"),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Remove On the Origin of Species" }),
    );

    expect(onRemovePendingContextRef).toHaveBeenCalledWith("media:media-1#p3");
  });

  it("does not render a web-search selector or scope chip in the composer", async () => {
    installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: /web search/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/web search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^scope/i)).not.toBeInTheDocument();
  });

  it("flips the send button to SENDING while the chat run is in flight (D-3, R-6)", async () => {
    const user = userEvent.setup();
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          await runGate;
          return jsonResponse(
            chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatComposer conversationId="conversation-1" />);

    // Idle: the send action is a text "SEND" button (no ArrowUp icon).
    const sendButton = await screen.findByRole("button", { name: "SEND" });

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Hold the line while it sends");
    await user.click(sendButton);

    // In-flight: the same button reads "SENDING" (the visible text is the
    // accessible name — no separate aria-label, per D-3/R-6).
    expect(
      await screen.findByRole("button", { name: "SENDING" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SEND" })).toBeNull();

    // Resolve the run; the button returns to "SEND".
    releaseRun();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SEND" })).toBeInTheDocument();
    });
  });

  it("keeps the composer controls inside a 320px mobile width without horizontal scrolling", async () => {
    installChatComposerFetchMock();
    setViewportWidth(320);
    document.body.style.margin = "0";

    render(
      <div
        data-testid="mobile-composer-host"
        style={{ width: "320px", maxWidth: "320px" }}
      >
        <ChatComposer conversationId="conversation-1" />
      </div>,
    );

    expect(
      await screen.findByRole("combobox", { name: "AI profile" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Web search mode" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SEND" })).toBeVisible();

    const host = screen.getByTestId("mobile-composer-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });
});
