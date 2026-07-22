import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ChatComposer from "@/components/chat/ChatComposer";
import { __resetChatProfilesCacheForTests } from "@/components/chat/useChatProfiles";
import { present } from "@/lib/api/presence";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import type { ReaderSelectionPreview } from "@/lib/conversations/readerSelection";
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

// A canonical hydrated reader-quote preview: the one sendable pending kind.
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT_ID = "22222222-2222-4222-8222-222222222222";
const READER_PREVIEW: ReaderSelectionPreview = {
  key: { mediaId: MEDIA_ID, highlightId: HIGHLIGHT_ID },
  sourceLabel: "On the Origin of Species",
  exact: "endless forms most beautiful",
  prefix: "",
  suffix: "",
  locator: {
    type: "web_text_offsets",
    media_id: MEDIA_ID,
    fragment_id: "frag-1",
    start_offset: 0,
    end_offset: 27,
  },
  activation: {
    resourceRef: `media:${MEDIA_ID}`,
    kind: "route",
    href: `/media/${MEDIA_ID}`,
    unresolvedReason: null,
  },
  revision: "a".repeat(64),
};

const READER_INTENT = {
  destination: { kind: "New" as const },
  selection: READER_PREVIEW.key,
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

function idempotencyKeyOf(
  call: readonly [RequestInfo | URL, (RequestInit | undefined)?],
): string {
  return (call[1]?.headers as Record<string, string>)["Idempotency-Key"];
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
    // The draft + send attempt now persist in sessionStorage; isolate tests.
    sessionStorage.clear();
    __resetChatProfilesCacheForTests();
    document.body.style.margin = "";
    setViewportWidth(1024);
  });

  afterEach(() => {
    sessionStorage.clear();
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

  it("selects a non-default profile and sends a Reply destination", async () => {
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
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body.destination).toMatchObject({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "assistant-current",
        branch_anchor: {
          kind: "assistant_message",
          message_id: "assistant-current",
        },
      },
    });
    expect(body.content).toBe("Explain this quote");
    expect(body.profile_id).toBe("fast");
    expect(body.reasoning_option_id).toBe("default");
    // The browser owns no provider/model/reasoning/key policy — those raw fields
    // are never sent, nor any legacy flat top-level shape.
    expect(body).not.toHaveProperty("model_id");
    expect(body).not.toHaveProperty("key_mode");
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("conversation_id");
    expect(body).not.toHaveProperty("chat_subject");
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

    render(<ChatComposer conversationId="conversation-1" parentMessageId="assistant-1" />);

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

    render(<ChatComposer conversationId="conversation-1" parentMessageId="assistant-1" />);

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
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;

    expect(body.content).toBe("Take this branch");
    expect(body.destination).toMatchObject({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "assistant-parent",
        branch_anchor: branchDraft.anchor,
      },
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

    expect(body.destination).toMatchObject({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "assistant-parent",
        branch_anchor: {
          kind: "assistant_message",
          message_id: "assistant-parent",
        },
      },
    });
  });

  it("sends an Empty insertion for a parentless existing conversation", async () => {
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

    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: { kind: "Empty" },
    });
    expect(body).not.toHaveProperty("conversation_scope");
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("singleton");
    expect(body).not.toHaveProperty("chat_subject");
    expect(body.reader_selection).toEqual({ kind: "Absent" });
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

  // --------------------------------------------------------------------------
  // Pending reader-quote turn context
  // --------------------------------------------------------------------------

  it("posts destination New + reader_selection{key,revision} with the attempt key", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId={null}
        pendingContext={present<PendingTurnContext>({
          kind: "ReaderHighlight",
          preview: READER_PREVIEW,
        })}
      />,
    );

    await screen.findByRole("combobox", { name: "AI profile" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("What does this passage mean?");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const call = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(call[1]?.body)) as ChatRunCreateRequest;
    expect(body.destination).toEqual({ kind: "New" });
    expect(body.reader_selection).toEqual({
      kind: "Present",
      value: {
        key: { media_id: MEDIA_ID, highlight_id: HIGHLIGHT_ID },
        revision: READER_PREVIEW.revision,
      },
    });
    // No client-authored quote text ever rides the request.
    expect(JSON.stringify(body)).not.toContain(READER_PREVIEW.exact);
    expect(idempotencyKeyOf(call)).toEqual(expect.any(String));
  });

  it("blocks send while the pending quote is still loading", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId={null}
        pendingContext={present<PendingTurnContext>({
          kind: "Loading",
          intent: READER_INTENT,
        })}
      />,
    );

    await screen.findByRole("combobox", { name: "AI profile" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Ask about the passage");

    expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled();
    // The Enter keypath is intercepted but the send guard blocks a Loading quote.
    await user.keyboard("{Enter}");
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("blocks send for a non-sendable (forbidden) quote", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId={null}
        pendingContext={present<PendingTurnContext>({
          kind: "NonSendable",
          intent: READER_INTENT,
          reason: "Forbidden",
        })}
      />,
    );

    await screen.findByRole("combobox", { name: "AI profile" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Try to send this anyway");

    expect(screen.getByRole("button", { name: "SEND" })).toBeDisabled();
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("removes the pending quote and preserves the typed text", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    const onRemovePendingContext = vi.fn();

    render(
      <ChatComposer
        conversationId={null}
        pendingContext={present<PendingTurnContext>({
          kind: "ReaderHighlight",
          preview: READER_PREVIEW,
        })}
        onRemovePendingContext={onRemovePendingContext}
      />,
    );

    await screen.findByRole("combobox", { name: "AI profile" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Keep this text after removal");

    await user.click(screen.getByRole("button", { name: "Remove quoted passage" }));

    expect(onRemovePendingContext).toHaveBeenCalledOnce();
    expect(message).toHaveValue("Keep this text after removal");
  });

  it("locks the composer for reconciliation and replays the same key on Retry send", async () => {
    const user = userEvent.setup();
    let failNext = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        if (failNext) {
          failNext = false;
          // A network reject carries no status → ambiguous loss.
          throw new TypeError("Failed to fetch");
        }
        return jsonResponse(
          chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
        );
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
        draftKey="reconcile-1"
      />,
    );

    await screen.findByRole("combobox", { name: "AI profile" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("An ambiguous send");
    await user.click(screen.getByRole("button", { name: "SEND" }));

    // Locked reconciliation panel: text disabled, only "Retry send" offered.
    expect(
      await screen.findByRole("button", { name: "Retry send" }),
    ).toBeVisible();
    expect(screen.getByText("Send status unknown — Retry send")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "SEND" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry send" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(2);
    });
    const calls = chatRunCalls(fetchMock);
    // The replay reuses the SAME idempotency key (identity unchanged).
    expect(idempotencyKeyOf(calls[1])).toBe(idempotencyKeyOf(calls[0]));
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

    render(<ChatComposer conversationId="conversation-1" parentMessageId="assistant-1" />);

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
