import { describe, expect, it } from "vitest";
import { RUN_SELECTION } from "@/__tests__/helpers/generationCatalog";
import { toChatSSEEvent } from "./events";

function meta(runSelection: unknown) {
  return {
    run_id: "run-1",
    conversation_id: "conversation-1",
    user_message_id: "user-1",
    assistant_message_id: "assistant-1",
    run_selection: runSelection,
    chat_subject: null,
  };
}

describe("chat SSE immutable run-selection contract", () => {
  it("decodes the complete immutable dispatch and current-state projection", () => {
    expect(toChatSSEEvent("meta", meta(RUN_SELECTION), "1")).toMatchObject({
      seq: 1,
      data: { run_selection: RUN_SELECTION },
    });
  });

  it("rejects an incomplete or widened projection", () => {
    expect(() =>
      toChatSSEEvent(
        "meta",
        meta({ ...RUN_SELECTION, compatibility_id: "retired" }),
        "1",
      ),
    ).toThrow("Invalid SSE payload for meta.run_selection");
    expect(() => toChatSSEEvent("meta", meta(null), "1")).toThrow(
      "Invalid SSE payload for meta.run_selection",
    );
  });
});
