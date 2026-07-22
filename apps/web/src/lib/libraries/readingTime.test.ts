import { describe, expect, it } from "vitest";
import {
  decodeLibraryReadingTimeEntry,
  readingTimeSignal,
  type ReadingTimeEstimatePresence,
} from "./readingTime";

const absent = { kind: "Absent" } as const;

function estimate(totalMinutes = 15) {
  return {
    kind: "Present" as const,
    value: { totalMinutes, remainingMinutes: absent },
  };
}

function mediaEntry(overrides: Record<string, unknown> = {}) {
  return {
    kind: "media",
    media: {
      kind: "web_article",
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_fraction: null,
      capabilities: { can_quote: true },
    },
    readingTimeEstimate: estimate(),
    ...overrides,
  };
}

describe("decodeLibraryReadingTimeEntry", () => {
  it("accepts the exact total-only document contract", () => {
    expect(
      decodeLibraryReadingTimeEntry(mediaEntry()).readingTimeEstimate,
    ).toEqual(estimate());
  });

  it("accepts total-only PDF and progressless in-progress web estimates", () => {
    for (const media of [
      {
        ...mediaEntry().media,
        kind: "pdf",
        read_state: "in_progress",
        progress_fraction: 0.5,
      },
      {
        ...mediaEntry().media,
        read_state: "in_progress",
        progress_fraction: null,
      },
    ]) {
      expect(
        decodeLibraryReadingTimeEntry(mediaEntry({ media }))
          .readingTimeEstimate,
      ).toEqual(estimate());
    }
  });

  it("accepts remaining time exactly for in-progress web/EPUB progression", () => {
    for (const kind of ["web_article", "epub"] as const) {
      const entry = mediaEntry({
        media: {
          kind,
          processing_status: "ready_for_reading",
          read_state: "in_progress",
          progress_fraction: 0.5,
          capabilities: { can_quote: true },
        },
        readingTimeEstimate: {
          kind: "Present",
          value: {
            totalMinutes: 15,
            remainingMinutes: { kind: "Present", value: 8 },
          },
        },
      });
      expect(decodeLibraryReadingTimeEntry(entry).readingTimeEstimate).toEqual(
        entry.readingTimeEstimate,
      );
    }
  });

  it("requires remaining time when in-progress web/EPUB progression exists", () => {
    expect(() =>
      decodeLibraryReadingTimeEntry(
        mediaEntry({
          media: {
            kind: "web_article",
            processing_status: "ready_for_reading",
            read_state: "in_progress",
            progress_fraction: 0.5,
            capabilities: { can_quote: true },
          },
        }),
      ),
    ).toThrow(/must match/);
  });

  it("forbids remaining time without in-progress whole-document progression", () => {
    for (const [read_state, progress_fraction] of [
      ["unread", 0.5],
      ["finished", 1],
      ["in_progress", null],
    ] as const) {
      expect(() =>
        decodeLibraryReadingTimeEntry(
          mediaEntry({
            media: {
              kind: "epub",
              processing_status: "ready_for_reading",
              read_state,
              progress_fraction,
              capabilities: { can_quote: true },
            },
            readingTimeEstimate: {
              kind: "Present",
              value: {
                totalMinutes: 15,
                remainingMinutes: { kind: "Present", value: 5 },
              },
            },
          }),
        ),
      ).toThrow(/must match/);
    }
  });

  it("forbids PDF remaining time and estimates on ineligible entries", () => {
    const present = {
      kind: "Present",
      value: {
        totalMinutes: 15,
        remainingMinutes: { kind: "Present", value: 5 },
      },
    };
    expect(() =>
      decodeLibraryReadingTimeEntry(
        mediaEntry({
          media: {
            kind: "pdf",
            processing_status: "ready_for_reading",
            read_state: "in_progress",
            progress_fraction: 0.5,
            capabilities: { can_quote: true },
          },
          readingTimeEstimate: present,
        }),
      ),
    ).toThrow(/PDF/);

    for (const media of [
      {
        kind: "video",
        processing_status: "ready_for_reading",
        read_state: "unread",
        progress_fraction: null,
        capabilities: { can_quote: true },
      },
      {
        kind: "web_article",
        processing_status: "extracting",
        read_state: "unread",
        progress_fraction: null,
        capabilities: { can_quote: true },
      },
      {
        kind: "web_article",
        processing_status: "ready_for_reading",
        read_state: "unread",
        progress_fraction: null,
        capabilities: { can_quote: false },
      },
    ]) {
      expect(() =>
        decodeLibraryReadingTimeEntry(
          mediaEntry({ media, readingTimeEstimate: estimate() }),
        ),
      ).toThrow(/ready, quotable document/);
    }
    expect(() =>
      decodeLibraryReadingTimeEntry({
        kind: "podcast",
        readingTimeEstimate: estimate(),
      }),
    ).toThrow(/Podcast/);
  });

  it("accepts explicit absence for every entry kind", () => {
    expect(
      decodeLibraryReadingTimeEntry({
        ...mediaEntry(),
        readingTimeEstimate: absent,
      }).readingTimeEstimate,
    ).toEqual(absent);
    expect(
      decodeLibraryReadingTimeEntry({
        kind: "podcast",
        readingTimeEstimate: absent,
      }).readingTimeEstimate,
    ).toEqual(absent);
  });

  it("rejects removed root consumption fields", () => {
    expect(() =>
      decodeLibraryReadingTimeEntry({ ...mediaEntry(), read_state: "unread" }),
    ).toThrow(/nested media/);
    expect(() =>
      decodeLibraryReadingTimeEntry({ ...mediaEntry(), progress_fraction: 0.5 }),
    ).toThrow(/nested media/);
  });

  it.each([
    ["media kind", { media: { ...mediaEntry().media, kind: "book" } }],
    [
      "processing status",
      { media: { ...mediaEntry().media, processing_status: "ready" } },
    ],
    ["read state", { media: { ...mediaEntry().media, read_state: null } }],
    [
      "progress fraction",
      { media: { ...mediaEntry().media, progress_fraction: Number.NaN } },
    ],
    [
      "progress range",
      { media: { ...mediaEntry().media, progress_fraction: 1.1 } },
    ],
    [
      "negative progress",
      { media: { ...mediaEntry().media, progress_fraction: -0.1 } },
    ],
    [
      "can-quote capability",
      { media: { ...mediaEntry().media, capabilities: {} } },
    ],
  ])("rejects an invalid required policy input: %s", (_name, overrides) => {
    expect(() => decodeLibraryReadingTimeEntry(mediaEntry(overrides))).toThrow();
  });

  it.each([
    ["missing", mediaEntry({ readingTimeEstimate: undefined })],
    ["null", mediaEntry({ readingTimeEstimate: null })],
    [
      "malformed Presence",
      mediaEntry({
        readingTimeEstimate: { kind: "Absent", value: null },
      }),
    ],
    [
      "snake",
      {
        ...mediaEntry({ readingTimeEstimate: undefined }),
        reading_time_estimate: absent,
      },
    ],
    [
      "extra estimate key",
      mediaEntry({
        readingTimeEstimate: {
          kind: "Present",
          value: {
            totalMinutes: 15,
            remainingMinutes: absent,
            wordsPerMinute: 240,
          },
        },
      }),
    ],
    [
      "non-integer total",
      mediaEntry({
        readingTimeEstimate: {
          kind: "Present",
          value: { totalMinutes: 1.5, remainingMinutes: absent },
        },
      }),
    ],
    [
      "non-positive total",
      mediaEntry({
        readingTimeEstimate: {
          kind: "Present",
          value: { totalMinutes: 0, remainingMinutes: absent },
        },
      }),
    ],
    [
      "total above int32",
      mediaEntry({
        readingTimeEstimate: {
          kind: "Present",
          value: {
            totalMinutes: 2_147_483_648,
            remainingMinutes: absent,
          },
        },
      }),
    ],
    [
      "nullable remaining Presence",
      mediaEntry({
        readingTimeEstimate: {
          kind: "Present",
          value: { totalMinutes: 15, remainingMinutes: null },
        },
      }),
    ],
  ])("rejects an invalid estimate shape: %s", (_name, entry) => {
    expect(() => decodeLibraryReadingTimeEntry(entry)).toThrow();
  });

  it("rejects remaining time above total time", () => {
    expect(() =>
      decodeLibraryReadingTimeEntry(
        mediaEntry({
          media: {
            ...mediaEntry().media,
            read_state: "in_progress",
            progress_fraction: 0.5,
          },
          readingTimeEstimate: {
            kind: "Present",
            value: {
              totalMinutes: 10,
              remainingMinutes: { kind: "Present", value: 11 },
            },
          },
        }),
      ),
    ).toThrow(/must not exceed/);
  });
});

describe("reading-time presentation", () => {
  it.each([
    [1, "1 min"],
    [59, "59 min"],
    [60, "1 hr"],
    [75, "1 hr 15 min"],
    [120, "2 hr"],
    [2_147_483_647, "35791394 hr 7 min"],
  ])("formats %i minutes as %s", (minutes, expected) => {
    expect(
      readingTimeSignal(estimate(minutes), {
        processing_status: "ready_for_reading",
        read_state: "unread",
        capabilities: { can_quote: true },
      }),
    ).toBe(`≈ ${expected} read`);
  });

  it("uses remaining only for the current in-progress state", () => {
    const present: ReadingTimeEstimatePresence = {
      kind: "Present",
      value: {
        totalMinutes: 15,
        remainingMinutes: { kind: "Present", value: 5 },
      },
    };
    const media = {
      kind: "web_article" as const,
      processing_status: "ready_for_reading" as const,
      read_state: "in_progress" as const,
      capabilities: { can_quote: true },
    };
    expect(readingTimeSignal(present, media)).toBe("≈ 5 min left");
    expect(
      readingTimeSignal(present, { ...media, read_state: "finished" }),
    ).toBe("≈ 15 min read");
    expect(
      readingTimeSignal(present, { ...media, read_state: "unread" }),
    ).toBe("≈ 15 min read");
  });

  it("suppresses absent or currently ineligible estimates", () => {
    const present = estimate();
    const media = {
      kind: "web_article" as const,
      processing_status: "ready_for_reading" as const,
      read_state: "unread" as const,
      capabilities: { can_quote: true },
    };
    expect(readingTimeSignal(absent, media)).toBeNull();
    expect(
      readingTimeSignal(present, {
        ...media,
        processing_status: "extracting",
      }),
    ).toBeNull();
    expect(
      readingTimeSignal(present, {
        ...media,
        capabilities: { can_quote: false },
      }),
    ).toBeNull();
  });
});
