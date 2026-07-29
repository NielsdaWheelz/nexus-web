import { describe, expect, it, vi } from "vitest";
import {
  decodeCollectionPage,
  decodeCollectionRevisionOut,
} from "@/lib/api/collectionPage";

describe("decodeCollectionPage", () => {
  it("decodes the exact page envelope and owned cursor presence", () => {
    const decodeItem = vi.fn((raw: unknown) => String(raw));

    expect(
      decodeCollectionPage(
        {
          data: {
            items: ["first", "second"],
            collectionRevision: 7,
            nextCursor: { kind: "Present", value: "cursor-2" },
          },
        },
        decodeItem,
      ),
    ).toEqual({
      items: ["first", "second"],
      collectionRevision: 7,
      nextCursor: { kind: "Present", value: "cursor-2" },
    });
    expect(decodeItem).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { data: { items: [], collectionRevision: 0 } },
    {
      data: {
        items: [],
        collectionRevision: -1,
        nextCursor: { kind: "Absent" },
      },
    },
    {
      data: {
        items: [],
        collectionRevision: 0,
        nextCursor: null,
      },
    },
    {
      data: {
        items: [],
        collectionRevision: 0,
        nextCursor: { kind: "Present", value: "" },
      },
    },
    {
      data: {
        items: [],
        collectionRevision: 0,
        nextCursor: { kind: "Absent" },
        extra: true,
      },
    },
  ])("reports malformed same-system data as a response defect", (raw) => {
    expect(() => decodeCollectionPage(raw, String)).toThrow(
      expect.objectContaining({
        code: "E_INVALID_RESPONSE",
        status: 200,
      }),
    );
  });

  it("decodes one strict mutation revision envelope", () => {
    expect(
      decodeCollectionRevisionOut({
        data: { collectionRevision: 9 },
      }),
    ).toBe(9);
    expect(() =>
      decodeCollectionRevisionOut({
        data: { collectionRevision: 9, legacy: true },
      }),
    ).toThrow(expect.objectContaining({ code: "E_INVALID_RESPONSE" }));
  });
});
