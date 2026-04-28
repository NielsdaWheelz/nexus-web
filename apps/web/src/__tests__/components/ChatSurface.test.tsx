import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ConversationMessage } from "@/lib/conversations/types";

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
