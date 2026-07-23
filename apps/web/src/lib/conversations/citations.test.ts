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
// chat / Oracle / Universal Dossiers.
function mediaCitation(overrides: Partial<CitationOut> = {}): CitationOut {
  return {
    ordinal: 1,
    role: "context",
    target_ref: { type: "evidence_span", id: "span-1" },
    activation: {
      resourceRef: "evidence_span:span-1",
      kind: "route",
      href: "/media/media-1#evidence-span-1",
      unresolvedReason: null,
    },
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
      preview: {
        title: "Source title",
        excerpt: "matched source text",
        meta: ["Section", "fragment"],
      },
      activation: {
        resourceRef: "evidence_span:span-1",
        kind: "route",
        href: "/media/media-1#evidence-span-1",
        unresolvedReason: null,
      },
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

  it("maps backend media summary snapshots into citation previews", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "media", id: "media-1" },
        snapshot: {
          title: "Source title",
          summary_md: "A concise per-media abstract.",
          excerpt: "matched source text",
          section_label: "Section",
          result_type: "media",
        },
      }),
    );

    expect(data.preview.summary).toBe("A concise per-media abstract.");
  });

  it("renders a link-only citation when no media reader target exists (e.g. an external snapshot or corpus passage)", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "external_snapshot", id: "ext-1" },
        activation: {
          resourceRef: "external_snapshot:ext-1",
          kind: "external",
          href: "https://example.com/source",
          unresolvedReason: null,
        },
        media_id: null,
        locator: null,
        deep_link: null,
      }),
    );
    expect(data.target).toBeNull();
    expect(data.activation.href).toBe("https://example.com/source");
  });

  it("keeps activation href for content_chunk citations without a locator", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "content_chunk", id: "chunk-1" },
        activation: {
          resourceRef: "content_chunk:chunk-1",
          kind: "route",
          href: "/media/media-1#evidence-span-1",
          unresolvedReason: null,
        },
        locator: null,
      }),
    );
    expect(data.target).toBeNull();
    expect(data.activation.href).toBe("/media/media-1#evidence-span-1");
  });

  it("builds a note reader target from note locators", () => {
    expect(
      toReaderCitationData(
        mediaCitation({
          target_ref: { type: "evidence_span", id: "span-note-1" },
          activation: {
            resourceRef: "evidence_span:span-note-1",
            kind: "route",
            href: "/notes/block-1",
            unresolvedReason: null,
          },
          media_id: null,
          locator: {
            type: "note_block_offsets",
            block_id: "block-1",
            start_offset: 3,
            end_offset: 19,
          },
          deep_link: null,
        }),
      ),
    ).toEqual({
      index: 1,
      preview: {
        title: "Source title",
        excerpt: "matched source text",
        meta: ["Section", "fragment"],
      },
      activation: {
        resourceRef: "evidence_span:span-note-1",
        kind: "route",
        href: "/notes/block-1",
        unresolvedReason: null,
      },
      target: {
        kind: "note",
        source: "message_retrieval",
        block_id: "block-1",
        start_offset: 3,
        end_offset: 19,
        snippet: "matched source text",
        highlight_behavior: "pulse",
        focus_behavior: "scroll_into_view",
        label: "Source title",
        href: "/notes/block-1",
        evidence_id: "span-note-1",
      },
    });
  });

  it("has a null target and href when backend activation is unresolved", () => {
    const data = toReaderCitationData(
      mediaCitation({
        target_ref: { type: "note_block", id: "block-1" },
        activation: {
          resourceRef: "note_block:block-1",
          kind: "none",
          href: null,
          unresolvedReason: "missing",
        },
        media_id: null,
        locator: null,
        deep_link: null,
      }),
    );
    expect(data.target).toBeNull();
    expect(data.activation.href).toBeNull();
  });

  it("uses activation href instead of deep_link", () => {
    const data = toReaderCitationData(
      mediaCitation({ deep_link: "https://example.com/source" }),
    );
    expect(data.activation.href).toBe("/media/media-1#evidence-span-1");
    expect(data.target?.href).toBe("/media/media-1#evidence-span-1");
  });
});
