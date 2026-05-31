import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

describe("toChatSSEEvent", () => {
  it("parses citation index events", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      }),
    ).toEqual({
      type: "citation_index",
      data: {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      },
    });
  });

  it("rejects malformed citation index entries", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 0,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });
});
