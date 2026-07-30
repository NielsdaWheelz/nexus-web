import { describe, expect, it, vi } from "vitest";
import type {
  Fragment,
  TranscriptChapter,
  TranscriptCoverage,
  TranscriptState,
} from "@/lib/media/transcriptView";
import {
  createTranscriptFindAdapter,
  createTranscriptFindSnapshot,
  type TranscriptFindSnapshot,
} from "./transcriptPaneFind";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

function fragment({
  id,
  idx,
  text,
  startMs,
  speaker,
}: {
  readonly id: string;
  readonly idx: number;
  readonly text: string;
  readonly startMs?: number | null;
  readonly speaker?: string | null;
}): Fragment {
  return {
    id,
    media_id: "media-1",
    idx,
    html_sanitized: `<p>${text}</p>`,
    canonical_text: text,
    document_embeds: [],
    t_start_ms: startMs,
    t_end_ms: startMs == null ? null : startMs + 1_000,
    speaker_label: speaker,
    created_at: `2026-07-${String(idx + 1).padStart(2, "0")}T00:00:00Z`,
  };
}

const CHAPTERS: readonly TranscriptChapter[] = [
  {
    chapter_idx: 0,
    title: "Opening",
    t_start_ms: 0,
    t_end_ms: 10_000,
  },
  {
    chapter_idx: 1,
    title: "Later",
    t_start_ms: 10_000,
    t_end_ms: null,
  },
];

function snapshot({
  transcriptState = "ready",
  transcriptCoverage = "full",
  fragments,
}: {
  readonly transcriptState?: TranscriptState;
  readonly transcriptCoverage?: TranscriptCoverage;
  readonly fragments: readonly Fragment[];
}): TranscriptFindSnapshot {
  return createTranscriptFindSnapshot({
    mediaId: "media-1",
    transcriptState,
    transcriptCoverage,
    fragments,
    chapters: CHAPTERS,
  });
}

function adapter(
  frozen: TranscriptFindSnapshot,
  activeFragmentId: string | null,
) {
  return createTranscriptFindAdapter({
    snapshot: frozen,
    getCurrentSourceKey: () => frozen.sourceKey,
    getActiveFragmentId: () => activeFragmentId,
    setActiveFragmentId: vi.fn(),
    getSegmentList: () => null,
    getMatchElement: () => null,
    publishPresentation: vi.fn(),
    previewLease: createMediaFindPreviewLease(),
  });
}

describe("Transcript pane Find", () => {
  it("freezes timeline order, prepares the exact chapter, and emits contextual range keys", async () => {
    const frozen = snapshot({
      fragments: [
        fragment({
          id: "later",
          idx: 1,
          text: "needle and needle",
          startMs: 12_000,
          speaker: "Bob",
        }),
        fragment({
          id: "opening",
          idx: 0,
          text: "first needle",
          startMs: 1_000,
          speaker: "Alice",
        }),
      ],
    });
    expect(frozen.fragments.map(({ id }) => id)).toEqual([
      "opening",
      "later",
    ]);
    expect(JSON.parse(frozen.sourceKey)).toEqual({
      kind: "Transcript",
      mediaId: "media-1",
      fragments: [
        {
          id: "opening",
          idx: 0,
          createdAt: "2026-07-01T00:00:00Z",
        },
        {
          id: "later",
          idx: 1,
          createdAt: "2026-07-02T00:00:00Z",
        },
      ],
    });
    const owner = adapter(frozen, "later");
    const signal = new AbortController().signal;
    const prepared = await owner.prepare({
      sessionId: 1,
      sourceKey: frozen.sourceKey,
      signal,
    });
    expect(prepared.scopes).toEqual([
      {
        kind: "EntireResource",
        id: "EntireTranscript",
        label: "Entire transcript",
      },
      {
        kind: "Narrow",
        id: "CurrentChapter:1",
        label: "This chapter",
      },
    ]);

    const entire = await owner.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: frozen.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntireTranscript",
      matchCase: false,
      wholeWord: true,
    });
    if (entire.kind !== "Ready") {
      throw new Error("Expected transcript results.");
    }
    expect(entire.rows.map(({ context }) => context)).toEqual([
      ["Opening", "00:00:01", "Alice"],
      ["Later", "00:00:12", "Bob"],
      ["Later", "00:00:12", "Bob"],
    ]);
    expect(entire.rows.map(({ key }) => JSON.parse(key))).toMatchObject([
      {
        source: {
          kind: "TranscriptFragment",
          mediaId: "media-1",
          fragmentId: "opening",
        },
        locator: {
          kind: "FragmentRange",
          fragmentId: "opening",
          startCp: 6,
          endCp: 12,
        },
      },
      {
        locator: {
          kind: "FragmentRange",
          fragmentId: "later",
          startCp: 0,
          endCp: 6,
        },
      },
      {
        locator: {
          kind: "FragmentRange",
          fragmentId: "later",
          startCp: 11,
          endCp: 17,
        },
      },
    ]);

    const currentChapter = await owner.find({
      sessionId: 1,
      queryId: 2,
      sourceKey: frozen.sourceKey,
      signal,
      query: "needle",
      scopeId: "CurrentChapter:1",
      matchCase: false,
      wholeWord: true,
    });
    expect(
      currentChapter.kind === "Ready"
        ? currentChapter.rows.map(({ context }) => context)
        : [],
    ).toEqual([
      ["Later", "00:00:12", "Bob"],
      ["Later", "00:00:12", "Bob"],
    ]);
  });

  it("reports partial zero and never matches a phrase across segments", async () => {
    const frozen = snapshot({
      transcriptState: "partial",
      transcriptCoverage: "partial",
      fragments: [
        fragment({ id: "one", idx: 0, text: "cross", startMs: 1_000 }),
        fragment({
          id: "two",
          idx: 1,
          text: "segment",
          startMs: 2_000,
        }),
      ],
    });
    const owner = adapter(frozen, "one");
    const signal = new AbortController().signal;
    await owner.prepare({
      sessionId: 1,
      sourceKey: frozen.sourceKey,
      signal,
    });

    await expect(
      owner.find({
        sessionId: 1,
        queryId: 1,
        sourceKey: frozen.sourceKey,
        signal,
        query: "cross segment",
        scopeId: "EntireTranscript",
        matchCase: false,
        wholeWord: false,
      }),
    ).resolves.toEqual({
      kind: "NoMatches",
      sessionId: 1,
      queryId: 1,
      sourceKey: frozen.sourceKey,
      completeness: "Partial",
    });
    await expect(
      owner.find({
        sessionId: 1,
        queryId: 2,
        sourceKey: frozen.sourceKey,
        signal,
        query: "missing",
        scopeId: "EntireTranscript",
        matchCase: false,
        wholeWord: false,
      }),
    ).resolves.toMatchObject({
      kind: "NoMatches",
      completeness: "Partial",
    });
  });

  it("omits chapter scope for an untimed active fragment and rejects unreadable state", async () => {
    const frozen = snapshot({
      fragments: [
        fragment({ id: "untimed", idx: 0, text: "needle", startMs: null }),
      ],
    });
    const owner = adapter(frozen, "untimed");
    await expect(
      owner.prepare({
        sessionId: 1,
        sourceKey: frozen.sourceKey,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      scopes: [
        {
          kind: "EntireResource",
          id: "EntireTranscript",
        },
      ],
    });
    expect(() =>
      createTranscriptFindSnapshot({
        mediaId: "media-1",
        transcriptState: "running",
        transcriptCoverage: "none",
        fragments: [],
        chapters: [],
      }),
    ).toThrow("requires a readable transcript");
  });
});
