import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { ChatRunCreateRequest } from "@/lib/api/sse";
import ConversationNewPaneBody from "./ConversationNewPaneBody";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

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

describe("ConversationNewPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends conversation_scope while scoped resolution is still pending", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    let resolveScopedConversation: (response: Response) => void = () => {
      throw new Error("Scoped conversation resolver was not installed");
    };
    const scopedConversationResponse = new Promise<Response>((resolve) => {
      resolveScopedConversation = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse({
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
        });
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return scopedConversationResponse;
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ChatRunCreateRequest;
        const timestamp = "2026-01-01T00:00:00Z";
        return jsonResponse({
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
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href={`/conversations/new?scope=media%3A${MEDIA_ID}`}
        routeId="conversation-new"
        resourceRef={null}
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
    expect(screen.getByText("Loading scoped chat...")).toBeInTheDocument();

    const message = screen.getByRole("textbox", { name: "Ask anything" });
    await user.click(message);
    await user.keyboard("Send without waiting");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => pathOf(input) === "/api/chat-runs")).toBe(
        true,
      );
    });

    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    const body = JSON.parse(String(chatRunCall?.[1]?.body)) as ChatRunCreateRequest & {
      conversation_id?: string;
    };

    expect(body.conversation_id).toBeUndefined();
    expect(body.conversation_scope).toEqual({ type: "media", media_id: MEDIA_ID });
    expect(onReplacePane).toHaveBeenCalledWith(
      "pane-1",
      "/conversations/conversation-1?run=run-1",
    );

    resolveScopedConversation(
      jsonResponse({
        data: {
          id: "scoped-conversation",
          message_count: 1,
        },
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => pathOf(input) === "/api/conversations/scoped-conversation/messages",
      ),
    ).toBe(false);
  });

  it("sends EPUB source actions as EPUB reader-selection context", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    const locator = {
      type: "epub_fragment_offsets",
      media_id: MEDIA_ID,
      section_id: "section-1",
      fragment_id: "fragment-1",
      start_offset: 4,
      end_offset: 24,
      text_quote_selector: { exact: "Call me Ishmael" },
    } as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse({
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
        });
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return jsonResponse({
          data: { id: "scoped-conversation", message_count: 2 },
        });
      }
      if (path === "/api/conversations/scoped-conversation/messages") {
        return jsonResponse({
          data: [
            {
              id: "root-user",
              seq: 1,
              role: "user",
              content: "Start",
              contexts: [],
              tool_calls: [],
              status: "complete",
              error_code: null,
              can_retry_response: false,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "assistant-epub",
              seq: 2,
              role: "assistant",
              content: "EPUB answer.",
              parent_message_id: "root-user",
              contexts: [],
              tool_calls: [],
              message_document: {
                type: "message_document",
                version: 1,
                blocks: [
                  { type: "text", format: "markdown", text: "EPUB answer." },
                  {
                    type: "retrieval_result",
                    id: "retrieval-1",
                    tool_call_id: "tool-1",
                    ordinal: 0,
                    result_type: "content_chunk",
                    source_id: "chunk-1",
                    media_id: MEDIA_ID,
                    evidence_span_id: "span-1",
                    context_ref: {
                      type: "content_chunk",
                      id: "chunk-1",
                      evidence_span_ids: ["span-1"],
                    },
                    result_ref: {
                      type: "content_chunk",
                      id: "chunk-1",
                      result_type: "content_chunk",
                      source_id: "chunk-1",
                      title: "Moby-Dick",
                      source_label: "Chapter 1",
                      snippet: "Call me Ishmael",
                      deep_link: `/media/${MEDIA_ID}?fragment=fragment-1`,
                      citation_label: "Chapter 1",
                      context_ref: {
                        type: "content_chunk",
                        id: "chunk-1",
                        evidence_span_ids: ["span-1"],
                      },
                      evidence_span_ids: ["span-1"],
                      source_version: "epub-source:v1",
                      locator,
                      media_id: MEDIA_ID,
                      media_kind: "epub",
                      score: 0.92,
                      selected: true,
                      source_kind: "epub",
                    },
                    deep_link: `/media/${MEDIA_ID}?fragment=fragment-1`,
                    locator,
                    score: 0.92,
                    selected: true,
                    exact_snippet: "Call me Ishmael",
                    retrieval_status: "included_in_prompt",
                    included_in_prompt: true,
                    source_version: "epub-source:v1",
                  },
                ],
              },
              status: "complete",
              error_code: null,
              can_retry_response: false,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as ChatRunCreateRequest;
        const timestamp = "2026-01-01T00:00:00Z";
        return jsonResponse({
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
              seq: 3,
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
              seq: 4,
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
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href={`/conversations/new?scope=media%3A${MEDIA_ID}`}
        routeId="conversation-new"
        resourceRef={null}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
        onOpenInNewPane={vi.fn()}
        onSetPaneTitle={vi.fn()}
      >
        <ConversationNewPaneBody />
      </PaneRuntimeProvider>,
    );

    expect(await screen.findByText("EPUB answer.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Ask about this" }));
    await user.click(screen.getByRole("textbox", { name: "Ask anything" }));
    await user.keyboard("Use this EPUB source");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            pathOf(input) === "/api/chat-runs" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    const body = JSON.parse(String(chatRunCall?.[1]?.body)) as ChatRunCreateRequest;
    expect(body.contexts?.[0]).toMatchObject({
      kind: "reader_selection",
      media_id: MEDIA_ID,
      media_kind: "epub",
      media_title: "Moby-Dick",
      exact: "Call me Ishmael",
      source_version: "epub-source:v1",
      locator,
    });
    expect(body.conversation_scope).toEqual({ type: "media", media_id: MEDIA_ID });
    expect(onReplacePane).toHaveBeenCalledWith(
      "pane-1",
      "/conversations/conversation-1?run=run-1",
    );
  });

  it("does not send when an existing scoped chat has no complete assistant parent", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse({
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
        });
      }
      if (path === "/api/conversations/resolve" && init?.method === "POST") {
        return jsonResponse({ data: { id: "scoped-conversation", message_count: 1 } });
      }
      if (path === "/api/conversations/scoped-conversation/messages") {
        return jsonResponse({
          data: [
            {
              id: "user-only",
              seq: 1,
              role: "user",
              content: "Pending question",
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
      <PaneRuntimeProvider
        paneId="pane-1"
        href={`/conversations/new?scope=media%3A${MEDIA_ID}`}
        routeId="conversation-new"
        resourceRef={null}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneTitle={vi.fn()}
      >
        <ConversationNewPaneBody />
      </PaneRuntimeProvider>,
    );

    await screen.findByText("Scoped chat cannot be continued yet.");
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    expect(input).toBeEnabled();
    await user.type(input, "Do not send without a complete assistant parent");
    await user.keyboard("{Enter}");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => pathOf(input) === "/api/chat-runs" && init?.method === "POST",
      ),
    ).toBe(false);
  });
});
