import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";
import ConversationNewPaneBody from "./ConversationNewPaneBody";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function buildChatRunResponse(body: ChatRunCreateRequest) {
  const timestamp = "2026-01-01T00:00:00Z";
  return {
    data: {
      run: {
        id: "run-1",
        status: "complete",
        conversation_id: "conversation-1",
        user_message_id: "user-message-1",
        assistant_message_id: "assistant-message-1",
        model_id: body.model_id,
        reasoning: body.reasoning,
        key_mode: body.key_mode ?? "auto",
        cancel_requested_at: null,
        started_at: timestamp,
        completed_at: timestamp,
        error_code: null,
        created_at: timestamp,
        updated_at: timestamp,
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
        can_retry_response: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
      assistant_message: {
        id: "assistant-message-1",
        seq: 2,
        role: "assistant",
        content: "Done.",
        contexts: [],
        tool_calls: [],
        status: "complete",
        error_code: null,
        can_retry_response: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
    },
  };
}

const MODELS_RESPONSE = {
  data: [
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
  ],
};

describe("ConversationNewPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a general conversation without scope on first send", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse(MODELS_RESPONSE);
      }
      if (path === "/api/conversations" && init?.method === "POST") {
        return jsonResponse({ data: { id: "new-conv-id" } });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ChatRunCreateRequest;
        return jsonResponse(buildChatRunResponse(body));
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const href = "/conversations/new";
    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href={href}
        routeId="conversation-new"
        resourceRef={null}
        resourceKey={resolvePaneRouteIdentity(href).resourceKey}
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
        onOpenInNewPane={vi.fn()}
        onSetPaneTitle={vi.fn()}
      >
        <ConversationNewPaneBody />
      </PaneRuntimeProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /gpt-5 mini.*default/i }),
    ).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Plain question");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => pathOf(input) === "/api/chat-runs"),
      ).toBe(true);
    });

    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    const body = JSON.parse(
      String(chatRunCall?.[1]?.body),
    ) as ChatRunCreateRequest;

    expect(body.conversation_id).toBe("new-conv-id");
    expect(body).not.toHaveProperty("conversation_scope");
    expect(body).not.toHaveProperty("web_search");
    expect(body).not.toHaveProperty("singleton");
    expect(onReplacePane).toHaveBeenCalledWith(
      "pane-1",
      "/conversations/conversation-1?run=run-1",
      undefined,
    );
  });

});
