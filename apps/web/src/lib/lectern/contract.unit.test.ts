import { describe, expect, it } from "vitest";
import { decodeLecternItem } from "@/lib/lectern/contract";

/**
 * Risk: the Lectern wire contract carries the membership instant every Added
 * view sorts by. A decoder that tolerated a missing or unparseable `addedAt`
 * would let a server/schema mismatch reach the pane as a silently wrong order.
 */

const MEDIA_ID = "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";
const ITEM_ID = "8b7c6d5e-4f30-4a21-9b8c-7d6e5f4a3b21";

function wireItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: ITEM_ID,
    mediaId: MEDIA_ID,
    kind: "web_article",
    title: "A queued article",
    subtitle: { kind: "Absent" },
    href: `/media/${MEDIA_ID}`,
    addedAt: "2025-11-17T21:05:45+00:00",
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
    activation: { kind: "Readable" },
    ...overrides,
  };
}

function withoutKey(key: string): Record<string, unknown> {
  const item = wireItem();
  delete item[key];
  return item;
}

describe("Lectern item decoder", () => {
  it("exposes the membership instant the server recorded for the row", () => {
    expect(decodeLecternItem(wireItem()).addedAt).toBe("2025-11-17T21:05:45+00:00");
  });

  it("accepts the UTC `Z` spelling of the same aware instant", () => {
    expect(
      decodeLecternItem(wireItem({ addedAt: "2025-11-17T21:05:45.123456Z" })).addedAt,
    ).toBe("2025-11-17T21:05:45.123456Z");
  });

  it("rejects a payload that omits addedAt", () => {
    expect(() => decodeLecternItem(withoutKey("addedAt"))).toThrow(
      /LecternItemOut must contain exactly/,
    );
  });

  it.each([
    ["a local timestamp with no offset", "2025-11-17T21:05:45"],
    ["a date without a time of day", "2025-11-17"],
    ["an out-of-range month", "2025-13-17T21:05:45Z"],
    ["an out-of-range hour", "2025-11-17T25:05:45Z"],
    ["a day past the end of its month", "2026-02-30T21:05:45Z"],
    ["hour 24 spelled as the next day's midnight", "2025-11-17T24:00:00Z"],
    ["an epoch-millisecond number", 1_763_413_545_000],
  ])("rejects %s as addedAt", (_case, addedAt) => {
    expect(() => decodeLecternItem(wireItem({ addedAt }))).toThrow(
      /LecternItemOut\.addedAt/,
    );
  });
});
