import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import ReaderAssistantPane from "@/components/chat/ReaderAssistantPane";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function modelsResponse(): Response {
  return jsonResponse({
    data: [
      {
        id: "model-1",
        provider: "openai",
        provider_display_name: "OpenAI",
        model_name: "test-model",
        model_display_name: "Test model",
        model_tier: "light",
        reasoning_modes: ["default", "none"],
        max_context_tokens: 128000,
        available_via: "platform",
      },
    ],
  });
}

function chatRunResponse(body: ChatRunCreateRequest) {
  return {
    data: {
      run: {
        id: "run-1",
        status: "queued",
        conversation_id: "conversation-2",
        user_message_id: "user-message-1",
        assistant_message_id: "assistant-message-1",
        model_id: body.model_id,
        reasoning: body.reasoning,
        key_mode: body.key_mode ?? "auto",
        cancel_requested_at: null,
        started_at: null,
        completed_at: null,
        error_code: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      conversation: { id: "conversation-2" },
      user_message: {
        id: "user-message-1",
        seq: 1,
        role: "user",
        message_document: {
          type: "message_document",
          version: 1,
          blocks: [{ type: "text", format: "plain", text: body.content }],
        },
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
        message_document: {
          type: "message_document",
          version: 1,
          blocks: [],
        },
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

function chatRunCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
  );
}

function ReaderRailHarness() {
  const [mode, setMode] = useState<"highlights" | "ask">("ask");
  if (mode === "highlights") {
    return (
      <section aria-label="Reader secondary rail">
        <h2>Highlights</h2>
        <p>Visible highlight list</p>
      </section>
    );
  }

  return (
    <ReaderAssistantPane
      contexts={[
        {
          kind: "object_ref",
          type: "highlight",
          id: "highlight-1",
          exact: "Rail quote",
        },
      ]}
      conversationId={null}
      targetLabel="Reader source"
      onBack={() => setMode("highlights")}
      onOpenFullChat={vi.fn()}
    />
  );
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("ReaderAssistantPane", () => {
  it("returns the reader rail to Highlights when the back action is used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (pathOf(input) === "/api/models") {
          return modelsResponse();
        }
        return jsonResponse({ data: [] });
      }),
    );

    render(<ReaderRailHarness />);

    expect(screen.getByRole("region", { name: "Reader assistant" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to highlights" }));

    expect(
      screen.queryByRole("region", { name: "Reader assistant" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Highlights" })).toBeVisible();
    expect(screen.getByText("Visible highlight list")).toBeVisible();
  });

  it("renders pending context and composer before existing history resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/models") {
          return modelsResponse();
        }
        if (path === "/api/conversations/conversation-1/messages") {
          return new Promise<Response>(() => {});
        }
        return jsonResponse({ data: [] });
      }),
    );

    render(
      <ReaderAssistantPane
        contexts={[
          {
            kind: "object_ref",
            type: "highlight",
            id: "highlight-1",
            color: "yellow",
            exact: "Visible before history loads.",
            mediaTitle: "Reader source",
          },
        ]}
        conversationId="conversation-1"
        targetLabel="Document chat"
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Reader assistant" })).toBeInTheDocument();
    expect(screen.getAllByText("Visible before history loads.")).toHaveLength(2);
    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    const input = screen.getByPlaceholderText("Ask anything...");
    expect(scrollport).not.toContainElement(input);
    expect(screen.getByTestId("chat-composer-dock")).toContainElement(input);
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: /open full chat/i })).not.toBeDisabled();
    expect(screen.getAllByText("Loading chat history...").length).toBeGreaterThan(0);
  });

  it("removes pending quote context from the pane and composer before send", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return modelsResponse();
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return jsonResponse(
          chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
        );
      }
      if (path === "/api/stream-token") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderAssistantPane
        contexts={[
          {
            kind: "object_ref",
            type: "highlight",
            id: "highlight-1",
            exact: "Remove this quote before sending.",
            mediaTitle: "Reader source",
          },
        ]}
        conversationId={null}
        targetLabel="Reader source"
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Remove this quote before sending.")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove quote context" }));

    await waitFor(() => {
      expect(screen.queryAllByText("Remove this quote before sending.")).toHaveLength(0);
    });

    await screen.findByText(/Test model/);
    const input = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(input, { target: { value: "Ask without the quote" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
    const body = JSON.parse(String(chatRunCalls(fetchMock)[0]?.[1]?.body)) as
      ChatRunCreateRequest;
    expect(body.contexts).toBeUndefined();
  });

  it("sends with conversation scope while scoped conversation resolution is pending", async () => {
    const onConversationAvailable = vi.fn();
    const onOpenFullChat = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return modelsResponse();
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return new Promise<Response>(() => {});
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return jsonResponse(
          chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
        );
      }
      if (path === "/api/stream-token") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderAssistantPane
        contexts={[
          {
            kind: "object_ref",
            type: "highlight",
            id: "highlight-1",
            exact: "Scoped quote",
          },
        ]}
        conversationId={null}
        conversationScope={{
          type: "media",
          media_id: "media-1",
          title: "Reader source",
        }}
        targetLabel="Reader source"
        onConversationAvailable={onConversationAvailable}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    const openFullChatButton = screen.getByRole("button", { name: /open full chat/i });
    expect(openFullChatButton).toBeDisabled();

    await screen.findByText(/Test model/);
    const input = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(input, { target: { value: "Explain this in context" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });

    const chatRunCall = chatRunCalls(fetchMock)[0];
    const body = JSON.parse(String(chatRunCall?.[1]?.body)) as ChatRunCreateRequest & {
      conversation_id?: string;
    };

    expect(body.conversation_id).toBeUndefined();
    expect(body.conversation_scope).toEqual({ type: "media", media_id: "media-1" });
    expect(body.contexts).toEqual([
      { kind: "object_ref", type: "highlight", id: "highlight-1" },
    ]);
    await waitFor(() => {
      expect(screen.queryAllByText("Scoped quote")).toHaveLength(0);
    });
    expect(onConversationAvailable).toHaveBeenCalledWith("conversation-2", "run-1");

    await waitFor(() => expect(openFullChatButton).not.toBeDisabled());
    fireEvent.click(openFullChatButton);
    expect(onOpenFullChat).toHaveBeenCalledWith("conversation-2?run=run-1");
  });

  it("keeps scoped sends blocked while resolved history is still loading", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return modelsResponse();
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "conversation-1",
            title: "Reader source chat",
            message_count: 2,
            scope_type: "media",
            scope_media_id: "media-1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return new Promise<Response>(() => {});
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return jsonResponse(
          chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
        );
      }
      if (path === "/api/stream-token") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderAssistantPane
        contexts={[]}
        conversationId={null}
        conversationScope={{
          type: "media",
          media_id: "media-1",
          title: "Reader source",
        }}
        targetLabel="Reader source"
        onOpenFullChat={vi.fn()}
      />,
    );

    expect((await screen.findAllByText("Loading chat history...")).length).toBeGreaterThan(0);
    const input = screen.getByPlaceholderText("Ask anything...");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Continue from the selected source" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("does not send when a resolved scoped chat has no complete assistant parent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return modelsResponse();
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "conversation-1",
            title: "Reader source chat",
            message_count: 1,
            scope_type: "media",
            scope_media_id: "media-1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({
          data: [
            {
              id: "user-existing",
              seq: 1,
              role: "user",
              message_document: {
                type: "message_document",
                version: 1,
                blocks: [
                  {
                    type: "text",
                    format: "plain",
                    text: "Existing prompt without an answer yet.",
                  },
                ],
              },
              contexts: [],
              tool_calls: [],
              status: "complete",
              error_code: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        throw new Error("Chat run should not be created for parentless scoped continuation");
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderAssistantPane
        contexts={[]}
        conversationId={null}
        conversationScope={{
          type: "media",
          media_id: "media-1",
          title: "Reader source",
        }}
        targetLabel="Reader source"
        onOpenFullChat={vi.fn()}
      />,
    );

    await screen.findByText("This scoped chat cannot be continued yet.");
    const input = screen.getByPlaceholderText("Ask anything...");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Do not send yet" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(chatRunCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps a reader draft when scoped resolution loads an existing conversation", async () => {
    let resolveConversation: (response: Response) => void = () => {};
    const conversationResolvePromise = new Promise<Response>((resolve) => {
      resolveConversation = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return modelsResponse();
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return conversationResolvePromise;
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return jsonResponse({
          data: [
            {
              id: "user-existing",
              seq: 1,
              role: "user",
              message_document: {
                type: "message_document",
                version: 1,
                blocks: [
                  { type: "text", format: "plain", text: "Earlier question" },
                ],
              },
              contexts: [],
              tool_calls: [],
              status: "complete",
              error_code: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "assistant-existing",
              seq: 2,
              role: "assistant",
              message_document: {
                type: "message_document",
                version: 1,
                blocks: [
                  {
                    type: "text",
                    format: "markdown",
                    text: "Existing answer",
                  },
                ],
              },
              contexts: [],
              tool_calls: [],
              status: "complete",
              error_code: null,
              created_at: "2026-01-01T00:00:01Z",
              updated_at: "2026-01-01T00:00:01Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return jsonResponse(
          chatRunResponse(JSON.parse(String(init.body)) as ChatRunCreateRequest),
        );
      }
      if (path === "/api/stream-token") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderAssistantPane
        contexts={[]}
        conversationId={null}
        conversationScope={{
          type: "media",
          media_id: "media-1",
          title: "Reader source",
        }}
        targetLabel="Reader source"
        onOpenFullChat={vi.fn()}
      />,
    );

    await screen.findByText(/Test model/);
    const input = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(input, { target: { value: "Draft while resolving" } });

    resolveConversation(
      jsonResponse({
        data: {
          id: "conversation-1",
          title: "Reader source chat",
          message_count: 2,
          scope_type: "media",
          scope_media_id: "media-1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    await screen.findByText("Existing answer");
    expect(input).toHaveValue("Draft while resolving");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(chatRunCalls(fetchMock)).toHaveLength(1);
    });
    const body = JSON.parse(String(chatRunCalls(fetchMock)[0]?.[1]?.body)) as
      ChatRunCreateRequest & { conversation_id?: string };
    expect(body.conversation_id).toBeUndefined();
    expect(body.parent_message_id).toBeUndefined();
    expect(body.conversation_scope).toEqual({ type: "media", media_id: "media-1" });
    expect(body.content).toBe("Draft while resolving");
  });
});
