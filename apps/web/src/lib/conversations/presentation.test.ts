import { describe, expect, it } from "vitest";
import { presentConversationListItem } from "./presentation";

const environment = {
  displayLocale: "en-US",
  currentInstant: "2026-06-03T12:00:00.000Z",
};

describe("presentConversationListItem", () => {
  it("uses the injected render instant and localizes concise list metadata", () => {
    expect(
      presentConversationListItem(
        {
          title: "  ",
          message_count: 2,
          updated_at: "2026-06-03T09:00:00.000Z",
        },
        environment,
      ),
    ).toEqual({ title: "Untitled chat", metadata: "3 hours ago · 2 messages" });
  });

  it("uses the singular message label", () => {
    expect(
      presentConversationListItem(
        {
          title: "One turn",
          message_count: 1,
          updated_at: "not a date",
        },
        environment,
      ),
    ).toEqual({ title: "One turn", metadata: "1 message" });
  });
});
