import { describe, expect, it, vi } from "vitest";
import { createRef, useRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ChatSurface from "@/components/chat/ChatSurface";
import {
  prepareConversationFindUnits,
  resolveConversationFindRanges,
} from "@/components/chat/conversationFindDom";
import type { ChatScrollHandle } from "@/components/chat/useChatScroll";
import { useConversationPaneFind } from "@/components/chat/useConversationPaneFind";
import {
  createConversationFindSnapshot,
  matchConversationFindUnits,
} from "@/lib/conversations/conversationFind";
import type {
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import {
  CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
  CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME,
} from "@/lib/reader/canonicalTextFindHighlights";

const baseMessage = {
  seq: 1,
  status: "complete",
  can_rerun: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

function messageDocument(text: string, role: ConversationMessage["role"]) {
  return {
    type: "message_document" as const,
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

function userMessage(
  id: string,
  seq: number,
  text: string,
): ConversationMessage {
  return {
    ...baseMessage,
    id,
    seq,
    role: "user",
    message_document: messageDocument(text, "user"),
    trust_trail: null,
  };
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
    trust_trail: {
      schema_version: "assistant_trust_trail.v1",
      assistant_message_id: id,
      conversation_id: "conversation-1",
      chat_run_id: null,
      status: "complete",
      run: null,
      prompt: null,
      tool_calls: [],
      citations: [],
      context_refs_added: [],
      integrity_notices: [],
      created_at: baseMessage.created_at,
      updated_at: baseMessage.updated_at,
    },
  };
}

const FIXED_HEIGHT = { display: "flex", height: "240px" } as const;

function ConversationFindHarness({
  messages,
  query = "needle",
}: {
  readonly messages: ConversationMessage[];
  readonly query?: string;
}) {
  const scrollRef = useRef<ChatScrollHandle | null>(null);
  const find = useConversationPaneFind({
    conversationId: "conversation-1",
    activeLeafMessageId: messages.at(-1)?.id ?? null,
    messages,
    scrollRef,
  });
  return (
    <div style={FIXED_HEIGHT}>
      <ChatSurface ref={scrollRef} messages={messages} composer={null} />
      <button type="button" onClick={() => find.onQueryChange(query)}>
        Start Find
      </button>
      <button type="button" onClick={() => find.onStep("Next")}>
        Next match
      </button>
      <button type="button" onClick={find.onDismiss}>
        Close Find
      </button>
      <button
        type="button"
        disabled={find.returnToReadingPosition.kind === "Unavailable"}
        onClick={() => {
          if (find.returnToReadingPosition.kind === "Available") {
            find.returnToReadingPosition.onReturn();
          }
        }}
      >
        Go back to reading position
      </button>
      <output aria-label="Find status">{find.result.kind}</output>
      <output aria-label="Find failure">
        {find.result.kind === "Failed" ? find.result.message : ""}
      </output>
      <output aria-label="Return status">
        {find.returnToReadingPosition.kind}
      </output>
    </div>
  );
}

// Distance, in viewport space, from the scrollport's top edge to an element's
// top edge. Measuring with getBoundingClientRect keeps the result independent of
// each row's positioned offsetParent.
function topOffsetWithin(
  element: HTMLElement,
  scrollport: HTMLElement,
): number {
  return (
    element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
  );
}

function visibleTextRange(root: Node, text: string): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let joined = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push(textNode);
    joined += textNode.data;
  }
  const start = joined.indexOf(text);
  if (start < 0) {
    throw new Error(`Could not find visible text: ${text}`);
  }
  const end = start + text.length;
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.length;
    if (!startNode && start < nextOffset) {
      startNode = node;
      startOffset = start - offset;
    }
    if (end <= nextOffset) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset = nextOffset;
  }
  if (!startNode || !endNode) {
    throw new Error(`Could not map visible text: ${text}`);
  }
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function manualAnimationFrames() {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const flushOne = async () => {
    const callback = callbacks.shift();
    if (!callback) throw new Error("No animation frame is pending.");
    await act(async () => {
      callback(performance.now());
      await Promise.resolve();
    });
  };
  return {
    get pending() {
      return callbacks.length;
    },
    flushOne,
    async flushAll() {
      while (callbacks.length > 0) {
        await flushOne();
      }
    },
  };
}

function highlightRanges(name: string): readonly AbstractRange[] {
  const highlight = CSS.highlights.get(name);
  return highlight ? Array.from(highlight) : [];
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

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    const transcript = screen.getByRole("log", { name: "Chat messages" });
    const composer = screen.getByRole("textbox", { name: "Message" });
    const composerDock = screen.getByTestId("chat-composer-dock");

    expect(scrollport).toHaveAttribute("tabindex", "0");
    expect(scrollport).toContainElement(transcript);
    expect(scrollport).not.toContainElement(composer);
    expect(composerDock).toContainElement(composer);
    expect(transcript).toContainElement(
      screen.getByText("Ask about this quote"),
    );
  });

  it("renders user and assistant messages through the shared row component", () => {
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "What does this quote mean?"),
      assistantMessage("assistant-1", 2, "It is about the tradeoff."),
    ];

    render(
      <ChatSurface
        messages={messages}
        composer={<textarea aria-label="Message" />}
      />,
    );

    expect(screen.getByText("What does this quote mean?")).toBeInTheDocument();
    expect(screen.getByText("It is about the tradeoff.")).toBeInTheDocument();
  });

  it("renders a Run again action only on rerunnable failed assistant turns", () => {
    const onRerunAssistantResponse = vi.fn();
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "Try this"),
      {
        ...assistantMessage("assistant-1", 2, "", "user-1"),
        status: "error",
        can_rerun: true,
      },
      userMessage("user-2", 3, "Try that"),
      {
        ...assistantMessage("assistant-2", 4, "", "user-2"),
        status: "error",
        can_rerun: false,
      },
    ];

    render(
      <ChatSurface
        messages={messages}
        onRerunAssistantResponse={onRerunAssistantResponse}
        composer={<textarea aria-label="Message" />}
      />,
    );

    // Both failed turns render exactly one failure card (role=alert)…
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    // …but only the rerunnable one offers a single Run again action.
    const rerunButtons = screen.getAllByRole("button", { name: "Run again" });
    expect(rerunButtons).toHaveLength(1);
    fireEvent.click(rerunButtons[0]);
    expect(onRerunAssistantResponse).toHaveBeenCalledWith("assistant-1");
  });

  it("renders a single Reconnect card (never Run again) for a connection-lost turn", () => {
    const onReconnectAssistant = vi.fn();
    const messages: ConversationMessage[] = [
      userMessage("user-1", 1, "Try this"),
      {
        ...assistantMessage("assistant-1", 2, "partial answer", "user-1"),
        status: "pending",
      },
    ];

    render(
      <ChatSurface
        messages={messages}
        connectionLostAssistantIds={new Set(["assistant-1"])}
        onReconnectAssistant={onReconnectAssistant}
        composer={<textarea aria-label="Message" />}
      />,
    );

    // Partial text survives the connection loss.
    expect(screen.getByText("partial answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnectAssistant).toHaveBeenCalledWith("assistant-1");
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
    const messages: ConversationMessage[] = Array.from(
      { length: 30 },
      (_, index) =>
        index % 2 === 0
          ? userMessage(
              `message-${index + 1}`,
              index + 1,
              `Question ${index + 1}`,
            )
          : assistantMessage(
              `message-${index + 1}`,
              index + 1,
              `Overflow answer ${index + 1}: ${"chat transcript content ".repeat(8)}`,
            ),
    );

    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={messages}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
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
        <ChatSurface
          messages={history}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    // First load of an existing conversation opens at the bottom.
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));

    const sent: ConversationMessage[] = [
      ...history,
      userMessage("user-2", 3, "Second question"),
      assistantMessage("assistant-2", 4, "Short", "user-2"),
    ];

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={sent}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const anchor = screen.getByText("Second question");

    // The pinned question's top sits in the top region of the scrollport (not
    // chased to the bottom).
    await waitFor(() => {
      expect(
        isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport),
      ).toBe(true);
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

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
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
              "First answer",
              "first-user",
            ),
          ]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );

    const anchor = screen.getByText("First question");
    await waitFor(() => {
      expect(
        isPinnedNearTop(topOffsetWithin(anchor, scrollport), scrollport),
      ).toBe(true);
    });
  });

  it("follows the newest streamed text once the answer overflows the viewport", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Streaming question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });

    // A short answer keeps the question pinned at the top inset.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn("Short answer")}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const question = screen.getByText("Streaming question");
    await waitFor(() => {
      expect(
        isPinnedNearTop(topOffsetWithin(question, scrollport), scrollport),
      ).toBe(true);
    });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();

    // The answer streams past the viewport: the transcript follows the newest
    // text at the bottom edge with no manual action, and ↓ Latest is not shown.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Long answer ${"streamed token ".repeat(160)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();
  });

  it("stops following on a user scroll-up and does not snap back as the answer grows", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Tall streaming question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });

    // A tall answer overflows the viewport, so the transcript follows the bottom.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(140)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // The user scrolls up well past the near-bottom band: following stops and the
    // ↓ Latest affordance appears.
    act(() => {
      scrollport.scrollTop = 0;
    });
    fireEvent.wheel(scrollport, { deltaY: -50 });
    fireEvent.scroll(scrollport);
    const afterManual = scrollport.scrollTop;
    expect(await screen.findByTestId("chat-scroll-latest")).toBeInTheDocument();

    // The answer grows further; the released viewport stays exactly where the
    // user left it.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(220)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Math.abs(scrollport.scrollTop - afterManual)).toBeLessThanOrEqual(1);
  });

  it("re-engages following when the user returns to the near-bottom band", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];

    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(140)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // Scroll up to read: following releases and ↓ Latest appears.
    act(() => {
      scrollport.scrollTop = 0;
    });
    fireEvent.scroll(scrollport);
    expect(await screen.findByTestId("chat-scroll-latest")).toBeInTheDocument();

    // Return to within the near-bottom band, then the answer grows: following
    // re-engages, snaps to the new bottom, and ↓ Latest hides.
    act(() => {
      scrollport.scrollTop =
        scrollport.scrollHeight - scrollport.clientHeight - 40;
    });
    fireEvent.scroll(scrollport);
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(220)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();
  });

  it("keeps following when a gesture at the bottom does not move the viewport", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];
    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(140)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // A wheel/keydown at the bottom that the browser cannot act on fires no scroll
    // event, so onScroll never runs — the gesture must NOT drop the active follow.
    fireEvent.wheel(scrollport, { deltaY: 60 });
    fireEvent.keyDown(scrollport, { key: "ArrowDown" });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();

    // Following is intact: the next streamed growth still snaps to the new bottom.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(240)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();
  });

  it("does not snap the question back to the top when a following answer transiently shrinks", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];
    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });

    // The answer overflows → the transcript follows the bottom.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(160)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // A transient shrink that still overflows keeps following the bottom: the
    // top→bottom handoff is one-way for the turn; the question never re-pins to top.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(90)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
    const question = screen.getByText("Question");
    expect(
      isPinnedNearTop(topOffsetWithin(question, scrollport), scrollport),
    ).toBe(false);
  });

  it("re-engages following when ↓ Latest is clicked mid-stream", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "Question"),
      assistantMessage("assistant-1", 2, answer, "user-1"),
    ];
    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={[]}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(160)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // Scroll up to read: following releases and ↓ Latest appears.
    act(() => {
      scrollport.scrollTop = 0;
    });
    fireEvent.scroll(scrollport);
    const latest = await screen.findByTestId("chat-scroll-latest");

    // Clicking ↓ Latest on an overflowing turn lands in bottom-follow...
    fireEvent.click(latest);
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });

    // ...and following is live again: the next streamed growth snaps to the bottom.
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          messages={turn(`Answer ${"streamed token ".repeat(240)}`)}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
    expect(screen.queryByTestId("chat-scroll-latest")).toBeNull();
  });

  // AC-8 is verified by the S3 device pass / e2e: a component test cannot resize
  // the visual viewport, so the keyboard-shrink → bottom-follow path is not unit-
  // testable here. The hook re-pins from its ResizeObserver when the scrollport
  // shrinks (Android/`interactive-widget`; the iOS mobile sheet via useKeyboardInset).
  it.todo(
    "AC-8: bottom-follow keeps the newest text above the on-screen keyboard when the visual viewport shrinks",
  );

  it("restores the eye-line across a messages swap via captureAnchor", async () => {
    const ref = createRef<ChatScrollHandle>();
    const original: ConversationMessage[] = Array.from(
      { length: 16 },
      (_, index) =>
        index % 2 === 0
          ? userMessage(`u-${index}`, index + 1, `Turn ${index} question`)
          : assistantMessage(
              `a-${index}`,
              index + 1,
              `Turn ${index} answer text body`,
            ),
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

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });

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
      assistantMessage(
        "prefix-2",
        101,
        `Prepended answer ${"body ".repeat(30)}`,
      ),
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
    const messages: ConversationMessage[] = Array.from(
      { length: 20 },
      (_, index) =>
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

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    act(() => {
      scrollport.scrollTop = 0;
      ref.current!.scrollToMessage("u-12");
    });

    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
  });

  it("reveals the ↓ Latest control below the fold and jumps to the newest turn on click", async () => {
    const messages: ConversationMessage[] = Array.from(
      { length: 24 },
      (_, index) =>
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
          messages={messages}
          composer={<textarea aria-label="Message" />}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });

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

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
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

  it("reveals exact fenced-code ranges horizontally before revealing them in the transcript", async () => {
    const ref = createRef<ChatScrollHandle>();
    const messages = [
      assistantMessage(
        "assistant-1",
        1,
        `\`\`\`ts\nconst x = "needle";\n\`\`\``,
      ),
    ];
    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface ref={ref} messages={messages} composer={null} />
      </div>,
    );

    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    const codeScroll = await screen.findByTestId("markdown-code-scroll");
    const snapshot = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "assistant-1",
      messages,
      sourceRevision: 1,
    });
    const units = prepareConversationFindUnits({
      snapshot,
      transcript: ref.current!.getTranscriptElement()!,
    });
    const matches = matchConversationFindUnits({
      snapshot,
      units,
      query: "const x",
      matchCase: false,
      wholeWord: false,
    });
    if (matches.kind !== "Ready") {
      throw new Error("Expected a fenced-code match.");
    }
    const ranges = resolveConversationFindRanges({
      units,
      occurrence: matches.occurrences[0]!,
    });
    expect(ranges.map((range) => range.toString())).toEqual(["const", " x"]);
    ranges.forEach((range, index) => {
      vi.spyOn(range, "getBoundingClientRect").mockReturnValue(
        index === ranges.length - 1
          ? new DOMRect(520, 420, 80, 18)
          : new DOMRect(200, 420, 40, 18),
      );
    });
    vi.spyOn(codeScroll, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 120, 240, 100),
    );
    vi.spyOn(scrollport, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 20, 600, 240),
    );

    const revealOrder: string[] = [];
    let scrollLeft = 0;
    Object.defineProperty(codeScroll, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        revealOrder.push("inner");
        scrollLeft = value;
      },
    });
    vi.spyOn(scrollport, "scrollTo").mockImplementation(((
      options: ScrollToOptions | number,
      y?: number,
    ) => {
      revealOrder.push("outer");
      scrollport.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
    }) as typeof scrollport.scrollTo);

    let settlement: Awaited<
      ReturnType<ChatScrollHandle["previewFindOccurrence"]>
    > | null = null;
    await act(async () => {
      settlement = await ref.current!.previewFindOccurrence({
        messageId: "assistant-1",
        ranges,
        signal: new AbortController().signal,
      });
    });

    expect(settlement).toEqual({ kind: "Revealed" });
    expect(scrollLeft).toBe(260);
    expect(revealOrder).toEqual(["inner", "outer"]);
    expect(
      screen.getByRole("group", { name: "Assistant response" }),
    ).toHaveAttribute("data-find-active", "true");
  });

  it("generation-fences a stale preview across the full double animation frame", async () => {
    const ref = createRef<ChatScrollHandle>();
    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={[
            userMessage("user-1", 1, "first needle"),
            userMessage("user-2", 2, "second needle"),
          ]}
          composer={null}
        />
      </div>,
    );
    const [firstTarget, secondTarget] = screen.getAllByRole("group", {
      name: "Your message",
    });
    const firstRange = visibleTextRange(firstTarget, "needle");
    const secondRange = visibleTextRange(secondTarget, "needle");
    const frames = manualAnimationFrames();

    const firstPreview = ref.current!.previewFindOccurrence({
      messageId: "user-1",
      ranges: [firstRange],
      signal: new AbortController().signal,
    });
    expect(frames.pending).toBe(1);
    await frames.flushOne();
    expect(frames.pending).toBe(1);
    expect(firstTarget).not.toHaveAttribute("data-find-active");

    const secondPreview = ref.current!.previewFindOccurrence({
      messageId: "user-2",
      ranges: [secondRange],
      signal: new AbortController().signal,
    });
    await frames.flushAll();

    await expect(firstPreview).resolves.toEqual({ kind: "Cancelled" });
    await expect(secondPreview).resolves.toEqual({ kind: "Revealed" });
    expect(firstTarget).not.toHaveAttribute("data-find-active");
    expect(secondTarget).toHaveAttribute("data-find-active", "true");
  });

  it("lets genuine user input cancel a queued Find reveal", async () => {
    const ref = createRef<ChatScrollHandle>();
    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={[userMessage("user-1", 1, "needle")]}
          composer={null}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    const target = screen.getByRole("group", { name: "Your message" });
    const range = visibleTextRange(target, "needle");
    const scrollTo = vi.spyOn(scrollport, "scrollTo");
    const frames = manualAnimationFrames();

    const preview = ref.current!.previewFindOccurrence({
      messageId: "user-1",
      ranges: [range],
      signal: new AbortController().signal,
    });
    await frames.flushOne();
    fireEvent.touchMove(scrollport);
    await frames.flushAll();

    await expect(preview).resolves.toEqual({ kind: "Cancelled" });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(target).not.toHaveAttribute("data-find-active");
  });

  it("publishes all and active Conversation ranges, steps, and clears them on Close", async () => {
    render(
      <ConversationFindHarness
        messages={[
          userMessage("user-1", 1, "first needle"),
          assistantMessage("assistant-1", 2, "second needle", "user-1"),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Find" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Return status")).toHaveTextContent(
        "Available",
      ),
    );
    expect(
      highlightRanges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME),
    ).toHaveLength(2);
    const firstActive = highlightRanges(
      CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
    );
    expect(firstActive).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() =>
      expect(
        highlightRanges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)[0],
      ).not.toBe(firstActive[0]),
    );
    expect(
      highlightRanges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close Find" }));
    await waitFor(() => {
      expect(CSS.highlights.has(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toBe(
        false,
      );
      expect(
        CSS.highlights.has(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME),
      ).toBe(false);
    });
  });

  it("reports OriginUnavailable when the eye-line is wholly in the trailing spacer", async () => {
    render(
      <ConversationFindHarness
        messages={[userMessage("user-1", 1, "needle")]}
      />,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    const messageRow = screen.getByRole("group", { name: "Your message" });
    Object.defineProperties(scrollport, {
      scrollTop: {
        configurable: true,
        get: () => 500,
        set: () => {},
      },
      clientHeight: { configurable: true, get: () => 240 },
    });
    Object.defineProperties(messageRow, {
      offsetTop: { configurable: true, get: () => 0 },
      offsetHeight: { configurable: true, get: () => 80 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Find" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Find status")).toHaveTextContent("Failed"),
    );
    expect(screen.getByLabelText("Find failure")).toHaveTextContent(
      "Your reading position could not be captured.",
    );
    expect(screen.getByLabelText("Return status")).toHaveTextContent(
      "Unavailable",
    );
    expect(messageRow).not.toHaveAttribute("data-find-active");
    expect(CSS.highlights.has(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toBe(
      false,
    );
    expect(CSS.highlights.has(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toBe(
      false,
    );
  });

  it("holds streaming follow under a preview lease and Close leaves the revealed position released", async () => {
    const ref = createRef<ChatScrollHandle>();
    const turn = (answer: string): ConversationMessage[] => [
      userMessage("user-1", 1, "needle question"),
      {
        ...assistantMessage("assistant-1", 2, answer, "user-1"),
        status: "pending",
      },
    ];
    const { rerender } = render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={turn(`Answer ${"streamed token ".repeat(140)}`)}
          composer={null}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    const target = screen.getByRole("group", { name: "Your message" });
    const range = visibleTextRange(target, "needle");
    vi.spyOn(scrollport, "scrollTo").mockImplementation(((
      options: ScrollToOptions | number,
      y?: number,
    ) => {
      scrollport.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
    }) as typeof scrollport.scrollTo);
    const frames = manualAnimationFrames();
    const firstPreview = ref.current!.previewFindOccurrence({
      messageId: "user-1",
      ranges: [range],
      signal: new AbortController().signal,
    });
    const latestAbort = new AbortController();
    const latestPreview = ref.current!.previewFindOccurrence({
      messageId: "user-1",
      ranges: [range],
      signal: latestAbort.signal,
    });
    const leasedScrollTop = scrollport.scrollTop;

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={turn(`Answer ${"streamed token ".repeat(220)}`)}
          composer={null}
        />
      </div>,
    );
    expect(scrollport.scrollTop).toBe(leasedScrollTop);

    latestAbort.abort();
    await frames.flushAll();
    await expect(firstPreview).resolves.toEqual({ kind: "Cancelled" });
    await expect(latestPreview).resolves.toEqual({ kind: "Cancelled" });

    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={turn(`Answer ${"streamed token ".repeat(260)}`)}
          composer={null}
        />
      </div>,
    );
    await waitFor(() =>
      expect(scrollport.scrollTop).toBeGreaterThan(leasedScrollTop),
    );

    const revealed = ref.current!.previewFindOccurrence({
      messageId: "user-1",
      ranges: [range],
      signal: new AbortController().signal,
    });
    await frames.flushAll();
    await expect(revealed).resolves.toEqual({ kind: "Revealed" });
    expect(target).toHaveAttribute("data-find-active", "true");
    const revealedScrollTop = scrollport.scrollTop;

    act(() => {
      ref.current!.clearFindPresentation();
    });
    expect(target).not.toHaveAttribute("data-find-active");
    rerender(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={turn(`Answer ${"streamed token ".repeat(300)}`)}
          composer={null}
        />
      </div>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      Math.abs(scrollport.scrollTop - revealedScrollTop),
    ).toBeLessThanOrEqual(1);
  });

  it("retains one bottom-pinned origin across previews and Return restores it once", async () => {
    const turn = (answer: string): ConversationMessage[] => [
      assistantMessage(
        "assistant-1",
        1,
        `first needle ${"early context ".repeat(40)}`,
      ),
      assistantMessage(
        "assistant-2",
        2,
        `${"middle context ".repeat(70)}second needle`,
      ),
      userMessage("user-3", 3, "Streaming question"),
      {
        ...assistantMessage("assistant-4", 4, answer, "user-3"),
        status: "pending",
      },
    ];
    const initial = turn(`Answer ${"streamed token ".repeat(140)}`);
    const { rerender } = render(<ConversationFindHarness messages={initial} />);
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    const originScrollTop = scrollport.scrollTop;
    const assistantTargets = screen.getAllByRole("group", {
      name: "Assistant response",
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Find" }));
    await waitFor(() =>
      expect(assistantTargets[0]).toHaveAttribute("data-find-active", "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() =>
      expect(assistantTargets[1]).toHaveAttribute("data-find-active", "true"),
    );
    expect(screen.getByLabelText("Return status")).toHaveTextContent(
      "Available",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Go back to reading position" }),
    );
    await waitFor(() => {
      expect(
        Math.abs(scrollport.scrollTop - originScrollTop),
      ).toBeLessThanOrEqual(2);
      expect(screen.getByLabelText("Return status")).toHaveTextContent(
        "Unavailable",
      );
    });
    for (const target of assistantTargets) {
      expect(target).not.toHaveAttribute("data-find-active");
    }

    rerender(
      <ConversationFindHarness
        messages={turn(`Answer ${"streamed token ".repeat(240)}`)}
      />,
    );
    await waitFor(() => {
      const bottom = scrollport.scrollHeight - scrollport.clientHeight;
      expect(scrollport.scrollTop).toBeGreaterThanOrEqual(bottom - 4);
    });
  });

  it("restores the eye-line while skipping a disconnected reading focus target", async () => {
    const ref = createRef<ChatScrollHandle>();
    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={[
            assistantMessage(
              "assistant-1",
              1,
              `[Reading target](https://example.com) ${"body ".repeat(180)}`,
            ),
          ]}
          composer={null}
        />
      </div>,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    const focusTarget = screen.getByRole("link", { name: "Reading target" });
    focusTarget.focus();
    const originScrollTop = scrollport.scrollTop;
    const position = ref.current!.captureReadingPosition();
    expect(position).not.toBeNull();
    const focus = vi.spyOn(focusTarget, "focus");
    focusTarget.replaceWith(focusTarget.cloneNode(true));
    focus.mockClear();
    vi.spyOn(scrollport, "scrollTo").mockImplementation(((
      options: ScrollToOptions | number,
      y?: number,
    ) => {
      scrollport.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
    }) as typeof scrollport.scrollTo);
    act(() => {
      scrollport.scrollTop = 0;
      ref.current!.restoreReadingPosition(position!);
    });

    await waitFor(() =>
      expect(
        Math.abs(scrollport.scrollTop - originScrollTop),
      ).toBeLessThanOrEqual(2),
    );
    expect(focusTarget.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("defects on missing same-source preview ranges and message anchors", async () => {
    const ref = createRef<ChatScrollHandle>();
    render(
      <div style={FIXED_HEIGHT}>
        <ChatSurface
          ref={ref}
          messages={[userMessage("user-1", 1, "needle")]}
          composer={null}
        />
      </div>,
    );
    const target = screen.getByRole("group", { name: "Your message" });
    const range = visibleTextRange(target, "needle");

    await expect(
      ref.current!.previewFindOccurrence({
        messageId: "missing-message",
        ranges: [range],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Conversation Find message anchor is unavailable.");
    await expect(
      ref.current!.previewFindOccurrence({
        messageId: "user-1",
        ranges: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Conversation Find ranges are unavailable.");
    expect(() =>
      ref.current!.restoreReadingPosition({
        anchorMessageId: "missing-message",
        anchorOffsetTop: 0,
        focusTarget: null,
        pinMode: "released",
      }),
    ).toThrow("Conversation Find return anchor is unavailable.");
  });

  it("rejects an invisible Markdown-syntax match without moving the transcript", async () => {
    render(
      <ConversationFindHarness
        query="hidden.example"
        messages={[
          assistantMessage(
            "assistant-1",
            1,
            `${"body ".repeat(100)}[Visible](https://hidden.example/path)`,
          ),
        ]}
      />,
    );
    const scrollport = screen.getByRole("region", {
      name: "Chat conversation",
    });
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));
    const initialScrollTop = scrollport.scrollTop;

    fireEvent.click(screen.getByRole("button", { name: "Start Find" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Find status")).toHaveTextContent(
        "NoMatches",
      ),
    );

    expect(
      screen.getByRole("group", { name: "Assistant response" }),
    ).not.toHaveAttribute("data-find-active");
    expect(scrollport.scrollTop).toBe(initialScrollTop);
  });
});
