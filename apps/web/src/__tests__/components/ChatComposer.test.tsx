import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer from "@/components/chat/ChatComposer";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { BranchDraft } from "@/lib/conversations/types";

const MODELS = [
  {
    id: "gpt-5.5",
    provider: "openai",
    provider_display_name: "OpenAI",
    model_name: "gpt-5.5",
    model_display_name: "GPT-5.5",
    model_tier: "sota",
    reasoning_modes: ["default", "medium", "high"],
    max_context_tokens: 256000,
    available_via: "both",
    provider_rank: 0,
    model_rank: 1,
    is_default: false,
    available_key_modes: ["auto", "byok_only", "platform_only"],
    capabilities: {
      prompt_cache: {
        mode: "keyed_ttl",
        supported: true,
        key_required: true,
        ttl_options: ["5m", "1h"],
      },
      streaming: true,
      tool_calling: true,
      structured_output: true,
      structured_output_streaming: false,
      reasoning_continuation: true,
    },
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    provider_display_name: "OpenAI",
    model_name: "gpt-5-mini",
    model_display_name: "GPT-5 mini",
    model_tier: "light",
    reasoning_modes: ["default", "none", "medium"],
    max_context_tokens: 128000,
    available_via: "platform",
    provider_rank: 0,
    model_rank: 0,
    is_default: true,
    available_key_modes: ["auto", "platform_only"],
    capabilities: {
      prompt_cache: {
        mode: "keyed_ttl",
        supported: true,
        key_required: true,
        ttl_options: ["5m", "1h"],
      },
      streaming: true,
      tool_calling: true,
      structured_output: true,
      structured_output_streaming: false,
      reasoning_continuation: true,
    },
  },
] as const;

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
        model_id: body.model_id,
        reasoning: body.reasoning,
        key_mode: body.key_mode,
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
        content: body.content,
        contexts: [],
        tool_calls: [],
        status: "complete",
        error_code: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      assistant_message: {
        id: "assistant-message-1",
        seq: 2,
        role: "assistant",
        content: "",
        contexts: [],
        tool_calls: [],
        status: "pending",
        error_code: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
}

function installChatComposerFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (path === "/api/models") {
      return jsonResponse({ data: MODELS });
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

async function openModelSettings(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByRole("combobox", { name: "Provider" })) {
    return;
  }

  await user.click(
    screen.getByRole("button", { name: /model settings|gpt-5/i }),
  );
  await screen.findByRole("combobox", { name: "Provider" });
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function describeElement(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ??
    element.getAttribute("role") ??
    element.tagName.toLowerCase()
  );
}

function horizontallyScrollableElements(root: HTMLElement): string[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
    .filter((element) => {
      const overflowX = getComputedStyle(element).overflowX;
      return (
        (overflowX === "auto" || overflowX === "scroll") &&
        element.scrollWidth > element.clientWidth + 1
      );
    })
    .map(describeElement);
}

describe("ChatComposer", () => {
  beforeEach(() => {
    document.body.style.margin = "";
    setViewportWidth(1024);
  });

  afterEach(() => {
    document.body.style.margin = originalBodyMargin;
    setViewportWidth(originalInnerWidth);
  });

  it("shares cached model loading across multiple composer mounts", async () => {
    const fetchMock = installChatComposerFetchMock();

    render(
      <>
        <ChatComposer conversationId="conversation-1" />
        <ChatComposer conversationId="conversation-2" />
      </>,
    );

    expect(
      await screen.findAllByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/models").length,
    ).toBeLessThanOrEqual(1);
  });

  it("changes model settings and sends the selected request payload", async () => {
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

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    await openModelSettings(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "gpt-5.5",
    );

    await openModelSettings(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reasoning" }),
      "high",
    );

    await openModelSettings(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Key mode" }),
      "byok_only",
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Explain this quote");
    await user.click(screen.getByRole("button", { name: "Send message" }));

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
      model_id: "gpt-5.5",
      reasoning: "high",
      key_mode: "byok_only",
    });
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

  it("sends platform_only when selected from model settings", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    await openModelSettings(user);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Key mode" }),
      "platform_only",
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Use the platform key");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.key_mode).toBe("platform_only");
  });

  it("keeps Shift+Enter as a newline and sends on Enter", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
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
    await user.click(screen.getByRole("button", { name: "Send fork reply" }));

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
    await user.click(screen.getByRole("button", { name: "Send fork reply" }));

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
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Start a new root chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

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
    expect(body.reader_context).toBeNull();
  });

  it("keeps a stable-key draft when conversation identity changes", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();

    const { rerender } = render(
      <ChatComposer conversationId={null} draftKey="new-conversation" />,
    );

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Draft during resolution");

    rerender(
      <ChatComposer conversationId="conversation-1" draftKey="new-conversation" />,
    );

    expect(message).toHaveValue("Draft during resolution");
  });

  it("resolves the conversation on send and uses the resolved id with reader_context for a new doc-chat first message", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onResolveConversation = vi.fn(async () => "resolved-id");

    render(
      <ChatComposer
        conversationId={null}
        onResolveConversation={onResolveConversation}
        readerContext={{ media_id: "media-1", library_id: null }}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("First message into the doc chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    expect(onResolveConversation).toHaveBeenCalledOnce();

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body.conversation_id).toBe("resolved-id");
    expect(body).not.toHaveProperty("singleton");
    expect(body.reader_context).toEqual({
      media_id: "media-1",
      library_id: null,
    });
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
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("This should not send");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(onResolveConversation).toHaveBeenCalledOnce();
    });
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("renders pending reference chips and removes them on click", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    const onRemovePendingReference = vi.fn();

    render(
      <ChatComposer
        conversationId="conversation-1"
        pendingReferences={[
          { uri: "media:media-1#p3", label: "On the Origin of Species" },
        ]}
        onRemovePendingReference={onRemovePendingReference}
      />,
    );

    expect(
      await screen.findByText("On the Origin of Species"),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Remove On the Origin of Species" }),
    );

    expect(onRemovePendingReference).toHaveBeenCalledWith("media:media-1#p3");
  });

  it("does not render a web-search selector or scope chip in the composer", async () => {
    installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: /web search/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/web search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^scope/i)).not.toBeInTheDocument();
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
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Web search mode" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();

    const host = screen.getByTestId("mobile-composer-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });
});
