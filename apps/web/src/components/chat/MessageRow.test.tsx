import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageRow } from "./MessageRow";
import type { WebCitationChipData } from "@/lib/chat/citations";
import type { ConversationMessage } from "@/lib/conversations/types";

const baseMessage = {
  id: "assistant-1",
  seq: 1,
  role: "assistant",
  content: "Current answer.",
  status: "complete",
  error_code: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

describe("MessageRow", () => {
  it("renders web citation chips as external links", () => {
    const message: ConversationMessage & { citations: WebCitationChipData[] } = {
      ...baseMessage,
      citations: [
        {
          result_ref: "web:1",
          title: "Example result",
          url: "https://example.com/story",
          display_url: "example.com",
          source_name: "Example",
          snippet: "A relevant web excerpt.",
        },
      ],
    };

    render(<MessageRow message={message} />);

    const link = screen.getByRole("link", { name: /example result/i });
    expect(link).toHaveAttribute("href", "https://example.com/story");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Example")).toBeInTheDocument();
  });

  it("labels active web-search tool activity", () => {
    const message: ConversationMessage = {
      ...baseMessage,
      status: "pending",
      tool_calls: [
        {
          assistant_message_id: "assistant-1",
          tool_name: "web_search",
          tool_call_index: 0,
          status: "started",
          retrievals: [],
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Searching web")).toBeInTheDocument();
  });
});
