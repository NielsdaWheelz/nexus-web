import { describe, expect, it } from "vitest";
import {
  decodeActivation,
  decodeChapter,
  decodeConsumptionResult,
  decodeLecternItem,
  decodeLecternResult,
  decodeLecternSnapshot,
  decodeListeningState,
  decodeRecentConsumptionEnvelope,
  decodeRecentConsumptionItem,
  decodeRecentConsumptionSnapshot,
} from "./contract";
import { getRecentConsumption } from "./client";

const MEDIA_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "22222222-2222-2222-2222-222222222222";
const NEXT_ITEM_ID = "33333333-3333-3333-3333-333333333333";

function footerAudio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "FooterAudio",
    streamUrl: "https://cdn.example.com/a.mp3",
    sourceUrl: "https://example.com/a",
    positionMs: 1000,
    writeRevision: 3,
    resetEpoch: 0,
    playbackSpeed: 1.5,
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
    consumption: { state: "InProgress", progress: { kind: "Present", value: 0.4 } },
    activation: footerAudio(),
    ...overrides,
  };
}

function recentItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mediaId: MEDIA_ID,
    kind: "podcast_episode",
    title: "Recently heard",
    href: `/media/${MEDIA_ID}`,
    consumption: { state: "InProgress", progress: { kind: "Present", value: 0.4 } },
    lastEngagedAt: "2026-07-20T12:34:56.123456Z",
    playerDescriptor: {
      kind: "Present",
      value: {
        mediaId: MEDIA_ID,
        title: "Recently heard",
        subtitle: { kind: "Present", value: "A show" },
        activation: footerAudio(),
      },
    },
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

    it("rejects playback speed outside 0.25..3", () => {
      expect(() => decodeActivation(footerAudio({ playbackSpeed: 0.249 }))).toThrow();
      expect(() => decodeActivation(footerAudio({ playbackSpeed: 3.001 }))).toThrow();
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
      decodeLecternItem(item({ consumption: { state: "unread", progress: { kind: "Absent" } } })),
    ).toThrow();
  });

  it("rejects a progress fraction above 1 (bounds)", () => {
    expect(() =>
      decodeLecternItem(
        item({ consumption: { state: "InProgress", progress: { kind: "Present", value: 1.5 } } }),
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

describe("recent consumption decoders", () => {
  it("decodes the exact recent item and nested player descriptor contract", () => {
    const decoded = decodeRecentConsumptionItem(recentItem());
    expect(decoded.mediaId).toBe(MEDIA_ID);
    expect(decoded.kind).toBe("podcast_episode");
    expect(decoded.lastEngagedAt).toBe("2026-07-20T12:34:56.123456Z");
    expect(decoded.playerDescriptor.kind).toBe("Present");
  });

  it("decodes the exact data envelope", () => {
    expect(
      decodeRecentConsumptionEnvelope({ data: { items: [recentItem()] } }).items,
    ).toHaveLength(1);
  });

  it("rejects extra fields, invalid kinds, and non-timestamps", () => {
    expect(() => decodeRecentConsumptionItem(recentItem({ extra: true }))).toThrow();
    expect(() => decodeRecentConsumptionItem(recentItem({ kind: "audio" }))).toThrow();
    expect(() =>
      decodeRecentConsumptionItem(recentItem({ lastEngagedAt: "last Tuesday" })),
    ).toThrow();
  });

  it("rejects more than 50 recent rows", () => {
    expect(() =>
      decodeRecentConsumptionSnapshot({
        items: Array.from({ length: 51 }, () => recentItem()),
      }),
    ).toThrow();
  });

  it("rejects an out-of-contract request limit before transport", async () => {
    await expect(getRecentConsumption(51)).rejects.toThrow(
      "Invalid recent-consumption limit",
    );
  });
});

describe("decodeListeningState", () => {
  it("decodes a full listening state", () => {
    const decoded = decodeListeningState({
      positionMs: 42,
      durationMs: { kind: "Present", value: 100 },
      playbackSpeed: 1,
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
        playbackSpeed: 1,
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
  it("decodes a Removed outcome with nextItem and listeningStates", () => {
    const result = decodeConsumptionResult({
      outcome: { kind: "Removed", itemId: ITEM_ID, nextItemId: { kind: "Present", value: NEXT_ITEM_ID } },
      lectern: { items: [item({ itemId: NEXT_ITEM_ID })] },
      nextItem: { kind: "Present", value: item({ itemId: NEXT_ITEM_ID }) },
      listeningStates: [
        {
          mediaId: MEDIA_ID,
          state: {
            positionMs: 0,
            durationMs: { kind: "Absent" },
            playbackSpeed: 1,
            writeRevision: 1,
            resetEpoch: 1,
          },
        },
      ],
    });
    expect(result.outcome.kind).toBe("Removed");
    expect(result.nextItem.kind).toBe("Present");
    expect(result.listeningStates).toHaveLength(1);
    expect(result.listeningStates[0].mediaId).toBe(MEDIA_ID);
  });

  it("decodes a StateOnly outcome with an absent nextItem and empty states", () => {
    const result = decodeConsumptionResult({
      outcome: { kind: "StateOnly" },
      lectern: { items: [] },
      nextItem: { kind: "Absent" },
      listeningStates: [],
    });
    expect(result.outcome).toEqual({ kind: "StateOnly" });
    expect(result.nextItem).toEqual({ kind: "Absent" });
    expect(result.listeningStates).toEqual([]);
  });

  it("rejects a missing listeningStates field", () => {
    expect(() =>
      decodeConsumptionResult({
        outcome: { kind: "StateOnly" },
        lectern: { items: [] },
        nextItem: { kind: "Absent" },
      }),
    ).toThrow();
  });
});
