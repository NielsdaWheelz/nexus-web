import { describe, expect, it } from "vitest";
import {
  normalizeTrackChapters,
  resolveTranscriptChapterInterval,
} from "@/lib/media/transcriptChapters";

describe("resolveTranscriptChapterInterval", () => {
  it("uses start-inclusive, end-exclusive intervals and duplicate-safe ordinals", () => {
    const chapters = normalizeTrackChapters([
      { chapter_idx: 4, title: "First", t_start_ms: 0, t_end_ms: 8_000 },
      {
        chapter_idx: 4,
        title: "Second",
        t_start_ms: 5_000,
        t_end_ms: 15_000,
      },
      { chapter_idx: 9, title: "Final", t_start_ms: 10_000 },
    ]);

    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 0 }),
    ).toMatchObject({
      ordinal: 0,
      chapter: { title: "First" },
      startMs: 0,
      endMs: { kind: "Present", value: 5_000 },
    });
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 4_999 }),
    ).toMatchObject({ ordinal: 0 });
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 5_000 }),
    ).toMatchObject({
      ordinal: 1,
      chapter: { chapter_idx: 4, title: "Second" },
      startMs: 5_000,
      endMs: { kind: "Present", value: 10_000 },
    });
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 10_000 }),
    ).toMatchObject({
      ordinal: 2,
      chapter: { title: "Final" },
      startMs: 10_000,
      endMs: { kind: "Absent" },
    });
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 80_000 }),
    ).toMatchObject({ ordinal: 2 });
  });

  it("honors an earlier explicit end and returns no chapter in the gap", () => {
    const chapters = normalizeTrackChapters([
      { chapter_idx: 0, title: "Short", t_start_ms: 0, t_end_ms: 1_000 },
      { chapter_idx: 1, title: "Later", t_start_ms: 5_000 },
    ]);

    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 999 }),
    ).toMatchObject({ ordinal: 0 });
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 1_000 }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 4_999 }),
    ).toBeNull();
  });

  it("ignores invalid explicit ends and uses the next later start", () => {
    const chapters = normalizeTrackChapters([
      { chapter_idx: 0, title: "First", t_start_ms: 1_000, t_end_ms: 1_000 },
      { chapter_idx: 1, title: "Second", t_start_ms: 5_000 },
    ]);

    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 4_999 }),
    ).toMatchObject({
      ordinal: 0,
      endMs: { kind: "Present", value: 5_000 },
    });
  });

  it("rejects untimed and ambiguously contained positions", () => {
    const chapters = normalizeTrackChapters([
      { chapter_idx: 0, title: "First", t_start_ms: 0 },
      { chapter_idx: 1, title: "Also first", t_start_ms: 0 },
      { chapter_idx: 2, title: "Later", t_start_ms: 5_000 },
    ]);

    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: null }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({
        chapters,
        timestampMs: Number.NaN,
      }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: -1 }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 0 }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 4_999 }),
    ).toBeNull();
    expect(
      resolveTranscriptChapterInterval({ chapters, timestampMs: 5_000 }),
    ).toMatchObject({ ordinal: 2 });
  });
});
