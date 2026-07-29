import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { NexusEntry, NexusEntryKey, NexusRankTier } from "./model";
import {
  nexusTextRankTier,
  rankNexusEntries,
  serializeNexusEntryKey,
} from "./ranking";

function entry(input: {
  key: NexusEntryKey;
  tier: NexusRankTier;
  score?: number;
  frecency?: number;
}): NexusEntry {
  return {
    key: input.key,
    historySource: "Search",
    label: serializeNexusEntryKey(input.key),
    icon: FileText,
    primaryAction: {
      id: "open",
      label: "Open",
      icon: FileText,
      target: { kind: "InternalHref", href: "/notes" },
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
  it("keeps lexical tiers authoritative over unrelated score and frecency", () => {
    const exact = entry({
      key: { kind: "Destination", destinationId: "notes" },
      tier: "Exact",
    });
    const fullText = entry({
      key: { kind: "Resource", occurrenceRef: "highlight:1" },
      tier: "FullText",
      score: 1,
      frecency: 1,
    });
    expect(rankNexusEntries([fullText, exact])).toEqual([exact, fullText]);
  });

  it("uses score, frecency, source order, then semantic key", () => {
    const entries = [
      entry({
        key: { kind: "Resource", occurrenceRef: "resource:lower-score" },
        tier: "Metadata",
        score: 0.6,
        frecency: 1,
      }),
      entry({
        key: { kind: "Resource", occurrenceRef: "resource:b" },
        tier: "Metadata",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Pane", paneId: "pane-a" },
        tier: "Metadata",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Resource", occurrenceRef: "resource:a" },
        tier: "Metadata",
        score: 0.7,
        frecency: 0.8,
      }),
      entry({
        key: { kind: "Destination", destinationId: "lower-frecency" },
        tier: "Metadata",
        score: 0.7,
        frecency: 0.7,
      }),
    ];
    expect(
      rankNexusEntries(entries).map((value) =>
        serializeNexusEntryKey(value.key),
      ),
    ).toEqual([
      "Pane:pane-a",
      "Resource:resource:a",
      "Resource:resource:b",
      "Destination:lower-frecency",
      "Resource:resource:lower-score",
    ]);
  });

  it("rejects an invalid normalized score or frecency even for a singleton", () => {
    expect(() =>
      rankNexusEntries([
        entry({
          key: { kind: "Resource", occurrenceRef: "bad-score" },
          tier: "FullText",
          score: Number.NaN,
        }),
      ]),
    ).toThrow(/score must be finite and normalized/);
    expect(() =>
      rankNexusEntries([
        entry({
          key: { kind: "Resource", occurrenceRef: "bad-frecency" },
          tier: "FullText",
          frecency: 1.01,
        }),
      ]),
    ).toThrow(/frecency must be finite and normalized/);
  });

  it("classifies exact, prefix, token, alias, open context, and fuzzy title", () => {
    expect(
      nexusTextRankTier({
        query: "notes",
        label: "Notes",
        fallback: "Metadata",
      }),
    ).toBe("Exact");
    expect(
      nexusTextRankTier({
        query: "note",
        label: "Notes",
        fallback: "Metadata",
      }),
    ).toBe("Prefix");
    expect(
      nexusTextRankTier({
        query: "set",
        label: "Reader Settings",
        fallback: "Metadata",
      }),
    ).toBe("Token");
    expect(
      nexusTextRankTier({
        query: "journal",
        label: "Notes",
        aliases: ["journal"],
        fallback: "Metadata",
      }),
    ).toBe("Alias");
    expect(
      nexusTextRankTier({
        query: "unmatched",
        label: "Open page",
        openContext: true,
        fallback: "Metadata",
      }),
    ).toBe("OpenContext");
    expect(
      nexusTextRankTier({
        query: "lbrs",
        label: "Libraries",
        fallback: "Metadata",
      }),
    ).toBe("FuzzyTitle");
  });
});
