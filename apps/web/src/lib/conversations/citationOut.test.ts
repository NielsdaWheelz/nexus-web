import { describe, expect, it } from "vitest";
import { decodeCitationOut } from "./citationOut";

const citationOut = {
  ordinal: 1,
  role: "context",
  target_ref: {
    type: "media",
    id: "11111111-1111-4111-8111-111111111111",
  },
  activation: {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
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
const citationWire = {
  ...citationOut,
  activation: {
    resource_ref: citationOut.activation.resourceRef,
    kind: citationOut.activation.kind,
    href: citationOut.activation.href,
    unresolved_reason: citationOut.activation.unresolvedReason,
  },
};

describe("decodeCitationOut", () => {
  it("accepts backend CitationSnapshot summary_md", () => {
    expect(decodeCitationOut(citationWire)).toEqual(citationOut);
  });

  it("rejects the removed internal activation shape at the wire boundary", () => {
    expect(decodeCitationOut(citationOut)).toBeNull();
  });

  it("rejects extra snapshot fields", () => {
    expect(
      decodeCitationOut({
        ...citationWire,
        snapshot: {
          ...citationOut.snapshot,
          page_id: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).toBeNull();
  });

  it("rejects malformed activation instead of coercing it", () => {
    expect(
      decodeCitationOut({
        ...citationWire,
        activation: {
          ...citationWire.activation,
          kind: "missing",
        },
      }),
    ).toBeNull();
  });
});
