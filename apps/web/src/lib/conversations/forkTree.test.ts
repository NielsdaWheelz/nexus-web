import { describe, expect, it } from "vitest";
import {
  buildForkTree,
  collectExpandableIds,
  filterNodes,
  flattenVisibleRows,
  isForkInActivePath,
  removeNode,
  updateNode,
} from "@/lib/conversations/forkTree";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";

function fork(overrides: Partial<ForkOption> & Pick<ForkOption, "id">): ForkOption {
  return {
    parent_message_id: "root-assistant",
    user_message_id: `${overrides.id}-user`,
    assistant_message_id: `${overrides.id}-assistant`,
    leaf_message_id: `${overrides.id}-assistant`,
    title: null,
    preview: "preview text",
    branch_anchor_kind: "assistant_message",
    branch_anchor_preview: null,
    status: "complete",
    message_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    active: false,
    ...overrides,
  };
}

const parent = fork({ id: "parent", assistant_message_id: "parent-assistant", title: "Parent" });
const child = fork({
  id: "child",
  parent_message_id: "parent-assistant",
  assistant_message_id: "child-assistant",
  title: "Child",
});
const sibling = fork({ id: "sibling", assistant_message_id: "sibling-assistant", title: "Sibling" });

function graphNode(
  messageId: string,
  parentMessageId: string | null,
  role: "user" | "assistant",
  depth: number,
): BranchGraph["nodes"][number] {
  return {
    id: messageId,
    message_id: messageId,
    parent_message_id: parentMessageId,
    leaf_message_id: messageId,
    role,
    depth,
    row: depth,
    title: null,
    preview: messageId,
    branch_anchor_preview: null,
    status: "complete",
    message_count: 1,
    child_count: 1,
    active_path: false,
    leaf: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("buildForkTree", () => {
  it("nests a fork under the parent whose assistant message it branches from", () => {
    const roots = buildForkTree([parent, child, sibling]);
    expect(roots.map((node) => node.id)).toEqual(["parent", "sibling"]);
    expect(roots[0].children.map((node) => node.id)).toEqual(["child"]);
  });

  it("treats a fork with no matching parent as a root", () => {
    const roots = buildForkTree([child]);
    expect(roots.map((node) => node.id)).toEqual(["child"]);
  });

  it("uses the branch graph to nest forks under the owning ancestor subtree", () => {
    const ancestor = fork({
      id: "ancestor",
      user_message_id: "ancestor-user",
      assistant_message_id: "ancestor-assistant",
      leaf_message_id: "later-assistant",
      title: "Ancestor",
      message_count: 4,
    });
    const descendant = fork({
      id: "descendant",
      parent_message_id: "later-assistant",
      user_message_id: "descendant-user",
      assistant_message_id: "descendant-assistant",
      leaf_message_id: "descendant-assistant",
      title: "Descendant",
    });
    const graph: BranchGraph = {
      root_message_id: "root-user",
      nodes: [
        graphNode("root-user", null, "user", 0),
        graphNode("root-assistant", "root-user", "assistant", 1),
        graphNode("ancestor-user", "root-assistant", "user", 2),
        graphNode("ancestor-assistant", "ancestor-user", "assistant", 3),
        graphNode("later-user", "ancestor-assistant", "user", 4),
        graphNode("later-assistant", "later-user", "assistant", 5),
        graphNode("descendant-user", "later-assistant", "user", 6),
        graphNode("descendant-assistant", "descendant-user", "assistant", 7),
      ],
      edges: [],
    };

    const roots = buildForkTree([ancestor, descendant], graph);

    expect(roots.map((node) => node.id)).toEqual(["ancestor"]);
    expect(roots[0].children.map((node) => node.id)).toEqual(["descendant"]);
  });
});

describe("isForkInActivePath", () => {
  it("matches active flags, selected path messages, and the active leaf", () => {
    expect(
      isForkInActivePath(fork({ id: "active", active: true }), {
        selectedPathMessageIds: new Set(),
      }),
    ).toBe(true);
    expect(
      isForkInActivePath(fork({ id: "leaf" }), {
        activeLeafMessageId: "leaf-assistant",
        selectedPathMessageIds: new Set(),
      }),
    ).toBe(true);
    expect(
      isForkInActivePath(fork({ id: "selected-leaf" }), {
        selectedPathMessageIds: new Set(["selected-leaf-assistant"]),
      }),
    ).toBe(true);
    expect(
      isForkInActivePath(fork({ id: "user" }), {
        selectedPathMessageIds: new Set(["user-user"]),
      }),
    ).toBe(true);
    expect(
      isForkInActivePath(fork({ id: "assistant", leaf_message_id: "assistant-leaf" }), {
        selectedPathMessageIds: new Set(["assistant-assistant"]),
      }),
    ).toBe(true);
  });

  it("does not treat an inactive fork with no selected messages as active", () => {
    expect(
      isForkInActivePath(fork({ id: "inactive", assistant_message_id: null }), {
        selectedPathMessageIds: new Set(),
      }),
    ).toBe(false);
  });
});

describe("filterNodes", () => {
  it("keeps a node when its own text matches", () => {
    const roots = buildForkTree([parent, child, sibling]);
    const filtered = filterNodes(roots, "sibling");
    expect(filtered.map((node) => node.id)).toEqual(["sibling"]);
  });

  it("keeps an ancestor when only a descendant matches", () => {
    const roots = buildForkTree([parent, child, sibling]);
    const filtered = filterNodes(roots, "child");
    expect(filtered.map((node) => node.id)).toEqual(["parent"]);
    expect(filtered[0].children.map((node) => node.id)).toEqual(["child"]);
  });
});

describe("flattenVisibleRows", () => {
  it("includes children only for expanded nodes, with depth and parentId", () => {
    const roots = buildForkTree([parent, child, sibling]);

    const collapsed = flattenVisibleRows(roots, new Set());
    expect(collapsed.map((row) => row.node.id)).toEqual(["parent", "sibling"]);

    const expanded = flattenVisibleRows(roots, new Set(["parent"]));
    expect(expanded.map((row) => row.node.id)).toEqual(["parent", "child", "sibling"]);
    const childRow = expanded.find((row) => row.node.id === "child");
    expect(childRow).toMatchObject({ depth: 1, parentId: "parent" });
  });
});

describe("collectExpandableIds", () => {
  it("returns only ids of nodes that have children", () => {
    const roots = buildForkTree([parent, child, sibling]);
    expect(collectExpandableIds(roots)).toEqual(["parent"]);
  });
});

describe("updateNode", () => {
  it("patches the title of the matching node anywhere in the tree", () => {
    const roots = buildForkTree([parent, child, sibling]);
    const updated = updateNode(roots, "child", { title: "Renamed" });
    expect(updated[0].children[0].title).toBe("Renamed");
    expect(updated[1].title).toBe("Sibling");
  });
});

describe("removeNode", () => {
  it("removes the matching node and keeps the rest of the tree", () => {
    const roots = buildForkTree([parent, child, sibling]);
    const pruned = removeNode(roots, "child");
    expect(pruned.map((node) => node.id)).toEqual(["parent", "sibling"]);
    expect(pruned[0].children).toEqual([]);
  });
});
