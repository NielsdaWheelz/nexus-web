import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConversationForksPanel from "./ConversationForksPanel";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const parentFork: ForkOption = {
  id: "branch-parent",
  parent_message_id: "root-assistant",
  user_message_id: "parent-user",
  assistant_message_id: "parent-assistant",
  leaf_message_id: "parent-assistant",
  title: "Parent path",
  preview: "Follow the parent reply in full",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 4,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  active: true,
};

const childFork: ForkOption = {
  id: "branch-child",
  parent_message_id: "parent-assistant",
  user_message_id: "child-user",
  assistant_message_id: "child-assistant",
  leaf_message_id: "child-assistant",
  title: "Child path",
  preview: "Follow the child reply in full",
  branch_anchor_kind: "assistant_selection",
  branch_anchor_preview: "selected assistant passage in full",
  status: "pending",
  message_count: 2,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  active: false,
};

const siblingFork: ForkOption = {
  id: "branch-sibling",
  parent_message_id: "root-assistant",
  user_message_id: "sibling-user",
  assistant_message_id: "sibling-assistant",
  leaf_message_id: "sibling-assistant",
  title: "Sibling path",
  preview: "Follow the sibling reply in full",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 2,
  created_at: "2026-01-03T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  active: false,
};

const branchGraph: BranchGraph = {
  root_message_id: "root-assistant",
  edges: [],
  nodes: [],
};

function renderPanel(onSelectFork = vi.fn()) {
  render(
    <ConversationForksPanel
      conversationId="conversation-1"
      forkOptionsByParentId={{ "root-assistant": [parentFork, siblingFork] }}
      branchGraph={branchGraph}
      switchableLeafIds={
        new Set([
          "parent-assistant",
          "child-assistant",
          "sibling-assistant",
        ])
      }
      selectedPathMessageIds={new Set(["parent-user", "parent-assistant"])}
      onSelectFork={onSelectFork}
      onSelectGraphLeaf={vi.fn()}
    />,
  );
  return { onSelectFork };
}

async function visibleTreeItems() {
  await screen.findByRole("tree", { name: "Conversation forks" });
  await waitFor(() => {
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });
  return screen.getAllByRole("treeitem");
}

describe("ConversationForksPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { forks: [parentFork, childFork, siblingFork] } })),
    );
  });

  it("supports tree keyboard navigation, actions, and accessible delete details", async () => {
    const { onSelectFork } = renderPanel();
    let treeItems = await visibleTreeItems();

    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: "ArrowDown" });
    await waitFor(() => expect(treeItems[1]).toHaveFocus());

    fireEvent.keyDown(treeItems[1], { key: "ArrowUp" });
    await waitFor(() => expect(treeItems[0]).toHaveFocus());

    fireEvent.keyDown(treeItems[0], { key: "End" });
    await waitFor(() => expect(treeItems[2]).toHaveFocus());

    fireEvent.keyDown(treeItems[2], { key: "Home" });
    await waitFor(() => expect(treeItems[0]).toHaveFocus());

    fireEvent.keyDown(treeItems[0], { key: "ArrowLeft" });
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    });

    treeItems = screen.getAllByRole("treeitem");
    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    });

    treeItems = screen.getAllByRole("treeitem");
    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: "ArrowRight" });
    await waitFor(() => expect(treeItems[1]).toHaveFocus());

    fireEvent.keyDown(treeItems[1], { key: " " });
    expect(onSelectFork).toHaveBeenCalledWith(childFork);

    fireEvent.keyDown(treeItems[1], { key: "Enter" });
    expect(onSelectFork).toHaveBeenCalledWith(childFork);

    fireEvent.keyDown(treeItems[1], { key: "F2" });
    expect(screen.getByRole("textbox", { name: /rename fork child path/i }))
      .toBeInTheDocument();

    fireEvent.keyDown(treeItems[1], { key: "Escape" });
    expect(
      screen.queryByRole("textbox", { name: /rename fork child path/i }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(treeItems[1], { key: "Delete" });
    expect(
      screen.getByRole("group", {
        name: /confirm delete fork.*title: child path.*reply: follow the child reply in full.*quote: selected assistant passage in full.*subtree: 2 messages/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Delete this fork and 2 messages?")).toBeInTheDocument();

    fireEvent.keyDown(treeItems[1], { key: "Escape" });
    expect(
      screen.queryByRole("group", { name: /confirm delete fork.*child path/i }),
    ).not.toBeInTheDocument();
  });
});
