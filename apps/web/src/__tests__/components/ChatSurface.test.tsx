import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ConversationMessage, ForkOption } from "@/lib/conversations/types";

const baseMessage = {
  seq: 1,
  status: "complete",
  error_code: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

describe("ChatSurface", () => {
  it("keeps a named focusable scrollport with the message log before the composer", () => {
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

    expect(scrollport).toHaveAttribute("tabindex", "0");
    expect(scrollport).toContainElement(transcript);
    expect(transcript).toContainElement(screen.getByText("Ask about this quote"));
    expect(transcript.compareDocumentPosition(composer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders user and assistant messages through the shared row component", () => {
    const messages: ConversationMessage[] = [
      {
        ...baseMessage,
        id: "user-1",
        role: "user",
        content: "What does this quote mean?",
      },
      {
        ...baseMessage,
        id: "assistant-1",
        seq: 2,
        role: "assistant",
        content: "It is about the tradeoff.",
      },
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

  it("renders inline fork previews at the assistant branch point", () => {
    const onSelectFork = vi.fn();
    const messages: ConversationMessage[] = [
      {
        ...baseMessage,
        id: "assistant-1",
        role: "assistant",
        content: "Choose a direction.",
      },
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
    expect(current).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(current, { key: "ArrowRight" });
    const next = screen.getByRole("button", {
      name: /switch to fork\. reply: try a different answer/i,
    });
    expect(next).toHaveFocus();

    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(current).toHaveFocus();

    fireEvent.keyDown(current, { key: "End" });
    expect(next).toHaveFocus();

    fireEvent.keyDown(next, { key: "Home" });
    expect(current).toHaveFocus();

    fireEvent.keyDown(current, { key: " " });
    expect(onSelectFork).toHaveBeenCalledWith(forks[0]);

    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(next).toHaveFocus();

    fireEvent.keyDown(next, { key: "Enter" });

    expect(onSelectFork).toHaveBeenCalledWith(forks[1]);
  });

  it("forwards the scrollport ref and scroll events to the scroll owner", () => {
    const scrollportRef = createRef<HTMLDivElement>();
    const scrollEvents: EventTarget[] = [];

    render(
      <ChatSurface
        messages={[]}
        scrollportRef={scrollportRef}
        onScroll={(event) => scrollEvents.push(event.currentTarget)}
        composer={<textarea aria-label="Message" />}
      />,
    );

    const scrollport = screen.getByRole("region", { name: "Chat conversation" });

    expect(scrollportRef.current).toBe(scrollport);

    fireEvent.scroll(scrollport);

    expect(scrollEvents).toEqual([scrollport]);
  });
});
