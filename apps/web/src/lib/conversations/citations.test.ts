import { describe, expect, it } from "vitest";
import { toReaderCitationData } from "./citations";
import type { CitationOut } from "./citationOut";

const locator = {
  type: "web_text_offsets",
  media_id: "media-1",
  fragment_id: "fragment-1",
  start_offset: 10,
  end_offset: 24,
} as const;

function citation(overrides: Partial<CitationOut> = {}): CitationOut {
  return {
    ordinal: 1,
    role: "context",
    target_ref: { type: "evidence_span", id: "span-1" },
    media_id: "media-1",
    locator,
    deep_link: null,
    snapshot: {
      title: "Source title",
      excerpt: "matched source text",
      section_label: "Section",
      result_type: "fragment",
    },
    ...overrides,
  };
}

describe("toReaderCitationData", () => {
  it("renders reader citation data for an evidence-span citation", () => {
    expect(toReaderCitationData(citation())).toEqual({
      index: 1,
      color: "yellow",
      preview: {
        title: "Source title",
        excerpt: "matched source text",
        meta: ["Section", "fragment"],
      },
      href: "/media/media-1#evidence-span-1",
      target: {
        kind: "media",
        source: "message_retrieval",
        media_id: "media-1",
        locator,
        snippet: "matched source text",
        highlight_behavior: "pulse",
        focus_behavior: "scroll_into_view",
        label: "Source title",
        href: "/media/media-1#evidence-span-1",
        evidence_span_id: "span-1",
      },
    });
  });

  it("uses deep_link for href when present", () => {
    const data = toReaderCitationData(
      citation({ deep_link: "https://example.com/source" }),
    );
    expect(data.href).toBe("https://example.com/source");
    expect(data.target?.href).toBe("https://example.com/source");
  });

  it("falls back to hrefForReaderTarget when deep_link is null", () => {
    expect(toReaderCitationData(citation()).href).toBe(
      "/media/media-1#evidence-span-1",
    );
  });

  it("surfaces a per-media summary_md as the preview summary", () => {
    expect(
      toReaderCitationData(
        citation({
          snapshot: {
            ...citation().snapshot,
            summary_md: "A concise per-media abstract.",
          },
        }),
      ).preview.summary,
    ).toBe("A concise per-media abstract.");
  });

  it("omits the preview summary when summary_md is absent or blank", () => {
    expect(toReaderCitationData(citation()).preview.summary).toBeUndefined();
    expect(
      toReaderCitationData(
        citation({ snapshot: { ...citation().snapshot, summary_md: "   " } }),
      ).preview.summary,
    ).toBeUndefined();
  });

  it("yields no reader target for a web_result citation (no media anchor)", () => {
    const data = toReaderCitationData(
      citation({
        target_ref: { type: "web_result", id: "https://example.com/a" },
        media_id: null,
        locator: null,
        deep_link: "https://example.com/a",
        snapshot: { title: "Web result", excerpt: "A web snippet" },
      }),
    );
    expect(data.target).toBeNull();
    expect(data.href).toBe("https://example.com/a");
  });
});
