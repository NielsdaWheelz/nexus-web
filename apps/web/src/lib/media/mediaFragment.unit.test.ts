import { describe, expect, it } from "vitest";
import { decodeMediaFragmentsResponse } from "./mediaFragment";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function fragment() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    media_id: MEDIA_ID,
    idx: 0,
    html_sanitized: "<p>Canonical text</p>",
    canonical_text: "Canonical text",
    word_count: 2,
    document_word_start: 0,
    t_start_ms: null,
    t_end_ms: null,
    speaker_label: null,
    document_embeds: [],
    created_at: "2026-08-25T00:00:00Z",
  };
}

describe("media fragments wire", () => {
  it("decodes exact rows for the requested media", () => {
    expect(
      decodeMediaFragmentsResponse({ data: [fragment()] }, MEDIA_ID),
    ).toEqual([fragment()]);
  });

  it("rejects additive rows and cross-media results", () => {
    expect(() =>
      decodeMediaFragmentsResponse(
        { data: [{ ...fragment(), legacy_html: "<p>old</p>" }] },
        MEDIA_ID,
      ),
    ).toThrow(/must contain exactly/);

    expect(() =>
      decodeMediaFragmentsResponse(
        { data: [{ ...fragment(), media_id: "different-media" }] },
        MEDIA_ID,
      ),
    ).toThrow(/must match the requested media/);
  });
});
