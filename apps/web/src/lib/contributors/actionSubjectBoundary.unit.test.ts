import { describe, expect, it } from "vitest";
import { decodeContributorDetail } from "./detail";
import { decodeContributorWorkItem } from "./workItem";

const CONTRIBUTOR_REF = "contributor:11111111-1111-4111-8111-111111111111";
const MEDIA_REF = "media:22222222-2222-4222-8222-222222222222";

const DETAIL = {
  handle: "ada-lovelace",
  href: "/authors/ada-lovelace",
  displayName: "Ada Lovelace",
  otherNames: [],
  canRename: true,
  actionSubject: { ref: CONTRIBUTOR_REF },
};

function work(actionSubject: unknown): Record<string, unknown> {
  return {
    title: "Notes on the Analytical Engine",
    href:
      actionSubject === null
        ? "https://example.test/analytical-engine"
        : "/media/22222222-2222-4222-8222-222222222222",
    contentKind: "article",
    date: null,
    roleFacts: [
      { creditedName: "Ada Lovelace", role: "author", rawRole: null },
    ],
    actionSubject,
  };
}

describe("Contributor canonical action subject boundary", () => {
  it("decodes detail and owned work subjects as ref-only identity", () => {
    expect(decodeContributorDetail(DETAIL).actionSubject).toEqual({
      ref: CONTRIBUTOR_REF,
    });
    expect(
      decodeContributorWorkItem(work({ ref: MEDIA_REF })).actionSubject,
    ).toEqual({ ref: MEDIA_REF });
  });

  it("keeps external works explicitly non-resource", () => {
    expect(decodeContributorWorkItem(work(null)).actionSubject).toBeNull();
  });

  it("rejects legacy standing-target fields with no fallback", () => {
    expect(() =>
      decodeContributorDetail({
        ...DETAIL,
        actionSubject: {
          kind: "Resource",
          ref: CONTRIBUTOR_REF,
          activation: {
            resourceRef: CONTRIBUTOR_REF,
            kind: "route",
            href: "/authors/ada-lovelace",
            unresolvedReason: null,
          },
          missing: false,
        },
      }),
    ).toThrow("must contain exactly");
  });
});
