import { describe, expect, it } from "vitest";
import { decodeBrowsePage } from "./contract";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const PUBLISHER_SELECTED_REF =
  "podcast:22222222-2222-4222-8222-222222222222";

function resolutionKind(resolution: unknown): unknown {
  return typeof resolution === "object" && resolution !== null
    ? (resolution as Record<string, unknown>).kind
    : null;
}

function pageWithResolution(resolution: unknown): Record<string, unknown> {
  const source = resolutionKind(resolution) === "InNexus" ? "Nexus" : "Brave";
  return {
    query: "field notes",
    kind: "WebArticle",
    source,
    sort: { kind: "Absent" },
    items: [
      {
        kind: "WebArticle",
        source,
        resolution,
        title: "Field Notes",
        contributors: [],
        description: { kind: "Absent" },
        publishedAt: { kind: "Absent" },
        image: { kind: "Absent" },
        kindFacts: { siteName: { kind: "Absent" } },
      },
    ],
    nextCursor: { kind: "Absent" },
  };
}

describe("Browse canonical action subject boundary", () => {
  it("decodes an owned candidate to a ref-only subject", () => {
    const page = decodeBrowsePage(
      pageWithResolution({
        kind: "InNexus",
        href: `/media/${MEDIA_ID}`,
        actionSubjectRef: MEDIA_REF,
      }),
    );

    expect(page.items[0]?.resolution).toEqual({
      kind: "InNexus",
      href: `/media/${MEDIA_ID}`,
      actionSubject: { ref: MEDIA_REF },
    });
  });

  it("trusts the publisher-selected subject independently of the occurrence href", () => {
    const page = decodeBrowsePage(
      pageWithResolution({
        kind: "InNexus",
        href: `/media/${MEDIA_ID}`,
        actionSubjectRef: PUBLISHER_SELECTED_REF,
      }),
    );

    expect(page.items[0]?.resolution).toEqual({
      kind: "InNexus",
      href: `/media/${MEDIA_ID}`,
      actionSubject: { ref: PUBLISHER_SELECTED_REF },
    });
  });

  it("rejects a malformed explicit action subject ref", () => {
    expect(() =>
      decodeBrowsePage(
        pageWithResolution({
          kind: "InNexus",
          href: `/media/${MEDIA_ID}`,
          actionSubjectRef: "not-a-resource-ref",
        }),
      ),
    ).toThrow("Invalid canonical ResourceRef");
  });

  it("keeps Preview non-resource and rejects a fabricated action subject", () => {
    const preview = {
      kind: "Preview",
      target: "ndt1.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(
      decodeBrowsePage(pageWithResolution(preview)).items[0]?.resolution,
    ).toEqual(preview);

    expect(() =>
      decodeBrowsePage(
        pageWithResolution({ ...preview, actionSubjectRef: MEDIA_REF }),
      ),
    ).toThrow("must contain exactly");
  });

  it("keeps ExternalOnly non-resource and rejects a fabricated action subject", () => {
    const external = {
      kind: "ExternalOnly",
      sourceHref: "https://example.test/field-notes",
    };
    expect(
      decodeBrowsePage(pageWithResolution(external)).items[0]?.resolution,
    ).toEqual(external);

    expect(() =>
      decodeBrowsePage(
        pageWithResolution({ ...external, actionSubjectRef: MEDIA_REF }),
      ),
    ).toThrow("must contain exactly");
  });
});
