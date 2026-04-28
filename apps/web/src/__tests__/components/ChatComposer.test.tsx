import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer from "@/components/ChatComposer";
import type { ChatRunCreateRequest, ContextItem } from "@/lib/api/sse";

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: routerMocks.replace,
  }),
}));

const MODELS = [
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
  },
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
        key_mode: body.key_mode ?? "auto",
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
    routerMocks.replace.mockClear();
    setViewportWidth(1024);
  });

  afterEach(() => {
    document.body.style.margin = originalBodyMargin;
    setViewportWidth(originalInnerWidth);
  });

  it("changes model settings and sends the selected request payload", async () => {
    const user = userEvent.setup();
    const fetchMock = installChatComposerFetchMock();
    const onChatRunCreated = vi.fn();

    render(
      <ChatComposer
        conversationId="conversation-1"
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
    await user.click(screen.getByRole("checkbox", { name: "Use my keys only" }));

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
      content: "Explain this quote",
      model_id: "gpt-5.5",
      reasoning: "high",
      key_mode: "byok_only",
      web_search: {
        mode: "auto",
        freshness_days: null,
        allowed_domains: [],
        blocked_domains: [],
      },
    });
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "Idempotency-Key": expect.any(String),
      }),
    );
    expect(onChatRunCreated).toHaveBeenCalledOnce();
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

  it("removes attached context chips from the composer surface", async () => {
    const user = userEvent.setup();
    installChatComposerFetchMock();
    const onRemoveContext = vi.fn();
    const attachedContexts: ContextItem[] = [
      {
        type: "highlight",
        id: "highlight-1",
        color: "yellow",
        exact: "A quoted passage",
      },
      {
        type: "media",
        id: "media-1",
        preview: "Source item",
      },
    ];

    render(
      <ChatComposer
        conversationId="conversation-1"
        attachedContexts={attachedContexts}
        onRemoveContext={onRemoveContext}
      />,
    );

    expect(screen.getByText("A quoted passage")).toBeInTheDocument();
    expect(screen.getByText("Source item")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /remove context/i })[0]);

    expect(onRemoveContext).toHaveBeenCalledOnce();
    expect(onRemoveContext).toHaveBeenCalledWith(0);
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
    expect(screen.getByRole("combobox", { name: "Web search mode" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();

    const host = screen.getByTestId("mobile-composer-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });
});
