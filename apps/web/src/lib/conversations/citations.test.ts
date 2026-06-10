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

// A citation whose evidence-span target the backend reconstructed to a media
// reader jump (real media_id + RetrievalLocator). The backend is the sole
// CitationOut producer and reconstructs this from the target's own anchoring
// (resource_graph.resolve.reader_target_for_citation_target), uniformly for
// chat / Oracle / Library Intelligence.
function mediaCitation(overrides: Partial<CitationOut> = {}): CitationOut {
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
  it("builds a media reader target from media_id + locator", () => {
    expect(toReaderCitationData(mediaCitation())).toEqual({
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

  it("renders a link-only citation when no media reader target exists (e.g. an external snapshot or corpus passage)", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "external_snapshot", id: "ext-1" },
        media_id: null,
        locator: null,
        deep_link: "https://example.com/source",
      }),
    );
    expect(data.target).toBeNull();
    expect(data.href).toBe("https://example.com/source");
  });

  it("has a null target and href when neither a media reader nor a deep_link is present", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "note_block", id: "block-1" },
        media_id: null,
        locator: null,
        deep_link: null,
      }),
    );
    expect(data.target).toBeNull();
    expect(data.href).toBeNull();
  });

  it("prefers deep_link for the href when present", () => {
    const data = toReaderCitationData(
      mediaCitation({ deep_link: "https://example.com/source" }),
    );
    expect(data.href).toBe("https://example.com/source");
    expect(data.target?.href).toBe("https://example.com/source");
  });
});
