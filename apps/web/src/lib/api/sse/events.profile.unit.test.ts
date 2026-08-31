import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

function meta(profileId: string) {
  return {
    run_id: "run-1",
    conversation_id: "conversation-1",
    user_message_id: "user-1",
    assistant_message_id: "assistant-1",
    profile_id: profileId,
    chat_subject: null,
  };
}

describe("chat SSE meta profile contract", () => {
  it.each(["fast", "balanced", "deep"])(
    "accepts the %s product profile",
    (profileId) => {
      expect(toChatSSEEvent("meta", meta(profileId), "1")).toMatchObject({
        seq: 1,
        data: { profile_id: profileId },
      });
    },
  );

  it("rejects retired and unknown profile ids", () => {
    expect(() => toChatSSEEvent("meta", meta("claude"), "1")).toThrow(
      "Invalid SSE payload for meta.profile_id",
    );
  });
});
