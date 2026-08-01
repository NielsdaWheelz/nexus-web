import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ChatComposerComponent from "@/components/chat/ChatComposer";
import { __resetChatProfilesCacheForTests } from "@/components/chat/useChatProfiles";
import { present } from "@/lib/api/presence";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import type { ChatRunResponse } from "@/lib/conversations/types";
import type { InheritedChatProfileSelection } from "@/lib/conversations/chatProfileSelection";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import type { ReaderSelectionPreview } from "@/lib/conversations/readerSelection";
import type { BranchDraft } from "@/lib/conversations/types";

function ChatComposer({
  inheritedProfileSelection = null,
  ...props
}: Omit<
  ComponentProps<typeof ChatComposerComponent>,
  "sendCapability" | "inheritedProfileSelection"
> & {
  inheritedProfileSelection?: InheritedChatProfileSelection | null;
}) {
  return (
    <ChatComposerComponent
      {...props}
      inheritedProfileSelection={inheritedProfileSelection}
      sendCapability={{ kind: "Available" }}
    />
  );
}

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
      privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
    },
    {
      id: "fast",
      label: "Fast",
      description: "Low-latency profile",
      provider_label: "Nexus AI",
      model_label: "Haiku",
      reasoning_options: [{ id: "default", label: "Default" }],
      default_reasoning_option_id: "default",
      privacy: {
        kind: "ExceptionalRetention",
        notice: "Retained for 30 days.",
      },
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

function chatRunResponse(body: ChatRunCreateRequest): ChatRunResponse {
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
        support_id: { kind: "Absent" },
        publication_warning: { kind: "Absent" },
        failure: null,
        execution: { kind: "Present", value: { phase: "Queued" } },
        cancel_requested_at: null,
        started_at: null,
        completed_at: null,
        error_code: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      conversation: {
        id: "conversation-1",
        title: "Test conversation",
        sharing: "private",
        message_count: 2,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
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
    },
  };
}

function installChatComposerFetchMock() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse({ data: LLM_PROFILES });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return jsonResponse(
          chatRunResponse(
            JSON.parse(String(init.body)) as ChatRunCreateRequest,
          ),
        );
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    },
  );

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatRunCalls(
  fetchMock: ReturnType<typeof installChatComposerFetchMock>,
) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      pathOf(input) === "/api/chat-runs" && init?.method === "POST",
  );
}

function idempotencyKeyOf(
  call: readonly [RequestInfo | URL, (RequestInit | undefined)?],
): string {
  return (call[1]?.headers as Record<string, string>)["Idempotency-Key"];
}

describe("ChatComposer", () => {
  beforeEach(async () => {
    // The draft + send attempt now persist in sessionStorage; isolate tests.
    sessionStorage.clear();
    __resetChatProfilesCacheForTests();
    document.body.style.margin = "";
    await page.viewport(1024, 768);
  });

  afterEach(async () => {
    sessionStorage.clear();
    document.body.style.margin = originalBodyMargin;
    await page.viewport(1024, 768);
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
      await screen.findAllByRole("combobox", { name: "Model" }),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => pathOf(input) === "/api/llm-profiles",
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it("keeps the draft operable while the profile catalog loads and after it becomes ready", async () => {
    const user = userEvent.setup();
    let releaseProfiles: () => void = () => {};
    const profilesGate = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          await profilesGate;
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          return jsonResponse(
            chatRunResponse(
              JSON.parse(String(init.body)) as ChatRunCreateRequest,
            ),
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatComposer conversationId="conversation-1" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading profiles…");
    expect(
      screen.queryByRole("combobox", { name: "Model" }),
    ).not.toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    expect(message).toBeEnabled();
    await user.click(message);
    await user.keyboard("Draft while the catalog loads");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    releaseProfiles();
    expect(
      await screen.findByRole("combobox", { name: "Model" }),
    ).toBeVisible();
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
  });

  it("keeps a failed profile catalog quiet, editable, and unsendable", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/llm-profiles") {
        return jsonResponse(
          { error: { code: "E_UPSTREAM", message: "Catalog unavailable" } },
          503,
        );
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<ChatComposer conversationId="conversation-1" />);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Models unavailable",
      );
    });
    expect(
      screen.queryByRole("combobox", { name: "Model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Effort" }),
    ).not.toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    expect(message).toBeEnabled();
    await user.click(message);
    await user.keyboard("Keep this draft editable");
    expect(message).toHaveValue("Keep this draft editable");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("shows the causal inherited profile and reasoning selection", async () => {
    installChatComposerFetchMock();
    const inheritedProfileSelection: InheritedChatProfileSelection = {
      selection: { profileId: "fast", reasoningOptionId: "default" },
      assistantMessageId: "assistant-parent",
      runId: "run-parent",
    };

    render(
      <ChatComposer
        conversationId="conversation-1"
        inheritedProfileSelection={inheritedProfileSelection}
      />,
    );

    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
      "fast",
    );
  });

  it("replaces an unavailable inherited selection with the current default and explains it quietly", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const inheritedProfileSelection: InheritedChatProfileSelection = {
      selection: {
        profileId: "retired-profile",
        reasoningOptionId: "retired-high",
      },
      assistantMessageId: "assistant-parent",
      runId: "run-parent",
    };

    render(
      <ChatComposer
        conversationId="conversation-1"
        inheritedProfileSelection={inheritedProfileSelection}
      />,
    );

    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
      "balanced",
    );
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveValue(
      "default",
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "The previous chat profile is no longer available. Using Balanced.",
    );
    expect(status).not.toHaveTextContent("retired-profile");
    expect(status).not.toHaveTextContent(/cache|provider/i);

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Continue with the current profile");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.profile_id).toBe("balanced");
    expect(body.reasoning_option_id).toBe("default");
  });

  it("keeps an explicit draft selection through remount and resumes inheritance after send", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const inheritedProfileSelection: InheritedChatProfileSelection = {
      selection: { profileId: "fast", reasoningOptionId: "default" },
      assistantMessageId: "assistant-parent",
      runId: "run-parent",
    };
    const props = {
      conversationId: "conversation-1",
      draftKey: "explicit-profile-draft",
      inheritedProfileSelection,
    };

    const { unmount: unmountFirst } = render(<ChatComposer {...props} />);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Model" }),
      "balanced",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Effort" }),
      "high",
    );
    unmountFirst();

    const { unmount: unmountSecond } = render(<ChatComposer {...props} />);
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
      "balanced",
    );
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveValue(
      "high",
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Send the explicit choice");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.profile_id).toBe("balanced");
    expect(body.reasoning_option_id).toBe("high");

    unmountSecond();
    render(<ChatComposer {...props} />);
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
      "fast",
    );
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
      name: "Model",
    });
    await user.selectOptions(profilePicker, "fast");
    expect(
      screen.queryByRole("combobox", { name: "Effort" }),
    ).not.toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Explain this quote");
    await user.click(screen.getByRole("button", { name: "Send message" }));

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
    await waitFor(() => {
      expect(onChatRunCreated).toHaveBeenCalledOnce();
    });
  });

  it("selects a reasoning option on the default profile and sends it", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Effort" }),
      "high",
    );

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Think hard about this");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const [, init] = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(init?.body)) as ChatRunCreateRequest;
    expect(body.profile_id).toBe("balanced");
    expect(body.reasoning_option_id).toBe("high");
  });

  it("keeps desktop Shift+Enter as a newline and sends exactly once on Enter", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "Model" }),
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

  it.each([
    ["Ctrl+Enter", "{Control>}{Enter}{/Control}"],
    ["Cmd+Enter", "{Meta>}{Enter}{/Meta}"],
  ])("sends exactly once on desktop %s", async (_name, shortcut) => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard(`Send with ${_name}`);
    await user.keyboard(shortcut);

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
    const [, init] = chatRunCalls(fetchMock)[0];
    expect(
      (JSON.parse(String(init?.body)) as ChatRunCreateRequest).content,
    ).toBe(`Send with ${_name}`);
  });

  it("leaves composing and key-code 229 Enter events to the IME", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Composed message");

    fireEvent.compositionStart(message);
    expect(fireEvent.keyDown(message, { key: "Enter" })).toBe(true);
    fireEvent.compositionEnd(message);
    expect(
      fireEvent.keyDown(message, { key: "Enter", isComposing: true }),
    ).toBe(true);
    expect(fireEvent.keyDown(message, { key: "Enter", keyCode: 229 })).toBe(
      true,
    );

    expect(chatRunCalls(fetchMock)).toHaveLength(0);
    expect(message).toHaveValue("Composed message");
    expect(message).toHaveFocus();
  });

  it("keeps every Enter variant as a newline in the product mobile viewport", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    await page.viewport(320, 720);

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await user.click(message);
    await user.keyboard("Plain{Enter}Shift{Shift>}{Enter}{/Shift}Ctrl");
    await user.keyboard("{Control>}{Enter}{/Control}Cmd");
    await user.keyboard("{Meta>}{Enter}{/Meta}Alt");
    await user.keyboard("{Alt>}{Enter}{/Alt}Done");

    expect(message).toHaveValue("Plain\nShift\nCtrl\nCmd\nAlt\nDone");

    await user.clear(message);
    await user.keyboard("Left selection Right");
    message.setSelectionRange(5, 14);
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(message).toHaveValue("Left \n Right");
    expect(message).toHaveFocus();
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
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
    expect(
      screen.getByText("The complete assistant answer."),
    ).toBeInTheDocument();
    expect(screen.getByText("assistant answer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel branch reply" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Jump to parent message" }),
    );
    expect(onJumpToBranchParent).toHaveBeenCalledWith("assistant-parent");

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Take this branch");
    await user.click(screen.getByRole("button", { name: "Send message" }));

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
    await user.click(screen.getByRole("button", { name: "Send message" }));

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
      await screen.findByRole("combobox", { name: "Model" }),
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
      await screen.findByRole("combobox", { name: "Model" }),
    ).toBeInTheDocument();
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Draft during resolution");

    rerender(
      <ChatComposer
        conversationId="conversation-1"
        draftKey="new-conversation"
      />,
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

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("What does this passage mean?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

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

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Ask about the passage");

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    // The Enter keypath is intercepted but the send guard blocks a Loading quote.
    await user.keyboard("{Enter}");
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
    expect(message).toHaveValue("Ask about the passage");
    expect(message).toHaveFocus();
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

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Try to send this anyway");

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
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

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Keep this text after removal");

    await user.click(
      screen.getByRole("button", { name: "Remove quoted passage" }),
    );

    expect(onRemovePendingContext).toHaveBeenCalledOnce();
    expect(message).toHaveValue("Keep this text after removal");
  });

  it("replays the exact profile pair and key after reload and a default change", async () => {
    const user = userEvent.setup();
    let failNext = true;
    let changedCatalog = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          return jsonResponse({
            data: changedCatalog
              ? { ...LLM_PROFILES, default_profile_id: "fast" }
              : LLM_PROFILES,
          });
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          if (failNext) {
            failNext = false;
            // A network reject carries no status → ambiguous loss.
            throw new TypeError("Failed to fetch");
          }
          return jsonResponse(
            chatRunResponse(
              JSON.parse(String(init.body)) as ChatRunCreateRequest,
            ),
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
        draftKey="reconcile-1"
      />,
    );

    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(
      "balanced",
    );
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("An ambiguous send");
    const sendBounds = screen
      .getByRole("button", { name: "Send message" })
      .getBoundingClientRect();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // Locked reconciliation panel: text disabled, only "Retry send" offered.
    const retryButton = await screen.findByRole("button", {
      name: "Retry send",
    });
    expect(retryButton).toBeVisible();
    expect(retryButton).toHaveTextContent("");
    expect(retryButton.getBoundingClientRect().width).toBe(sendBounds.width);
    expect(retryButton.getBoundingClientRect().height).toBe(sendBounds.height);
    expect(screen.getByText("Send status unknown. Retry send.")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Ask anything" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    unmount();
    changedCatalog = true;
    __resetChatProfilesCacheForTests();
    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
        draftKey="reconcile-1"
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Retry send" }),
    ).toBeVisible();
    expect(
      await screen.findByText("Original chat profile locked for retry."),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Model" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry send" }));

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(2);
    });
    const calls = chatRunCalls(fetchMock);
    // The replay reuses the SAME idempotency key (identity unchanged).
    expect(idempotencyKeyOf(calls[1])).toBe(idempotencyKeyOf(calls[0]));
    const firstBody = JSON.parse(
      String(calls[0][1]?.body),
    ) as ChatRunCreateRequest;
    const replayBody = JSON.parse(
      String(calls[1][1]?.body),
    ) as ChatRunCreateRequest;
    expect(replayBody).toEqual(firstBody);
    expect(firstBody.profile_id).toBe("balanced");
    expect(firstBody.reasoning_option_id).toBe("default");
  });

  it("keeps one Send message socket while projecting Sending message in flight", async () => {
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
            chatRunResponse(
              JSON.parse(String(init.body)) as ChatRunCreateRequest,
            ),
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      render(
        <ChatComposer
          conversationId="conversation-1"
          parentMessageId="assistant-1"
        />,
      );

      const sendButton = await screen.findByRole("button", {
        name: "Send message",
      });
      expect(sendButton).toHaveTextContent("");

      const message = screen.getByRole("textbox", { name: "Ask anything" });
      const focusSpy = vi.spyOn(message, "focus");
      await user.click(message);
      await user.keyboard("Hold the line while it sends");
      const idleBounds = sendButton.getBoundingClientRect();
      await user.click(sendButton);

      const sendingButton = await screen.findByRole("button", {
        name: "Sending message",
      });
      expect(sendingButton).toHaveAttribute("aria-busy", "true");
      expect(sendingButton).toBeDisabled();
      expect(sendingButton).toHaveTextContent("");
      expect(sendingButton.getBoundingClientRect().width).toBe(idleBounds.width);
      expect(sendingButton.getBoundingClientRect().height).toBe(
        idleBounds.height,
      );
      expect(
        getComputedStyle(sendingButton).transitionDuration.split(", "),
      ).toEqual(["0s", "0s", "0s"]);
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the loading spinner is decorative and intentionally has no accessible query; its computed animation duration is the reduced-motion contract.
      const spinner = sendingButton.querySelector('span[aria-hidden="true"]');
      expect(spinner).not.toBeNull();
      expect(getComputedStyle(spinner!).animationDuration).toBe("0s");
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
      expect(chatRunCalls(fetchMock)).toHaveLength(1);

      releaseRun();
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeInTheDocument();
        expect(message).toHaveFocus();
        expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      });
    } finally {
      releaseRun();
      await session.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "no-preference" },
        ],
      });
    }
  });

  it("preserves the draft and restores textarea focus after a known failed send", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: LLM_PROFILES });
        }
        if (path === "/api/chat-runs" && init?.method === "POST") {
          return jsonResponse(
            {
              error: {
                code: "E_CONVERSATION_NO_LONGER_EMPTY",
                message: "The conversation already has messages.",
              },
            },
            409,
          );
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatComposer
        conversationId="conversation-1"
        parentMessageId="assistant-1"
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Keep this known-failed draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This chat already has messages — send again to continue it.",
    );
    await waitFor(() => {
      expect(message).toHaveFocus();
    });
    expect(message).toHaveValue("Keep this known-failed draft");
    expect(chatRunCalls(fetchMock)).toHaveLength(1);
  });

  it("projects the shell focus-within ring when the textarea is focused", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the visual shell has no semantic role; its computed focus-within shadow is the contract under test.
    const shell = message.parentElement;
    if (!shell) throw new Error("Chat textarea requires its composer shell.");
    const restingShadow = getComputedStyle(shell).boxShadow;

    await user.click(message);

    expect(message).toHaveFocus();
    await waitFor(() => {
      const focusedShadow = getComputedStyle(shell).boxShadow;
      expect(focusedShadow).not.toBe("none");
      expect(focusedShadow).not.toBe(restingShadow);
    });
  });

  it("does not render a web-search selector or scope chip in the composer", async () => {
    installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("combobox", { name: "Model" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: /web search/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/web search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^scope/i)).not.toBeInTheDocument();
  });

  it("omits privacy chrome for every profile", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();

    render(<ChatComposer conversationId="conversation-1" />);

    expect(
      await screen.findByRole("combobox", { name: "Model" }),
    ).toBeVisible();
    expect(screen.queryByText("Privacy")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Processed by Nexus AI."),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model" }),
      "fast",
    );
    expect(screen.queryByText("Retained for 30 days.")).not.toBeInTheDocument();
    expect(screen.queryByText("Privacy")).not.toBeInTheDocument();
  });

  it("projects stable Stop response and Stopping response actions while keeping the draft editable", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    let releaseCancel: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const onCancelRun = vi.fn(async () => cancelGate);

    render(
      <ChatComposerComponent
        conversationId="conversation-1"
        inheritedProfileSelection={null}
        sendCapability={{ kind: "AssistantRunning" }}
        activeRunId="run-1"
        onCancelRun={onCancelRun}
      />,
    );

    await screen.findByRole("combobox", { name: "Model" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Keep writing");

    expect(message).toHaveValue("Keep writing");
    expect(message).toBeEnabled();
    const stopButton = screen.getByRole("button", { name: "Stop response" });
    expect(stopButton).toBeVisible();
    expect(stopButton).toHaveTextContent("");
    const stopBounds = stopButton.getBoundingClientRect();

    await user.click(stopButton);
    const stoppingButton = await screen.findByRole("button", {
      name: "Stopping response",
    });
    expect(stoppingButton).toHaveAttribute("aria-busy", "true");
    expect(stoppingButton).toBeDisabled();
    expect(stoppingButton).toHaveTextContent("");
    expect(stoppingButton.getBoundingClientRect().width).toBe(stopBounds.width);
    expect(stoppingButton.getBoundingClientRect().height).toBe(
      stopBounds.height,
    );
    expect(onCancelRun).toHaveBeenCalledOnce();

    releaseCancel();
    await screen.findByRole("button", { name: "Stop response" });
    expect(
      screen.queryByText(/wait for the assistant/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the two-line input and compact controls contained at 320px", async () => {
    await page.viewport(320, 720);
    const verboseModelLabel =
      "Exceptionally deliberate cross-provider research synthesis model";
    const verboseCatalog = {
      ...LLM_PROFILES,
      profiles: [
        {
          ...LLM_PROFILES.profiles[0],
          label: verboseModelLabel,
        },
        LLM_PROFILES.profiles[1],
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/llm-profiles") {
          return jsonResponse({ data: verboseCatalog });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );
    document.body.style.margin = "0";

    render(
      <div
        data-testid="mobile-composer-host"
        style={{ width: "320px", maxWidth: "320px" }}
      >
        <ChatComposer conversationId="conversation-1" />
      </div>,
    );

    const model = await screen.findByRole("combobox", { name: "Model" });
    const effort = screen.getByRole("combobox", { name: "Effort" });
    const message = screen.getByRole("textbox", { name: "Ask anything" });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(model).toHaveDisplayValue(verboseModelLabel);
    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);
    expect(message.getBoundingClientRect().height).toBeGreaterThanOrEqual(45);
    for (const control of [model, effort, send]) {
      expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(36);
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
    }
    expect(
      screen.queryByRole("combobox", { name: "Web search mode" }),
    ).not.toBeInTheDocument();

    const host = screen.getByTestId("mobile-composer-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });
});
