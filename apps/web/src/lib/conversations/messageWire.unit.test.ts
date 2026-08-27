import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/conversations/types";
import { decodeConversationMessage } from "./messageWire";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT_ID = "22222222-2222-4222-8222-222222222222";
const FRAGMENT_ID = "33333333-3333-4333-8333-333333333333";

function message(): ConversationMessage {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    seq: 1,
    role: "user",
    trust_trail: null,
    citations: [],
    reader_selection: { kind: "Absent" },
    status: "complete",
    can_rerun: false,
    can_regenerate: false,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

describe("conversation message reader-selection wire", () => {
  it("decodes the explicit Absent and Present variants", () => {
    expect(decodeConversationMessage(message()).reader_selection).toEqual({
      kind: "Absent",
    });

    const decoded = decodeConversationMessage({
      ...message(),
      reader_selection: {
        kind: "Present",
        value: {
          key: { media_id: MEDIA_ID, highlight_id: HIGHLIGHT_ID },
          source_label: "Canonical source",
          exact: "Quoted passage",
          prefix: "Before",
          suffix: "After",
          locator: {
            type: "web_text_offsets",
            media_id: MEDIA_ID,
            fragment_id: FRAGMENT_ID,
            start_offset: 4,
            end_offset: 18,
          },
          activation: {
            resource_ref: `highlight:${HIGHLIGHT_ID}`,
            kind: "route",
            href: `/media/${MEDIA_ID}`,
            unresolved_reason: null,
          },
        },
      },
    } as unknown as ConversationMessage);

    expect(decoded.reader_selection).toMatchObject({
      kind: "Present",
      value: {
        key: { mediaId: MEDIA_ID, highlightId: HIGHLIGHT_ID },
        sourceLabel: "Canonical source",
        exact: "Quoted passage",
      },
    });
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
  ])("rejects a %s reader_selection field", (_label, readerSelection) => {
    const candidate = { ...message() } as Record<string, unknown>;
    if (readerSelection === undefined) {
      delete candidate.reader_selection;
    } else {
      candidate.reader_selection = readerSelection;
    }

    expect(() =>
      decodeConversationMessage(candidate as unknown as ConversationMessage),
    ).toThrow("Invalid Presence");
  });
});
