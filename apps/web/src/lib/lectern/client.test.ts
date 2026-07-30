import { describe, expect, it } from "vitest";
import {
  decodeActivation,
  decodeChapter,
  decodeConsumptionResult,
  decodeLecternItem,
  decodeLecternResult,
  decodeLecternSnapshot,
  decodeListeningState,
} from "./contract";

const MEDIA_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "22222222-2222-2222-2222-222222222222";
const NEXT_ITEM_ID = "33333333-3333-3333-3333-333333333333";
const PODCAST_ID = "44444444-4444-4444-4444-444444444444";

function footerAudio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "FooterAudio",
    streamUrl: "https://cdn.example.com/a.mp3",
    sourceUrl: "https://example.com/a",
    positionMs: 1000,
    writeRevision: 3,
    resetEpoch: 0,
    playbackRate: {
      value: 1.5,
      source: "Podcast",
      podcastPreference: {
        kind: "Present",
        value: {
          podcastId: PODCAST_ID,
          value: { kind: "Present", value: 1.5 },
        },
      },
    },
    durationMs: { kind: "Present", value: 60000 },
    artworkUrl: { kind: "Absent" },
    chapters: [{ title: "Intro", startMs: 0, endMs: { kind: "Present", value: 5000 } }],
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: ITEM_ID,
    mediaId: MEDIA_ID,
    kind: "podcast_episode",
    title: "A title",
    subtitle: { kind: "Present", value: "A subtitle" },
    href: "/media/abc",
    consumption: {
      state: "InProgress",
      progress: { kind: "Present", value: 0.4 },
      progressResettable: true,
    },
    activation: footerAudio(),
    ...overrides,
  };
}

describe("decodeActivation", () => {
  describe("acceptance", () => {
    it("decodes FooterAudio with Present and Absent presence fields", () => {
      const decoded = decodeActivation(footerAudio());
      expect(decoded.kind).toBe("FooterAudio");
      if (decoded.kind !== "FooterAudio") throw new Error("unreachable");
      expect(decoded.positionMs).toBe(1000);
      expect(decoded.playbackRate).toEqual({
        value: 1.5,
        source: "Podcast",
        podcastPreference: {
          kind: "Present",
          value: {
            podcastId: PODCAST_ID,
            value: { kind: "Present", value: 1.5 },
          },
        },
      });
      expect(decoded.durationMs).toEqual({ kind: "Present", value: 60000 });
      expect(decoded.artworkUrl).toEqual({ kind: "Absent" });
      expect(decoded.chapters).toHaveLength(1);
    });

    it("decodes Readable and OpenPane", () => {
      expect(decodeActivation({ kind: "Readable" })).toEqual({ kind: "Readable" });
      expect(decodeActivation({ kind: "OpenPane" })).toEqual({ kind: "OpenPane" });
    });
  });

  describe("rejection", () => {
    it("rejects a lowercase kind", () => {
      expect(() => decodeActivation(footerAudio({ kind: "footerAudio" }))).toThrow();
    });

    it("rejects an unknown activation kind", () => {
      expect(() => decodeActivation({ kind: "Video" })).toThrow();
    });

    it("rejects a missing required field", () => {
      const raw = footerAudio();
      delete raw.streamUrl;
      expect(() => decodeActivation(raw)).toThrow();
    });

    it("rejects an unknown extra key", () => {
      expect(() => decodeActivation(footerAudio({ extra: true }))).toThrow();
    });

    it("rejects null where a Presence field is required", () => {
      expect(() => decodeActivation(footerAudio({ durationMs: null }))).toThrow();
    });

    it("rejects a bare number where a Presence field is required", () => {
      expect(() => decodeActivation(footerAudio({ durationMs: 60000 }))).toThrow();
    });

    it("rejects a non-integer positionMs", () => {
      expect(() => decodeActivation(footerAudio({ positionMs: 10.5 }))).toThrow();
    });

    it("rejects negative and overflowing signed-32-bit integers", () => {
      expect(() => decodeActivation(footerAudio({ positionMs: -1 }))).toThrow();
      expect(() =>
        decodeActivation(footerAudio({ writeRevision: 2_147_483_648 })),
      ).toThrow();
      expect(() =>
        decodeActivation(
          footerAudio({ durationMs: { kind: "Present", value: 2_147_483_648 } }),
        ),
      ).toThrow();
    });

    it("rejects playback rate outside 0.5..3", () => {
      expect(() =>
        decodeActivation(
          footerAudio({
            playbackRate: {
              value: 0.499,
              source: "Episode",
              podcastPreference: { kind: "Absent" },
            },
          }),
        ),
      ).toThrow();
      expect(() =>
        decodeActivation(
          footerAudio({
            playbackRate: {
              value: 3.001,
              source: "Episode",
              podcastPreference: { kind: "Absent" },
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects a resolution whose source contradicts its preference", () => {
      expect(() =>
        decodeActivation(
          footerAudio({
            playbackRate: {
              value: 1,
              source: "Product",
              podcastPreference: {
                kind: "Present",
                value: {
                  podcastId: PODCAST_ID,
                  value: { kind: "Present", value: 1.5 },
                },
              },
            },
          }),
        ),
      ).toThrow();
      expect(() =>
        decodeActivation(
          footerAudio({
            playbackRate: {
              value: 1.25,
              source: "Podcast",
              podcastPreference: {
                kind: "Present",
                value: {
                  podcastId: PODCAST_ID,
                  value: { kind: "Present", value: 1.5 },
                },
              },
            },
          }),
        ),
      ).toThrow();
    });

    it("rejects more than 100 chapters (bounds)", () => {
      const chapters = Array.from({ length: 101 }, (_, index) => ({
        title: `c${index}`,
        startMs: index,
        endMs: { kind: "Absent" },
      }));
      expect(() => decodeActivation(footerAudio({ chapters }))).toThrow();
    });

    it("rejects a Readable activation carrying extra keys", () => {
      expect(() => decodeActivation({ kind: "Readable", extra: 1 })).toThrow();
    });
  });
});

describe("decodeChapter", () => {
  it("accepts a title at the 300-char bound", () => {
    const title = "x".repeat(300);
    expect(decodeChapter({ title, startMs: 0, endMs: { kind: "Absent" } }).title).toBe(title);
  });

  it("rejects an empty title (bounds)", () => {
    expect(() => decodeChapter({ title: "", startMs: 0, endMs: { kind: "Absent" } })).toThrow();
  });

  it("rejects a 301-char title (bounds)", () => {
    const title = "x".repeat(301);
    expect(() => decodeChapter({ title, startMs: 0, endMs: { kind: "Absent" } })).toThrow();
  });
});

describe("decodeLecternItem", () => {
  it("decodes a full item", () => {
    const decoded = decodeLecternItem(item());
    expect(decoded.itemId).toBe(ITEM_ID);
    expect(decoded.mediaId).toBe(MEDIA_ID);
    expect(decoded.kind).toBe("podcast_episode");
    expect(decoded.href).toBe("/media/abc");
    expect(decoded.consumption.state).toBe("InProgress");
  });

  it("rejects a non-UUID mediaId", () => {
    expect(() => decodeLecternItem(item({ mediaId: "not-a-uuid" }))).toThrow();
  });

  it("rejects an unknown media kind", () => {
    expect(() => decodeLecternItem(item({ kind: "audio" }))).toThrow();
  });

  it("rejects an href that does not start with a slash", () => {
    expect(() => decodeLecternItem(item({ href: "media/abc" }))).toThrow();
  });

  it("rejects protocol-relative and normalized href spellings", () => {
    expect(() => decodeLecternItem(item({ href: "//evil.example/media/abc" }))).toThrow();
    expect(() => decodeLecternItem(item({ href: "/media/../lectern" }))).toThrow();
    expect(() => decodeLecternItem(item({ href: "/media\\abc" }))).toThrow();
  });

  it("rejects a lowercase consumption state", () => {
    expect(() =>
      decodeLecternItem(
        item({
          consumption: {
            state: "unread",
            progress: { kind: "Absent" },
            progressResettable: false,
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects a progress fraction above 1 (bounds)", () => {
    expect(() =>
      decodeLecternItem(
        item({
          consumption: {
            state: "InProgress",
            progress: { kind: "Present", value: 1.5 },
            progressResettable: true,
          },
        }),
      ),
    ).toThrow();
  });

  it("requires a strict boolean progressResettable projection", () => {
    expect(() =>
      decodeLecternItem(
        item({
          consumption: {
            state: "Unread",
            progress: { kind: "Absent" },
            progressResettable: "false",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeLecternItem(
        item({
          consumption: {
            state: "Unread",
            progress: { kind: "Absent" },
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects an unknown extra key on the item", () => {
    expect(() => decodeLecternItem(item({ extra: 1 }))).toThrow();
  });
});

describe("decodeLecternSnapshot", () => {
  it("decodes a snapshot with mixed activations", () => {
    const snapshot = decodeLecternSnapshot({
      items: [
        item(),
        item({ itemId: NEXT_ITEM_ID, activation: { kind: "Readable" } }),
        item({ itemId: MEDIA_ID, activation: { kind: "OpenPane" } }),
      ],
    });
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items[1].activation).toEqual({ kind: "Readable" });
  });

  it("rejects a non-array items field", () => {
    expect(() => decodeLecternSnapshot({ items: {} })).toThrow();
  });

  it("rejects a missing items field", () => {
    expect(() => decodeLecternSnapshot({})).toThrow();
  });
});

describe("decodeListeningState", () => {
  it("decodes a full listening state", () => {
    const decoded = decodeListeningState({
      positionMs: 42,
      durationMs: { kind: "Present", value: 100 },
      episodePlaybackRate: { kind: "Present", value: 1 },
      writeRevision: 7,
      resetEpoch: 2,
    });
    expect(decoded.positionMs).toBe(42);
    expect(decoded.writeRevision).toBe(7);
  });

  it("rejects a non-integer writeRevision", () => {
    expect(() =>
      decodeListeningState({
        positionMs: 0,
        durationMs: { kind: "Absent" },
        episodePlaybackRate: { kind: "Present", value: 1 },
        writeRevision: 1.2,
        resetEpoch: 0,
      }),
    ).toThrow();
  });
});

describe("decodeLecternResult", () => {
  it("decodes a Placed outcome with the fresh snapshot", () => {
    const result = decodeLecternResult({
      outcome: { kind: "Placed", itemIds: [ITEM_ID] },
      lectern: { items: [item()] },
    });
    expect(result.outcome).toEqual({ kind: "Placed", itemIds: [ITEM_ID] });
    expect(result.lectern.items).toHaveLength(1);
  });

  it("decodes a Removed outcome", () => {
    const result = decodeLecternResult({
      outcome: { kind: "Removed", itemId: ITEM_ID },
      lectern: { items: [] },
    });
    expect(result.outcome).toEqual({ kind: "Removed", itemId: ITEM_ID });
  });

  it("rejects an unknown outcome kind", () => {
    expect(() =>
      decodeLecternResult({ outcome: { kind: "Nope" }, lectern: { items: [] } }),
    ).toThrow();
  });
});

describe("decodeConsumptionResult", () => {
  it("decodes a ResetProgress result with one installable progress state", () => {
    const result = decodeConsumptionResult({
      outcome: { kind: "StateOnly" },
      lectern: { items: [item()] },
      nextItem: { kind: "Absent" },
      completionHandle: { kind: "Absent" },
      libraryEntriesCollectionRevision: 9,
      progressState: {
        kind: "Present",
        value: {
          mediaId: MEDIA_ID,
          readerCursor: { state: "Empty", revision: 4 },
          listeningState: {
            kind: "Present",
            value: {
            positionMs: 0,
            durationMs: { kind: "Absent" },
            episodePlaybackRate: { kind: "Absent" },
            writeRevision: 1,
            resetEpoch: 1,
            },
          },
        },
      },
    });
    expect(result.outcome).toEqual({ kind: "StateOnly" });
    expect(result.progressState).toEqual({
      kind: "Present",
      value: expect.objectContaining({
        mediaId: MEDIA_ID,
        readerCursor: { state: "Empty", revision: 4 },
      }),
    });
  });

  it("decodes a StateOnly result with an absent progress state", () => {
    const result = decodeConsumptionResult({
      outcome: { kind: "StateOnly" },
      lectern: { items: [] },
      nextItem: { kind: "Absent" },
      progressState: { kind: "Absent" },
      completionHandle: { kind: "Absent" },
      libraryEntriesCollectionRevision: 10,
    });
    expect(result.outcome).toEqual({ kind: "StateOnly" });
    expect(result.nextItem).toEqual({ kind: "Absent" });
    expect(result.progressState).toEqual({ kind: "Absent" });
  });

  it("rejects an unexpected result field", () => {
    expect(() =>
      decodeConsumptionResult({
        outcome: { kind: "StateOnly" },
        lectern: { items: [] },
        nextItem: { kind: "Absent" },
        progressState: { kind: "Absent" },
        completionHandle: { kind: "Absent" },
        libraryEntriesCollectionRevision: 11,
        unexpected: [],
      }),
    ).toThrow();
  });
});
