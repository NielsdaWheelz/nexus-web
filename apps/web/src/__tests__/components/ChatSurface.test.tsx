import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ChatScrollHandle } from "@/components/chat/useChatScroll";
import type { ConversationMessage, ForkOption } from "@/lib/conversations/types";

const baseMessage = {
  seq: 1,
  status: "complete",
  error_code: null,
  can_retry_response: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

function messageDocument(text: string, role: ConversationMessage["role"]) {
  return {
    type: "message_document" as const,
    version: 1 as const,
    blocks: text.trim()
      ? [
          {
            type: "text" as const,
            format:
              role === "assistant" ? ("markdown" as const) : ("plain" as const),
            text,
          },
        ]
      : [],
  };
}

function userMessage(id: string, seq: number, text: string): ConversationMessage {
  return { ...baseMessage, id, seq, role: "user", message_document: messageDocument(text, "user") };
}

function assistantMessage(
  id: string,
  seq: number,
  text: string,
  parentMessageId?: string,
): ConversationMessage {
  return {
    ...baseMessage,
    id,
    seq,
    role: "assistant",
    parent_message_id: parentMessageId,
    message_document: messageDocument(text, "assistant"),
  };
}

const FIXED_HEIGHT = { display: "flex", height: "240px" } as const;

// Distance, in viewport space, from the scrollport's top edge to an element's
// top edge. Measuring with getBoundingClientRect keeps the result independent of
// each row's positioned offsetParent.
function topOffsetWithin(element: HTMLElement, scrollport: HTMLElement): number {
  return (
    element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
  );
}

// A pinned question sits in the top region of the scrollport: at the top edge
// (within a few px for inset/header rounding) and well above the fold — never
// chased to the bottom.
function isPinnedNearTop(top: number, scrollport: HTMLElement): boolean {
  return top >= -4 && top < scrollport.getBoundingClientRect().height / 2;
}

describe("ChatSurface", () => {
  it("keeps the message log in the named scrollport and docks the composer outside it", () => {
    render(
      <ChatSurface
        messages={[]}
        emptyState={<p>Ask about this quote</p>}
        composer={<textarea aria-label="Message" />}
      />,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    const transcript = screen.getByRole("log", { name: "Chat messages" });
    const composer = screen.getByRole("textbox", { name: "Message" });
    const composerDock = screen.getByTestId("chat-composer-dock");

    expect(scrollport).toHaveAttribute("tabindex", "0");
    expect(scrollport).toContainElement(transcript);
    expect(scrollport).not.toContainElement(composer);
    expect(composerDock).toContainElement(composer);
    expect(transcript).toContainElement(screen.getByText("Ask about this quote"));
  });

  it("renders user and assistant messages through the shared row component", () => {
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "What does this quote mean?"),
      assistantMessage("assistant-1", 2, "It is about the tradeoff."),
    ];

    render(
      <ChatSurface messages={messages} composer={<textarea aria-label="Message" />} />,
    );

    expect(screen.getByText("What does this quote mean?")).toBeInTheDocument();
    expect(screen.getByText("It is about the tradeoff.")).toBeInTheDocument();
  });

  it("puts retry actions on user prompts for retryable assistant children", () => {
    const onRetryAssistantResponse = vi.fn();
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "Try this"),
      {
        ...assistantMessage("assistant-1", 2, "", "user-1"),
        status: "error",
        error_code: "E_INTERNAL",
        can_retry_response: true,
      },
      userMessage("user-2", 3, "Try that"),
      {
        ...assistantMessage("assistant-2", 4, "", "user-2"),
        status: "error",
        error_code: "E_CONTEXT_TOO_LARGE",
        can_retry_response: false,
      },
    ];

    render(
      <ChatSurface
        messages={messages}
        onRetryAssistantResponse={onRetryAssistantResponse}
        composer={<textarea aria-label="Message" />}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry response" }));

    expect(onRetryAssistantResponse).toHaveBeenCalledWith("assistant-1");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("renders inline fork previews and supports keyboard fork selection", () => {
    const onSelectFork = vi.fn();
    const messages: ConversationMessage[] = [
      assistantMessage("assistant-1", 1, "Choose a direction."),
    ];
    const forks: ForkOption[] = [
      {
        id: "branch-1",
        parent_message_id: "assistant-1",
        user_message_id: "user-1",
        assistant_message_id: "assistant-2",
        leaf_message_id: "assistant-2",
        title: "Current branch",
        preview: "Follow the first idea",
        branch_anchor_kind: "assistant_message",
        branch_anchor_preview: null,
        status: "complete",
        message_count: 2,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        active: true,
      },
      {
        id: "branch-2",
        parent_message_id: "assistant-1",
        user_message_id: "user-2",
        assistant_message_id: "assistant-3",
        leaf_message_id: "assistant-3",
        title: null,
        preview: "Try a different answer",
        branch_anchor_kind: "assistant_selection",
        branch_anchor_preview: "selected answer text",
        status: "pending",
        message_count: 2,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        active: false,
      },
    ];

    render(
      <ChatSurface
        messages={messages}
        forkOptionsByParentId={{ "assistant-1": forks }}
        onSelectFork={onSelectFork}
        composer={<textarea aria-label="Message" />}
      />,
    );

    const current = screen.getByRole("button", {
      name: /current fork\. title: current branch\. reply: follow the first idea/i,
    });
    fireEvent.keyDown(current, { key: "ArrowRight" });
    const next = screen.getByRole("button", {
      name: /switch to fork\. reply: try a different answer/i,
    });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "Enter" });
    expect(onSelectFork).toHaveBeenCalledWith(forks[1]);
  });

  it("lets wheel gestures over the composer scroll the message scrollport", () => {
    const messages: ConversationMessage[] = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`message-${index + 1}`, index + 1, `Question ${index + 1}`)
        : assistantMessage(
            `message-${index + 1}`,
            index + 1,
            `Overflow answer ${index + 1}: ${"chat transcript content ".repeat(8)}`,
          ),
    );

    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={messages} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    const composerDock = screen.getByTestId("chat-composer-dock");

    scrollport.scrollTop = scrollport.scrollHeight;
    const beforeWheel = scrollport.scrollTop;
    expect(beforeWheel).toBeGreaterThan(0);

    fireEvent.wheel(composerDock, { deltaY: -120 });

    expect(scrollport.scrollTop).toBeLessThan(beforeWheel);
  });

  it("pins a newly sent user message near the top inset", async () => {
    const history: ConversationMessage[] = [
      userMessage("user-1", 1, "First question"),
      assistantMessage(
        "assistant-1",
        2,
        `Long first answer ${"reading material ".repeat(40)}`,
      ),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={history} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    // First load of an existing conversation opens at the bottom.
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));

    const sent: ConversationMessage[] = [
      ...history,
      userMessage("user-2", 3, "Second question"),
      assistantMessage("assistant-2", 4, "Short", "user-2"),
    ];

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={sent} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const anchor = screen.getByText("Second question");

    // The pinned question's top sits in the top region of the scrollport (not
    // chased to the bottom).
    await waitFor(() => {
      expect(isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport)).toBe(
        true,
      );
    });
  });

  it("pins the first send after an empty ready surface instead of bottom-scrolling", async () => {
    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          historyLoading={false}
          emptyState={<p>Start a chat</p>}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    expect(screen.getByText("Start a chat")).toBeInTheDocument();

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          historyLoading={false}
          messages={[
            userMessage("first-user", 1, "First question"),
            assistantMessage(
              "first-assistant",
              2,
              `Streaming first answer ${"streamed token ".repeat(120)}`,
              "first-user",
            ),
          ]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const anchor = screen.getByText("First question");
    await waitFor(() => {
      expect(isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport)).toBe(
        true,
      );
    });
  });

  it("keeps a pinned question fixed while the assistant answer grows", async () => {
    const sent: ConversationMessage[] = [
      userMessage("user-1", 1, "Pinned streaming question"),
      assistantMessage("assistant-1", 2, "Short answer", "user-1"),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={[]} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={sent} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const anchor = screen.getByText("Pinned streaming question");
    await waitFor(() => {
      expect(isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport)).toBe(
        true,
      );
    });
    const topBefore = topOffsetWithin(anchor, scrollport);
    const scrollTopBefore = scrollport.scrollTop;

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[
            sent[0],
            assistantMessage(
              "assistant-1",
              2,
              `Grown answer ${"streamed token ".repeat(90)}`,
              "user-1",
            ),
          ]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Grown answer/)).toBeInTheDocument();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      Math.abs(topOffsetWithin(anchor, scrollport) - topBefore),
    ).toBeLessThanOrEqual(3);
    expect(Math.abs(scrollport.scrollTop - scrollTopBefore)).toBeLessThanOrEqual(
      3,
    );
  });

  it("releases the pin on a manual scroll so later growth does not re-pin", async () => {
    const sent: ConversationMessage[] = [
      userMessage("user-1", 1, "Pinned question"),
      assistantMessage("assistant-1", 2, "Tiny", "user-1"),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={[]} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={sent} composer={<textarea aria-label="Message" />} />
      </div>,
    );
    const anchor = screen.getByText("Pinned question");

    // The very first turn pins to the top region of the scrollport.
    await waitFor(() => {
      expect(isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport)).toBe(
        true,
      );
    });

    // The user scrolls away (a real gesture: wheel over the scrollport) and that
    // releases the pin. The scrollTop mutation is a direct DOM write; fireEvent
    // already wraps its dispatch in act.
    scrollport.scrollTop = 0;
    fireEvent.wheel(scrollport, { deltaY: -50 });
    fireEvent.scroll(scrollport);
    const afterManual = scrollport.scrollTop;

    // The assistant answer grows. With the pin released, scrollTop must not jump
    // back to the anchor.
    const grown: ConversationMessage[] = [
      sent[0],
      assistantMessage(
        "assistant-1",
        2,
        `Grown answer ${"streamed token ".repeat(60)}`,
        "user-1",
      ),
    ];
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={grown} composer={<textarea aria-label="Message" />} />
      </div>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollport.scrollTop).toBe(afterManual);
  });

  it("restores the eye-line across a messages swap via captureAnchor", async () => {
    const ref = createRef<ChatScrollHandle>();
    const original: ConversationMessage[] = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`u-${index}`, index + 1, `Turn ${index} question`)
        : assistantMessage(`a-${index}`, index + 1, `Turn ${index} answer text body`),
    );

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={original}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });

    // Scroll to a stable middle position and capture the eye-line of a visible row.
    act(() => {
      scrollport.scrollTop = Math.floor(scrollport.scrollHeight / 2);
    });
    const anchorEl = screen.getByText("Turn 8 question");
    const offsetBefore = topOffsetWithin(anchorEl, scrollport);

    act(() => {
      ref.current!.captureAnchor("u-8");
    });

    // Swap to a different branch that prepends a tall turn but keeps u-8 present.
    const swapped: ConversationMessage[] = [
      userMessage("prefix-1", 100, `Prepended ${"context ".repeat(30)}`),
      assistantMessage("prefix-2", 101, `Prepended answer ${"body ".repeat(30)}`),
      ...original,
    ];
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={swapped}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    await waitFor(() => {
      const restored = screen.getByText("Turn 8 question");
      const offsetAfter = topOffsetWithin(restored, scrollport);
      expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(3);
    });
  });

  it("scrolls to a message through the scoped scroll handle", async () => {
    const ref = createRef<ChatScrollHandle>();
    const messages: ConversationMessage[] = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`u-${index}`, index + 1, `Question ${index}`)
        : assistantMessage(
            `a-${index}`,
            index + 1,
            `Answer ${index}: ${"transcript body ".repeat(8)}`,
          ),
    );

    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={messages}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    act(() => {
      scrollport.scrollTop = 0;
      ref.current!.scrollToMessage("u-12");
    });

    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
  });

  it("reveals the ↓ Latest control below the fold and jumps to the newest turn on click", async () => {
    const messages: ConversationMessage[] = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`u-${index}`, index + 1, `Question ${index}`)
        : assistantMessage(
            `a-${index}`,
            index + 1,
            `Answer ${index}: ${"transcript body ".repeat(8)}`,
          ),
    );

    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface messages={messages} composer={<textarea aria-label="Message" />} />
      </div>,
    );
    const scrollport = screen.getByRole("region", { name: "Chat conversation" });

    // First load opens at the bottom: the newest turn is in view, no affordance.
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();

    // Scroll to the top: the newest turn is now below the fold → the control appears.
    act(() => {
      scrollport.scrollTop = 0;
    });
    fireEvent.scroll(scrollport);
    const latest = await screen.findByTestId("chat-scroll-latest");

    fireEvent.click(latest);
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
  });

  it("jumps Latest to the bottom when the newest assistant answer is taller than the viewport", async () => {
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "Newest tall-answer question"),
      assistantMessage(
        "assistant-1",
        2,
        `Tall answer ${"long streamed answer body ".repeat(220)}`,
        "user-1",
      ),
    ];

    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={messages}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));

    act(() => {
      scrollport.scrollTop = 0;
    });
    fireEvent.scroll(scrollport);
    const latest = await screen.findByTestId("chat-scroll-latest");

    fireEvent.click(latest);

    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
  });
});
