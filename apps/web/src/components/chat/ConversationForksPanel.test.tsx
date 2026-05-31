import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConversationForksPanel from "./ConversationForksPanel";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input), "http://localhost");
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

const graphWithLeaves: BranchGraph = {
  root_message_id: "root-assistant",
  edges: [{ from: "parent-assistant", to: "sibling-assistant" }],
  nodes: [
    {
      id: "parent-assistant",
      message_id: "parent-assistant",
      parent_message_id: "root-assistant",
      leaf_message_id: "parent-assistant",
      role: "assistant",
      depth: 0,
      row: 0,
      title: "Parent path",
      preview: "Follow the parent reply in full",
      branch_anchor_preview: null,
      status: "complete",
      message_count: 4,
      child_count: 1,
      active_path: true,
      leaf: true,
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "sibling-assistant",
      message_id: "sibling-assistant",
      parent_message_id: "root-assistant",
      leaf_message_id: "sibling-assistant",
      role: "assistant",
      depth: 1,
      row: 1,
      title: "Sibling path",
      preview: "Follow the sibling reply in full",
      branch_anchor_preview: null,
      status: "complete",
      message_count: 2,
      child_count: 0,
      active_path: false,
      leaf: true,
      created_at: "2026-01-03T00:00:00Z",
    },
  ],
};

type SelectFork = (fork: ForkOption) => void;
type ForksChanged = () => void;
type SelectGraphLeaf = (leafMessageId: string) => void;

function renderPanel(
  onSelectFork: SelectFork = vi.fn<SelectFork>(),
  onForksChanged: ForksChanged = vi.fn<ForksChanged>(),
  options: {
    branchGraph?: BranchGraph;
    selectedPathMessageIds?: Set<string>;
    onSelectGraphLeaf?: SelectGraphLeaf;
  } = {},
) {
  const onSelectGraphLeaf =
    options.onSelectGraphLeaf ?? vi.fn<SelectGraphLeaf>();
  render(
    <ConversationForksPanel
      conversationId="conversation-1"
      forkOptionsByParentId={{ "root-assistant": [parentFork, siblingFork] }}
      branchGraph={options.branchGraph ?? branchGraph}
      switchableLeafIds={
        new Set([
          "parent-assistant",
          "child-assistant",
          "sibling-assistant",
        ])
      }
      selectedPathMessageIds={
        options.selectedPathMessageIds ??
        new Set(["parent-user", "parent-assistant"])
      }
      onSelectFork={onSelectFork}
      onSelectGraphLeaf={onSelectGraphLeaf}
      onForksChanged={onForksChanged}
    />,
  );
  return { onSelectFork, onForksChanged, onSelectGraphLeaf };
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

  it("reloads the full tree when a submitted search is cleared", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return jsonResponse({
          data: {
            forks: url.includes("search=child")
              ? [childFork]
              : [parentFork, childFork, siblingFork],
          },
        });
      }),
    );

    renderPanel();
    await visibleTreeItems();

    const searchInput = screen.getByRole("textbox", { name: "Search forks" });
    fireEvent.change(searchInput, { target: { value: "child" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    });

    fireEvent.change(searchInput, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    });
  });

  it("aborts superseded fork searches and ignores late results", async () => {
    let resolveChildSearch: (response: Response) => void = () => undefined;
    const childSearchPromise = new Promise<Response>((resolve) => {
      resolveChildSearch = resolve;
    });
    let childSearchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.searchParams.get("search") === "child") {
          childSearchSignal = init?.signal ?? undefined;
          return childSearchPromise;
        }
        return jsonResponse({
          data: { forks: [parentFork, childFork, siblingFork] },
        });
      }),
    );

    renderPanel();
    await visibleTreeItems();

    const searchInput = screen.getByRole("textbox", { name: "Search forks" });
    fireEvent.change(searchInput, { target: { value: "child" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(childSearchSignal).toBeDefined());

    fireEvent.change(searchInput, { target: { value: "" } });
    await waitFor(() => expect(childSearchSignal?.aborted).toBe(true));
    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    });

    await act(async () => {
      resolveChildSearch(jsonResponse({ data: { forks: [childFork] } }));
    });

    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("saves a renamed fork and refreshes fork state", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (method === "PATCH" && path.endsWith("/forks/branch-child")) {
          return jsonResponse({ data: { ...childFork, title: "Renamed child" } });
        }
        return jsonResponse({
          data: { forks: [parentFork, childFork, siblingFork] },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onForksChanged = vi.fn();

    renderPanel(vi.fn(), onForksChanged);
    await visibleTreeItems();

    fireEvent.click(
      screen.getByRole("button", { name: "Rename fork Child path" }),
    );
    const input = screen.getByRole("textbox", {
      name: /rename fork child path/i,
    });
    fireEvent.change(input, { target: { value: "Renamed child" } });
    fireEvent.click(screen.getByRole("button", { name: "Save fork Child path" }));

    expect(await screen.findByText("Renamed child")).toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input).endsWith("/forks/branch-child") && init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      title: "Renamed child",
    });
    expect(onForksChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps rename editing open and shows an error when PATCH fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (init?.method === "PATCH" && path.endsWith("/forks/branch-child")) {
          return jsonResponse(
            { error: { code: "E_INTERNAL", message: "Rename failed" } },
            500,
          );
        }
        return jsonResponse({
          data: { forks: [parentFork, childFork, siblingFork] },
        });
      }),
    );

    renderPanel();
    await visibleTreeItems();

    fireEvent.click(
      screen.getByRole("button", { name: "Rename fork Child path" }),
    );
    const input = screen.getByRole("textbox", {
      name: /rename fork child path/i,
    });
    fireEvent.change(input, { target: { value: "Rename that fails" } });
    fireEvent.click(screen.getByRole("button", { name: "Save fork Child path" }));

    expect(await screen.findByText("Fork rename failed.")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /rename fork child path/i }),
    ).toBeInTheDocument();
  });

  it("blocks active-path deletion and deletes an inactive fork", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (init?.method === "DELETE" && path.endsWith("/forks/branch-child")) {
          return jsonResponse({ data: { ok: true } });
        }
        return jsonResponse({
          data: { forks: [parentFork, childFork, siblingFork] },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onForksChanged = vi.fn();

    renderPanel(vi.fn(), onForksChanged);
    const treeItems = await visibleTreeItems();

    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: "Delete" });
    expect(
      screen.getByText("Switch away from this fork before deleting it."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: /confirm delete fork.*parent path/i }),
    ).not.toBeInTheDocument();

    treeItems[1].focus();
    fireEvent.keyDown(treeItems[1], { key: "Delete" });
    const confirm = screen.getByRole("group", {
      name: /confirm delete fork.*child path/i,
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    });
    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input).endsWith("/forks/branch-child") && init?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(onForksChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the graph tab selectable and switches graph leaves", async () => {
    const onSelectGraphLeaf = vi.fn<SelectGraphLeaf>();
    renderPanel(vi.fn(), vi.fn(), {
      branchGraph: graphWithLeaves,
      onSelectGraphLeaf,
    });
    await visibleTreeItems();

    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /switch to graph leaf.*title: sibling path/i,
      }),
    );

    expect(onSelectGraphLeaf).toHaveBeenCalledWith("sibling-assistant");
  });
});
