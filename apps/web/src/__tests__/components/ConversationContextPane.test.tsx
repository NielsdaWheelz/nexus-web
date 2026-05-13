import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConversationContextPane from "@/components/ConversationContextPane";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";

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

const fork: ForkOption = {
  id: "branch-1",
  parent_message_id: "assistant-1",
  user_message_id: "user-1",
  assistant_message_id: "assistant-2",
  leaf_message_id: "assistant-2",
  title: "Named fork",
  preview: "Follow this idea",
  branch_anchor_kind: "assistant_message",
  branch_anchor_preview: null,
  status: "complete",
  message_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  active: true,
};

const searchedFork: ForkOption = {
  ...fork,
  id: "branch-2",
  user_message_id: "user-2",
  assistant_message_id: "assistant-3",
  leaf_message_id: "assistant-3",
  title: "Quote branch",
  preview: "Branch from selected text",
  branch_anchor_kind: "assistant_selection",
  branch_anchor_preview: "selected assistant quote",
  active: false,
};

const branchGraph: BranchGraph = {
  root_message_id: "assistant-1",
  edges: [{ from: "assistant-1", to: "assistant-3" }],
  nodes: [
    {
      id: "assistant-1",
      message_id: "assistant-1",
      parent_message_id: null,
      leaf_message_id: "assistant-2",
      role: "assistant",
      depth: 0,
      row: 0,
      title: "Root",
      preview: "Root answer",
      branch_anchor_preview: null,
      status: "complete",
      message_count: 1,
      child_count: 2,
      active_path: true,
      leaf: false,
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "assistant-3",
      message_id: "assistant-3",
      parent_message_id: "user-2",
      leaf_message_id: "assistant-3",
      role: "assistant",
      depth: 1,
      row: 1,
      title: "Quote branch",
      preview: "Branch from selected text",
      branch_anchor_preview: "selected assistant quote",
      status: "complete",
      message_count: 3,
      child_count: 0,
      active_path: false,
      leaf: true,
      created_at: "2026-01-02T00:00:00Z",
    },
  ],
};

describe("ConversationContextPane", () => {
  it("toggles to forks and supports search, rename, delete, and path selection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/conversations/conversation-1/forks" && !init?.method) {
        return jsonResponse({ data: { forks: [fork, searchedFork] } });
      }
      if (
        path === "/api/conversations/conversation-1/forks/branch-2" &&
        init?.method === "PATCH"
      ) {
        return jsonResponse({ data: { ...searchedFork, title: "Quote renamed branch" } });
      }
      if (
        path === "/api/conversations/conversation-1/forks/branch-2" &&
        init?.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSelectFork = vi.fn();

    render(
      <ConversationContextPane
        conversationId="conversation-1"
        contexts={[]}
        forkOptionsByParentId={{ "assistant-1": [fork] }}
        selectedPathMessageIds={new Set(["user-1", "assistant-2"])}
        onSelectFork={onSelectFork}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /forks 1/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /switch to fork named fork/i }),
    );

    expect(onSelectFork).toHaveBeenCalledWith(fork);

    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(2));
    const treeItems = screen.getAllByRole("treeitem");
    fireEvent.keyDown(treeItems[0], { key: "ArrowDown" });
    await waitFor(() => expect(treeItems[1]).toHaveFocus());
    fireEvent.keyDown(treeItems[1], { key: "Enter" });
    expect(onSelectFork).toHaveBeenCalledWith(searchedFork);

    fireEvent.keyDown(treeItems[1], { key: "F2" });
    expect(screen.getByRole("textbox", { name: /rename fork quote branch/i }))
      .toBeInTheDocument();
    fireEvent.keyDown(treeItems[1], { key: "Escape" });

    const searchInput = screen.getByRole("textbox", { name: "Search forks" });
    fireEvent.change(searchInput, {
      target: { value: "quote" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Quote branch")).toBeInTheDocument();
    expect(screen.getByText("selected assistant quote")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /rename fork quote branch/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /rename fork quote branch/i }), {
      target: { value: "Quote renamed branch" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save fork quote branch/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/conversations/conversation-1/forks/branch-2",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ title: "Quote renamed branch" }),
        }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /switch to fork quote renamed branch/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /delete fork quote renamed branch/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/conversations/conversation-1/forks/branch-2",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(screen.queryByText("Quote renamed branch")).not.toBeInTheDocument();
  });

  it("switches graph leaves with the same selection callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { forks: [fork, searchedFork] } })),
    );
    const onSelectGraphLeaf = vi.fn();

    render(
      <ConversationContextPane
        conversationId="conversation-1"
        contexts={[]}
        forkOptionsByParentId={{ "assistant-1": [fork, searchedFork] }}
        branchGraph={branchGraph}
        switchableLeafIds={new Set(["assistant-3"])}
        selectedPathMessageIds={new Set(["assistant-1"])}
        onSelectFork={vi.fn()}
        onSelectGraphLeaf={onSelectGraphLeaf}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /forks 2/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /switch to graph leaf.*quote branch/i,
      }),
    );

    expect(onSelectGraphLeaf).toHaveBeenCalledWith("assistant-3");
    expect(screen.getByText("2 forks found")).toBeInTheDocument();
  });
});
