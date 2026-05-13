import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import type { ForkOption } from "@/lib/conversations/types";

const fork: ForkOption = {
  id: "branch-1",
  parent_message_id: "assistant-1",
  user_message_id: "user-1",
  assistant_message_id: "assistant-2",
  leaf_message_id: "assistant-2",
  title: "Mobile fork",
  preview: "Open this branch",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  active: false,
};

describe("ChatContextDrawer", () => {
  it("shows the same forks panel in the mobile drawer and closes after selection", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { forks: [fork] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const onSelectFork = vi.fn();

    render(
      <ChatContextDrawer
        conversationId="conversation-1"
        contexts={[]}
        forkOptionsByParentId={{ "assistant-1": [fork] }}
        selectedPathMessageIds={new Set()}
        onSelectFork={onSelectFork}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Linked context" }));
    fireEvent.click(screen.getByRole("tab", { name: /forks 1/i }));
    fireEvent.click(screen.getByRole("button", { name: /switch to fork mobile fork/i }));

    expect(onSelectFork).toHaveBeenCalledWith(fork);
    expect(screen.queryByRole("dialog", { name: "Linked context" })).not.toBeInTheDocument();
  });
});
