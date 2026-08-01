import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import {
  nexusEntryKeyValue,
  type NexusEntry,
  type NexusEntryKey,
  type NexusRankTier,
} from "./model";
import { rankNexusEntries } from "./ranking";
import {
  commitNexusRevision,
  composeNexusProjection,
  mergeProgressiveNexusEntries,
  type NexusPane,
} from "./results";

const TIERS: readonly NexusRankTier[] = [
  "ExplicitIntent",
  "Exact",
  "PrefixOrToken",
  "CurrentContext",
  "FuzzyOrSynonym",
  "MetadataOrFullText",
];

function entry(
  id: string,
  input: {
    readonly tier?: NexusRankTier;
    readonly score?: number;
    readonly frecency?: number;
  } = {},
): NexusEntry {
  return {
    key: { kind: "Resource", occurrenceRef: id },
    historySource: "Search",
    label: id,
    icon: FileText,
    primaryAction: {
      id: "open",
      label: "Open",
      icon: FileText,
      activation: { kind: "Standard" },
      availability: {
        kind: "Available",
        target: { kind: "InternalHref", href: `/pages/${id}` },
      },
    },
    secondaryActions: [],
    rank: {
      tier: input.tier ?? "MetadataOrFullText",
      score: input.score ?? 0,
      frecency: input.frecency ?? 0,
    },
  };
}

function pane(id: string): NexusPane {
  return {
    id,
    href: `/pages/${id}`,
    visibility: "visible",
    label: `Pane ${id}`,
    current: id === "a",
  };
}

function projection(input: {
  readonly surface: "Desktop" | "Mobile";
  readonly query?: string;
  readonly panes?: readonly NexusPane[];
  readonly results?: readonly NexusEntry[];
  readonly activeKey?: NexusEntryKey | null;
  readonly todayAppend?:
    | { readonly kind: "Available" }
    | { readonly kind: "Unavailable"; readonly reason: string };
}) {
  return composeNexusProjection({
    surface: input.surface,
    query: input.query ?? "",
    panes: input.panes ?? [],
    currentPlayback: null,
    recent: [],
    destinations: DESTINATIONS,
    frecencyByHref: {},
    commandShortcutHints: {},
    results: input.results ?? [],
    activeKey: input.activeKey ?? null,
    todayAppend: input.todayAppend ?? { kind: "Available" },
  });
}

describe("Nexus ranking and projection", () => {
  it("orders semantic tiers before score and frecency tie-breakers", () => {
    const tiered = TIERS.map((tier, index) =>
      entry(`tier-${index}`, {
        tier,
        score: index === TIERS.length - 1 ? 1 : 0,
        frecency: index === TIERS.length - 1 ? 1 : 0,
      }),
    );
    expect(
      rankNexusEntries([...tiered].reverse()).map((value) => value.rank.tier),
    ).toEqual(TIERS);

    const tied = [
      entry("lower-score", { score: 0.6, frecency: 1 }),
      entry("lower-frecency", { score: 0.7, frecency: 0.7 }),
      entry("b", { score: 0.7, frecency: 0.8 }),
      entry("a", { score: 0.7, frecency: 0.8 }),
    ];
    expect(
      rankNexusEntries(tied).map((value) => nexusEntryKeyValue(value.key)),
    ).toEqual([
      "Resource:a",
      "Resource:b",
      "Resource:lower-frecency",
      "Resource:lower-score",
    ]);
  });

  it.each([
    ["Desktop", ["Open", "QuickActions"], "Flow"],
    ["Mobile", ["Open", "QuickActions", "Places"], "CompactRail"],
  ] as const)(
    "owns the blank %s group order, layout, and open-pane cap",
    (surface, groupIds, layout) => {
      const view = projection({
        surface,
        panes: ["a", "b", "c", "d", "e", "f", "g"].map(pane),
      });

      expect(view.groups.map((group) => group.id)).toEqual(groupIds);
      expect(view.groups.every((group) => group.layout === layout)).toBe(true);
      expect(view.groups[0]?.entries.map((candidate) => candidate.label)).toEqual([
        "Pane a",
        "Pane b",
        "Pane c",
        "Pane d",
        "Pane e",
        "Manage tabs…",
      ]);
    },
  );

  it.each([
    ["Desktop", ["Results", "QueryActions"]],
    ["Mobile", ["QueryActions", "Results"]],
  ] as const)(
    "keeps fixed %s query actions outside the eight-result cap",
    (surface, groupIds) => {
      const reason = "Today contains an atomic draft";
      const view = projection({
        surface,
        query: "Quantum Gardens",
        results: Array.from({ length: 9 }, (_, index) =>
          entry(`result-${index}`, { score: 1 - index / 10 }),
        ),
        todayAppend: { kind: "Unavailable", reason },
      });

      expect(view.groups.map((group) => group.id)).toEqual(groupIds);
      expect(
        view.groups.find((group) => group.id === "Results")?.entries,
      ).toHaveLength(8);
      const addToToday = view.groups
        .find((group) => group.id === "QueryActions")
        ?.entries.find((candidate) => candidate.label.startsWith("Add "));
      expect(addToToday?.primaryAction).toMatchObject({
        activation: { kind: "DailyTextHandoff" },
        availability: { kind: "Unavailable", reason },
      });
    },
  );

  it("reserves a user-moved prefix inside, never beyond, the result cap", () => {
    const previous = commitNexusRevision({
      normalizedQuery: "query",
      incoming: ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(
        (id) => entry(id),
      ),
      activeKey: { kind: "Resource", occurrenceRef: "d" },
    });
    const merged = mergeProgressiveNexusEntries({
      previous,
      normalizedQuery: "query",
      incoming: ["i", "j", "h", "g", "f", "e", "d", "c", "b", "a"].map(
        (id) => entry(id),
      ),
      userMoved: true,
    });

    expect(merged.entries.map((candidate) => candidate.label)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "i",
      "j",
      "h",
      "g",
    ]);
    expect(merged.entries).toHaveLength(8);
    expect(merged.activeKey).toEqual({
      kind: "Resource",
      occurrenceRef: "d",
    });
  });
});
