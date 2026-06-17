import { describe, expect, it } from "vitest";
import { isCitationOut } from "./citationOut";

const citationOut = {
  ordinal: 1,
  role: "context",
  target_ref: {
    type: "media",
    id: "11111111-1111-4111-8111-111111111111",
  },
  media_id: "11111111-1111-4111-8111-111111111111",
  locator: null,
  deep_link: "/media/11111111-1111-4111-8111-111111111111",
  snapshot: {
    title: "Source title",
    excerpt: "Selected source text",
    section_label: "Section",
    result_type: "media",
    summary_md: "A concise source summary.",
  },
};

describe("isCitationOut", () => {
  it("accepts backend CitationSnapshot summary_md", () => {
    expect(isCitationOut(citationOut)).toBe(true);
  });

  it("rejects extra snapshot fields", () => {
    expect(
      isCitationOut({
        ...citationOut,
        snapshot: {
          ...citationOut.snapshot,
          page_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toBe(false);
  });
});
