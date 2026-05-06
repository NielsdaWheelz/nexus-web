import { describe, expect, it } from "vitest";
import {
  activeBranchGraphForPath,
  activeForkOptionsForPath,
  selectedPathAfterRun,
  upsertForkOptionForRun,
} from "@/lib/conversations/branching";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";

const base = {
  status: "complete",
  error_code: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  content: string,
  parentMessageId: string | null = null,
): ConversationMessage {
  return {
    ...base,
    id,
    seq,
    role,
    content,
    parent_message_id: parentMessageId,
  };
}

function runData(parentMessageId: string): ChatRunResponse["data"] {
  const user = message("fork-user", 7, "user", "Take another path", parentMessageId);
  return {
    run: {
      id: "run-1",
      status: "running",
      conversation_id: "conversation-1",
      user_message_id: user.id,
      assistant_message_id: "fork-assistant",
      model_id: "model-1",
      reasoning: "default",
      key_mode: "auto",
      cancel_requested_at: null,
      started_at: null,
      completed_at: null,
      error_code: null,
      created_at: "2026-01-01T00:00:01Z",
      updated_at: "2026-01-01T00:00:01Z",
    },
    conversation: {
      id: "conversation-1",
      title: "Conversation",
      sharing: "private",
      message_count: 4,
      scope: { type: "general" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    user_message: user,
    assistant_message: message(
      "fork-assistant",
      8,
      "assistant",
      "",
      user.id,
    ),
  };
}

describe("conversation branching helpers", () => {
  it("replaces later selected-path messages when a run forks from an older assistant", () => {
    const path = [
      message("user-1", 1, "user", "Start"),
      message("assistant-1", 2, "assistant", "First answer", "user-1"),
      message("user-2", 3, "user", "Existing branch", "assistant-1"),
      message("assistant-2", 4, "assistant", "Existing answer", "user-2"),
    ];

    const next = selectedPathAfterRun(path, runData("assistant-1"));

    expect(next.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-1",
      "fork-user",
      "fork-assistant",
    ]);
  });

  it("ignores a streamed run whose parent is not on the selected path", () => {
    const path = [
      message("user-1", 1, "user", "Start"),
      message("assistant-1", 2, "assistant", "First answer", "user-1"),
      message("user-2", 3, "user", "Selected branch", "assistant-1"),
      message("assistant-2", 4, "assistant", "Selected answer", "user-2"),
    ];

    const next = selectedPathAfterRun(path, runData("assistant-sibling"));

    expect(next).toBe(path);
  });

  it("adds a visible active fork option for a newly created branch run", () => {
    const options = upsertForkOptionForRun(
      {
        "assistant-1": [
          {
            id: "branch-existing",
            parent_message_id: "assistant-1",
            user_message_id: "user-existing",
            assistant_message_id: "assistant-existing",
            leaf_message_id: "assistant-existing",
            title: null,
            preview: "Existing branch",
            branch_anchor_kind: "assistant_message",
            branch_anchor_preview: null,
            status: "complete",
            message_count: 2,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            active: true,
          },
        ],
      },
      runData("assistant-1"),
    );

    expect(options["assistant-1"].map((item) => item.preview)).toEqual([
      "Existing branch",
      "Take another path",
    ]);
    expect(options["assistant-1"][0].active).toBe(false);
    expect(options["assistant-1"][1]).toMatchObject({
      user_message_id: "fork-user",
      leaf_message_id: "fork-assistant",
      status: "pending",
      active: true,
    });
  });

  it("marks cached-path fork options and graph nodes active before persistence returns", () => {
    const path = [
      message("assistant-1", 1, "assistant", "Branch point"),
      message("user-2", 2, "user", "New branch", "assistant-1"),
      message("assistant-3", 3, "assistant", "New answer", "user-2"),
    ];
    const options = activeForkOptionsForPath(
      {
        "assistant-1": [
          {
            id: "branch-1",
            parent_message_id: "assistant-1",
            user_message_id: "user-1",
            assistant_message_id: "assistant-2",
            leaf_message_id: "assistant-2",
            title: null,
            preview: "Old branch",
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
            preview: "New branch",
            branch_anchor_kind: "assistant_message",
            branch_anchor_preview: null,
            status: "complete",
            message_count: 2,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            active: false,
          },
        ],
      },
      path,
    );

    expect(options["assistant-1"].map((option) => option.active)).toEqual([
      false,
      true,
    ]);

    const graph = activeBranchGraphForPath(
      {
        root_message_id: "assistant-1",
        edges: [],
        nodes: [
          {
            id: "assistant-1",
            message_id: "assistant-1",
            parent_message_id: null,
            leaf_message_id: "assistant-1",
            role: "assistant",
            depth: 0,
            row: 0,
            title: null,
            preview: "Branch point",
            branch_anchor_preview: null,
            status: "complete",
            message_count: 1,
            child_count: 2,
            active_path: false,
            leaf: false,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "assistant-3",
            message_id: "assistant-3",
            parent_message_id: "user-2",
            leaf_message_id: "assistant-3",
            role: "assistant",
            depth: 2,
            row: 1,
            title: null,
            preview: "New answer",
            branch_anchor_preview: null,
            status: "complete",
            message_count: 3,
            child_count: 0,
            active_path: false,
            leaf: true,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      path,
    );

    expect(graph.nodes.map((node) => node.active_path)).toEqual([true, true]);
  });
});
