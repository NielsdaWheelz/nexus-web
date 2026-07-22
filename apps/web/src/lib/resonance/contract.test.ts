import { describe, expect, it } from "vitest";
import {
  decodeSlateEnvelope,
  type SlateItem,
} from "@/lib/resonance/contract";
import {
  presentSlateItem,
  presentSlateReason,
} from "@/lib/resonance/presentSlateItem";
import { mergeSlateAfterAdd } from "@/lib/resonance/useReadingSlate";

const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";

function wireItem(
  id: string,
  reason: Record<string, unknown> = {
    kind: "Continue",
    progress: { kind: "Present", value: 0.42 },
    lastEngagedAt: "2026-07-20T12:00:00Z",
  },
): Record<string, unknown> {
  return {
    target: {
      kind: "Media",
      ref: `media:${id}`,
      mediaKind: "pdf",
      title: `Title ${id.slice(0, 4)}`,
      subtitle: { kind: "Present", value: "A useful subtitle" },
      imageUrl: { kind: "Absent" },
      href: `/media/${id}`,
    },
    reason,
  };
}

function decodeItems(...items: Record<string, unknown>[]): SlateItem[] {
  return decodeSlateEnvelope({ data: { items } }).items;
}

describe("Resonance slate contract", () => {
  it.each([
    [
      {
        kind: "Continue",
        progress: { kind: "Present", value: 0.42 },
        lastEngagedAt: "2026-07-20T12:00:00Z",
      },
      "Continue where you left off",
    ],
    [{ kind: "AddedToNexus", addedAt: "2026-07-20T12:00:00Z" }, "Added to Nexus"],
    [{ kind: "Published", publishedOn: "2026-07-20" }, "Published"],
    [{ kind: "NewEpisode", publishedAt: "2026-07-20T12:00:00Z" }, "New episode"],
    [
      {
        kind: "Connected",
        anchor: { ref: `media:${MEDIA_B}`, label: "Anchor" },
        edgeOrigin: "citation",
      },
      "Connected with Anchor",
    ],
    [
      {
        kind: "SharedAuthor",
        anchor: { ref: `media:${MEDIA_B}`, label: "Anchor" },
        authorName: "Ada",
      },
      "Shared author · Ada · with Anchor",
    ],
    [
      {
        kind: "Similar",
        anchor: { ref: `media:${MEDIA_B}`, label: "Anchor" },
      },
      "Similar to Anchor",
    ],
  ])("decodes and exhaustively presents reason %#", (reason, expected) => {
    const [item] = decodeItems(wireItem(MEDIA_A, reason));
    expect(presentSlateReason(item.reason)).toBe(expected);
  });

  it.each(["Media", "Podcast"] as const)(
    "decodes the exact %s target variant",
    (kind) => {
      const raw = wireItem(MEDIA_A);
      if (kind === "Podcast") {
        raw.target = {
          kind,
          ref: `podcast:${MEDIA_A}`,
          title: "Podcast",
          subtitle: { kind: "Absent" },
          imageUrl: { kind: "Absent" },
          href: `/podcasts/${MEDIA_A}`,
        };
      }
      expect(decodeItems(raw)[0].target.kind).toBe(kind);
    },
  );

  it("strictly decodes an exact mixed-media envelope", () => {
    const snapshot = decodeSlateEnvelope({
      data: {
        items: [
          wireItem(MEDIA_A),
          {
            target: {
              kind: "Podcast",
              ref: `podcast:${MEDIA_B}`,
              title: "A podcast",
              subtitle: { kind: "Absent" },
              imageUrl: { kind: "Present", value: "https://example.com/p.jpg" },
              href: `/podcasts/${MEDIA_B}`,
            },
            reason: {
              kind: "Connected",
              anchor: { ref: `media:${MEDIA_A}`, label: "Anchor" },
              edgeOrigin: "synapse",
            },
          },
        ],
      },
    });

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[1].target.kind).toBe("Podcast");
    expect(presentSlateReason(snapshot.items[1].reason)).toBe(
      "Synapse · connected with Anchor",
    );
  });

  it("rejects unknown keys, invalid refs, duplicate refs, and more than ten", () => {
    expect(() =>
      decodeSlateEnvelope({ data: { items: [], legacy: true } }),
    ).toThrow(/expected keys/);
    expect(() =>
      decodeSlateEnvelope({
        data: { items: [wireItem(MEDIA_A), wireItem(MEDIA_A)] },
      }),
    ).toThrow(/duplicate ref/);
    expect(() =>
      decodeSlateEnvelope({
        data: { items: [wireItem("NOT-A-UUID")] },
      }),
    ).toThrow(/canonical ResourceRef/);
    expect(() =>
      decodeSlateEnvelope({
        data: {
          items: Array.from({ length: 11 }, (_, index) =>
            wireItem(`${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`),
          ),
        },
      }),
    ).toThrow(/at most 10/);
  });

  it.each([
    ["envelope unknown", { data: { items: [] }, extra: true }],
    ["envelope missing", {}],
    [
      "item unknown",
      { data: { items: [{ ...wireItem(MEDIA_A), extra: true }] } },
    ],
    [
      "item missing",
      { data: { items: [{ target: wireItem(MEDIA_A).target }] } },
    ],
    [
      "target unknown",
      {
        data: {
          items: [
            {
              ...wireItem(MEDIA_A),
              target: { ...(wireItem(MEDIA_A).target as object), extra: true },
            },
          ],
        },
      },
    ],
    [
      "target missing",
      {
        data: {
          items: [
            {
              ...wireItem(MEDIA_A),
              target: {
                kind: "Media",
                ref: `media:${MEDIA_A}`,
                mediaKind: "pdf",
                title: "Missing href",
                subtitle: { kind: "Absent" },
                imageUrl: { kind: "Absent" },
              },
            },
          ],
        },
      },
    ],
    [
      "reason unknown",
      {
        data: {
          items: [
            wireItem(MEDIA_A, {
              kind: "Published",
              publishedOn: "2026-07-20",
              extra: true,
            }),
          ],
        },
      },
    ],
    ["reason missing", { data: { items: [wireItem(MEDIA_A, { kind: "Published" })] } }],
  ])("rejects %s keys", (_name, raw) => {
    expect(() => decodeSlateEnvelope(raw)).toThrow();
  });

  it.each([
    [
      "invalid Presence",
      {
        ...wireItem(MEDIA_A),
        target: { ...(wireItem(MEDIA_A).target as object), subtitle: null },
      },
    ],
    [
      "progress outside 0..1",
      wireItem(MEDIA_A, {
        kind: "Continue",
        progress: { kind: "Present", value: 1.1 },
        lastEngagedAt: "2026-07-20T12:00:00Z",
      }),
    ],
    [
      "invalid date",
      wireItem(MEDIA_A, { kind: "Published", publishedOn: "2026-02-30" }),
    ],
    [
      "invalid instant",
      wireItem(MEDIA_A, {
        kind: "Continue",
        progress: { kind: "Absent" },
        lastEngagedAt: "yesterday",
      }),
    ],
    [
      "invalid href",
      {
        ...wireItem(MEDIA_A),
        target: {
          ...(wireItem(MEDIA_A).target as object),
          href: "https://evil.example/item",
        },
      },
    ],
    [
      "target/ref scheme mismatch",
      {
        ...wireItem(MEDIA_A),
        target: {
          ...(wireItem(MEDIA_A).target as object),
          ref: `podcast:${MEDIA_A}`,
        },
      },
    ],
  ])("rejects %s", (_name, invalidItem) => {
    expect(() => decodeSlateEnvelope({ data: { items: [invalidItem] } })).toThrow();
  });

  it.each([
    ["an impossible day", "2026-02-31T12:00:00Z"],
    ["a non-leap February 29", "2025-02-29T00:00:00Z"],
    ["hour 24", "2026-07-21T24:00:00Z"],
    ["year zero", "0000-01-01T00:00:00Z"],
  ])("rejects %s in an instant", (_name, lastEngagedAt) => {
    expect(() =>
      decodeItems(
        wireItem(MEDIA_A, {
          kind: "Continue",
          progress: { kind: "Absent" },
          lastEngagedAt,
        }),
      ),
    ).toThrow(/ISO 8601 instant/);
  });

  it.each([
    "2024-02-29T23:59:59.123+05:30",
    "2026-07-20T00:00:00-08:00",
  ])("accepts a valid offset instant: %s", (lastEngagedAt) => {
    const [item] = decodeItems(
      wireItem(MEDIA_A, {
        kind: "Continue",
        progress: { kind: "Absent" },
        lastEngagedAt,
      }),
    );

    expect(item.reason).toMatchObject({ lastEngagedAt });
  });

  it("presents the reason once with rich progress and no nested Related lookup", () => {
    const [item] = decodeItems(wireItem(MEDIA_A));
    const row = presentSlateItem(item);

    expect(row.id).toBe(`media:${MEDIA_A}`);
    expect(row.context).toEqual({
      kind: "Present",
      value: {
        kind: "Text",
        text: "A useful subtitle · Continue where you left off",
      },
    });
    expect(row.activity).toEqual({
      kind: "Present",
      value: {
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.42 } },
        remainingMinutes: { kind: "Absent" },
      },
    });
    expect(row.relatedMediaId).toEqual({ kind: "Absent" });
  });

  it.each([
    [
      { kind: "Published", publishedOn: "2026-07-20" },
      { kind: "Present", value: "2026-07-20" },
      "A useful subtitle · Published",
    ],
    [
      { kind: "NewEpisode", publishedAt: "2026-07-20T12:00:00Z" },
      { kind: "Present", value: "2026-07-20T12:00:00Z" },
      "A useful subtitle · New episode",
    ],
  ])("projects publication identity for %#", (reason, publicationDate, context) => {
    const [item] = decodeItems(wireItem(MEDIA_A, reason));
    const row = presentSlateItem(item);

    expect(row.publicationDate).toEqual(publicationDate);
    expect(row.context).toEqual({
      kind: "Present",
      value: { kind: "Text", text: context },
    });
  });

  it("keeps the reason when a target subtitle is absent", () => {
    const raw = wireItem(MEDIA_A);
    raw.target = {
      ...(raw.target as object),
      subtitle: { kind: "Absent" },
    };
    const row = presentSlateItem(decodeItems(raw)[0]);

    expect(row.context).toEqual({
      kind: "Present",
      value: { kind: "Text", text: "Continue where you left off" },
    });
  });
});

describe("stable slate refill", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    decodeItems(
      wireItem(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      ),
    )[0],
  );

  it.each([
    {
      name: "10 to 10",
      survivors: candidates.slice(1, 10),
      fresh: candidates.slice(1, 11),
      expected: candidates.slice(1, 11),
    },
    {
      name: "1 to 1",
      survivors: [],
      fresh: [candidates[1]],
      expected: [candidates[1]],
    },
    {
      name: "no newcomer",
      survivors: [candidates[1]],
      fresh: [candidates[0], candidates[1]],
      expected: [candidates[1]],
    },
    {
      name: "duplicate fresh refs",
      survivors: [candidates[1]],
      fresh: [candidates[2], candidates[2]],
      expected: [candidates[1], candidates[2]],
    },
    {
      name: "repeated accepted ref",
      survivors: [candidates[1]],
      fresh: [candidates[0], candidates[0], candidates[2]],
      expected: [candidates[1], candidates[2]],
    },
  ])("handles $name without replacing survivor objects", ({ survivors, fresh, expected }) => {
    const merged = mergeSlateAfterAdd(
      survivors,
      candidates[0].target.ref,
      fresh,
    );
    expect(merged).toEqual(expected);
    survivors.forEach((survivor, index) => expect(merged[index]).toBe(survivor));
    if (expected.length === survivors.length) expect(merged).toBe(survivors);
  });
});
