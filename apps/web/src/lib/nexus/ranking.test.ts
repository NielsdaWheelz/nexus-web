import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  nexusEntryKeyValue,
  type NexusEntry,
  type NexusEntryKey,
  type NexusRankTier,
} from "./model";
import { nexusTextRankTier, rankNexusEntries } from "./ranking";

function entry(input: {
  key: NexusEntryKey;
  tier: NexusRankTier;
  score?: number;
  frecency?: number;
}): NexusEntry {
  return {
    key: input.key,
    historySource: "Search",
    label: nexusEntryKeyValue(input.key),
    icon: FileText,
    primaryAction: {
      id: "open",
      label: "Open",
      icon: FileText,
      activation: { kind: "Standard" },
      availability: {
        kind: "Available",
        target: { kind: "InternalHref", href: "/notes" },
      },
    },
    secondaryActions: [],
    rank: {
      tier: input.tier,
      score: input.score ?? 0,
      frecency: input.frecency ?? 0,
    },
  };
}

describe("Nexus ranking", () => {
  it("gives every closed key variant a stable, disjoint renderer identity", () => {
    const cases: readonly (readonly [NexusEntryKey, string])[] = [
      [{ kind: "Pane", paneId: "a" }, "Pane:a"],
      [{ kind: "PaneSearch" }, "PaneSearch"],
      [{ kind: "Destination", destinationId: "notes" }, "Destination:notes"],
      [{ kind: "Resource", occurrenceRef: "page:1" }, "Resource:page:1"],
      [
        { kind: "QuickAction", actionId: "Nexus.Quick.Note" },
        "QuickAction:Nexus.Quick.Note",
      ],
      [
        { kind: "ImportUrl", normalizedUrl: "https://example.com/" },
        "ImportUrl:https://example.com/",
      ],
      [{ kind: "Intent", id: "Browse.Podcast" }, "Intent:Browse.Podcast"],
      [{ kind: "ManageTabs" }, "ManageTabs"],
      [{ kind: "Continuation", id: "AddToToday" }, "Continuation:AddToToday"],
    ];
    const values = cases.map(([key, expected]) => {
      expect(nexusEntryKeyValue(key)).toBe(expected);
      return expected;
    });
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps all six semantic tiers authoritative over score and frecency", () => {
    const tiers: readonly NexusRankTier[] = [
      "ExplicitIntent",
      "Exact",
      "PrefixOrToken",
      "CurrentContext",
      "FuzzyOrSynonym",
      "MetadataOrFullText",
    ];
    const entries = tiers.map((tier, index) =>
      entry({
        key: { kind: "Resource", occurrenceRef: `${index}` },
        tier,
        score: index === tiers.length - 1 ? 1 : 0,
        frecency: index === tiers.length - 1 ? 1 : 0,
      }),
    );

    expect(rankNexusEntries([...entries].reverse()).map((value) => value.rank.tier)).toEqual(
      tiers,
    );
  });

  it("uses normalized score, href frecency, source order, then semantic key", () => {
    const entries = [
      entry({
        key: { kind: "Resource", occurrenceRef: "lower-score" },
        tier: "MetadataOrFullText",
        score: 0.6,
        frecency: 1,
      }),
      entry({
        key: { kind: "Resource", occurrenceRef: "b" },
        tier: "MetadataOrFullText",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Pane", paneId: "pane-a" },
        tier: "MetadataOrFullText",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Resource", occurrenceRef: "a" },
        tier: "MetadataOrFullText",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Destination", destinationId: "lower-frecency" },
        tier: "MetadataOrFullText",
        score: 0.7,
        frecency: 0.7,
      }),
    ];

    expect(rankNexusEntries(entries).map((value) => nexusEntryKeyValue(value.key))).toEqual([
      "Pane:pane-a",
      "Resource:a",
      "Resource:b",
      "Destination:lower-frecency",
      "Resource:lower-score",
    ]);
  });

  it("rejects invalid normalized score or frecency even for a singleton", () => {
    expect(() =>
      rankNexusEntries([
        entry({
          key: { kind: "Resource", occurrenceRef: "bad-score" },
          tier: "MetadataOrFullText",
          score: Number.NaN,
        }),
      ]),
    ).toThrow(/score must be finite and normalized/);
    expect(() =>
      rankNexusEntries([
        entry({
          key: { kind: "Resource", occurrenceRef: "bad-frecency" },
          tier: "MetadataOrFullText",
          frecency: 1.01,
        }),
      ]),
    ).toThrow(/frecency must be finite and normalized/);
  });

  it.each([
    [
      { query: "ask why", label: "Ask Nexus", explicitIntent: true },
      "ExplicitIntent",
    ],
    [{ query: "notes", label: "Notes" }, "Exact"],
    [{ query: "set", label: "Reader Settings" }, "PrefixOrToken"],
    [
      {
        query: "/daily",
        label: "Today",
        aliases: ["/daily"],
        currentContext: true,
      },
      "CurrentContext",
    ],
    [{ query: "journal", label: "Notes", aliases: ["journal"] }, "FuzzyOrSynonym"],
    [
      { query: "author", label: "A story", metadata: ["An author"] },
      "MetadataOrFullText",
    ],
    [{ query: "unmatched", label: "A story", fullText: true }, "MetadataOrFullText"],
  ] as const)("classifies text match %# in its product tier", (input, expected) => {
    expect(nexusTextRankTier(input)).toBe(expected);
  });

  it("does not admit an unmatched current tab or local entry", () => {
    expect(
      nexusTextRankTier({
        query: "unmatched",
        label: "Open page",
        currentContext: true,
      }),
    ).toBeNull();
  });
});
