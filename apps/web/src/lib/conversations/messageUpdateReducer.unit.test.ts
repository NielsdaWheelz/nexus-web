import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/conversations/types";
import { messageUpdateReducer } from "./messageUpdateReducer";

function message(
  id: string,
  parentMessageId: string | null = null,
): ConversationMessage {
  return {
    id,
    seq: Number(id),
    role: "assistant",
    parent_message_id: parentMessageId,
    trust_trail: null,
    status: "complete",
    can_rerun: false,
    can_regenerate: false,
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
  };
}

describe("messageUpdateReducer remove_subtree", () => {
  it("removes the root and every transitive descendant only", () => {
    const state = [
      message("1"),
      message("2", "1"),
      message("3", "2"),
      message("4", "1"),
      message("5"),
      message("6", "5"),
    ];

    const next = messageUpdateReducer(state, {
      type: "remove_subtree",
      rootMessageId: "2",
    });

    expect(next.map(({ id }) => id)).toEqual(["1", "4", "5", "6"]);
  });

  it("preserves identity when the root is absent", () => {
    const state = [message("1"), message("2", "1")];

    const next = messageUpdateReducer(state, {
      type: "remove_subtree",
      rootMessageId: "missing",
    });

    expect(next).toEqual(state);
  });
});
