import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConversationMemoryPanel from "@/components/chat/ConversationMemoryPanel";
import type { ConversationMemoryInspection } from "@/lib/conversations/types";

const memory: ConversationMemoryInspection = {
  state_snapshot: {
    id: "snapshot-1",
    status: "active",
    covered_through_seq: 42,
    prompt_version: "prompt-v3",
    snapshot_version: "snapshot-v1",
    memory_item_ids: ["memory-1"],
    source_refs: [
      {
        type: "message",
        id: "message-10",
        message_seq: 10,
      },
    ],
  },
  memory_items: [
    {
      id: "memory-1",
      kind: "decision",
      status: "active",
      body: "Use the context assembler as the only chat prompt path.",
      source_required: true,
      confidence: 0.91,
      valid_from_seq: 18,
      valid_through_seq: 22,
      sources: [
        {
          id: "source-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            message_seq: 18,
            deep_link: "/media/media-1#fragment-9",
            location: { page: 2 },
            result_ref: {
              title: "Prompt ledger note",
            },
          },
        },
      ],
    },
  ],
};

describe("ConversationMemoryPanel", () => {
  it("stays hidden when no active memory data is present", () => {
    render(<ConversationMemoryPanel />);

    expect(screen.queryByTestId("conversation-memory-panel")).not.toBeInTheDocument();
  });

  it("renders active snapshot coverage and memory source refs", () => {
    render(<ConversationMemoryPanel memory={memory} />);

    expect(
      screen.getByRole("region", { name: "Conversation memory" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Covered through message #42")).toBeInTheDocument();
    expect(screen.getByText(/Prompt prompt-v3/)).toBeInTheDocument();
    expect(screen.getByText("Decision")).toBeInTheDocument();
    expect(
      screen.getByText("Use the context assembler as the only chat prompt path."),
    ).toBeInTheDocument();
    expect(screen.getByText("Messages #18-#22")).toBeInTheDocument();
    expect(screen.getByText("91% confidence")).toBeInTheDocument();

    const sourceLink = screen.getByRole("link", { name: /prompt ledger note/i });
    expect(sourceLink).toHaveAttribute("href", "/media/media-1#fragment-9");
    expect(screen.getByText("Supports")).toBeInTheDocument();
    expect(screen.getByText("Message #18 - Page 2")).toBeInTheDocument();
  });

  it("does not render superseded or invalid records", () => {
    const inactiveMemory: ConversationMemoryInspection = {
      state_snapshot: {
        id: "snapshot-2",
        status: "invalid",
        covered_through_seq: 9,
        memory_item_ids: [],
        source_refs: [],
      },
      memory_items: [
        {
          id: "memory-2",
          kind: "goal",
          status: "superseded",
          body: "Old goal",
          source_required: false,
          sources: [],
        },
      ],
    };

    render(<ConversationMemoryPanel memory={inactiveMemory} />);

    expect(screen.queryByTestId("conversation-memory-panel")).not.toBeInTheDocument();
  });
});
