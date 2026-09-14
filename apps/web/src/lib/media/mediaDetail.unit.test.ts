import { describe, expect, it } from "vitest";
import {
  decodeMediaDetail,
  decodeMediaDetailResponse,
} from "./mediaDetail";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MEDIA_ID = "22222222-2222-4222-8222-222222222222";

function mediaDetail() {
  return {
    id: MEDIA_ID,
    kind: "pdf",
    title: "Architecture notes",
    canonical_source_url: null,
    processing_status: "ready_for_reading",
    source_progress: { kind: "Absent" },
    transcript_state: null,
    transcript_coverage: null,
    transcript_origin: { kind: "Absent" },
    retrieval_status: null,
    retrieval_status_reason: null,
    failure_stage: null,
    last_error_code: null,
    playback_source: null,
    listening_state: null,
    episode_state: null,
    chapters: [],
    capabilities: {
      can_read: true,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: false,
      can_download_file: true,
      can_delete: true,
      can_retry: false,
      can_refresh_source: true,
      can_retry_metadata: false,
      can_repair_source: false,
      can_repair_search: false,
      can_edit_authors: true,
      can_read_embeds: false,
    },
    document_embed_summary: null,
    contributors: [],
    author_mode: "automatic",
    original_published_date: { kind: "Absent" },
    edition_published_date: { kind: "Absent" },
    publisher: null,
    language: null,
    description: null,
    description_html: null,
    description_text: null,
    metadata_enriched_at: null,
    read_state: "unread",
    progress_fraction: null,
    progress_resettable: false,
    last_engaged_at: null,
    playerDescriptor: { kind: "Absent" },
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

describe("media detail wire", () => {
  it("decodes the exact response and requested identity", () => {
    expect(
      decodeMediaDetailResponse({ data: mediaDetail() }, MEDIA_ID),
    ).toMatchObject({
      id: MEDIA_ID,
      kind: "pdf",
      processing_status: "ready_for_reading",
      capabilities: { can_read: true, can_refresh_source: true },
    });
  });

  it("rejects additive, omitted, and mismatched identity shapes", () => {
    expect(() =>
      decodeMediaDetail({
        ...mediaDetail(),
        podcast_image_url: "https://legacy.invalid/art.jpg",
      }),
    ).toThrow(/must contain exactly/);

    const { transcript_origin: _omitted, ...missing } = mediaDetail();
    expect(() => decodeMediaDetail(missing)).toThrow(/must contain exactly/);

    expect(() =>
      decodeMediaDetailResponse({ data: mediaDetail() }, OTHER_MEDIA_ID),
    ).toThrow(/must match the requested media/);
  });

  it("keeps original absence independent of an edition and rejects non-calendar dates", () => {
    const wire = {
      ...mediaDetail(),
      edition_published_date: { kind: "Present", value: "2007-06" },
    };
    const media = decodeMediaDetail(wire);
    expect(media.original_published_date).toEqual({ kind: "Absent" });
    expect(media.edition_published_date).toEqual({
      kind: "Present",
      value: "2007-06",
    });

    for (const value of ["2023-02-29", "2026-01-01T00:00:00Z", "0000"]) {
      expect(() =>
        decodeMediaDetail({
          ...wire,
          original_published_date: { kind: "Present", value },
        }),
      ).toThrow(/must be a real/);
    }
    expect(() =>
      decodeMediaDetail({ ...wire, original_published_date: null }),
    ).toThrow(/Presence/);
  });
});
