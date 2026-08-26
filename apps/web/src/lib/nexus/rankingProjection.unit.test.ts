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
  projectNexusLocalEntries,
  type NexusPane,
  type NexusRecentTarget,
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

function recent(id: string): NexusRecentTarget {
  return {
    target_href: `/pages/recent-${id}`,
    label_snapshot: `Recent ${id}`,
    source: "Nexus",
    last_used_at: "2026-08-26T00:00:00Z",
  };
}

function projection(input: {
  readonly surface: "Desktop" | "Mobile";
  readonly query?: string;
  readonly panes?: readonly NexusPane[];
  readonly currentPlayback?: NexusEntry | null;
  readonly recent?: readonly NexusRecentTarget[];
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
    currentPlayback: input.currentPlayback ?? null,
    recent: input.recent ?? [],
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
    [
      "Desktop",
      [
        ["Open", 6],
        ["Continue", 1],
        ["Recent", 4],
        ["QuickActions", 6],
      ],
    ],
    [
      "Mobile",
      [
        ["Open", 6],
        ["QuickActions", 6],
        ["Continue", 1],
        ["Recent", 4],
        ["Places", 6],
      ],
    ],
  ] as const)(
    "preserves the blank %s group order and caps",
    (surface, expectedGroups) => {
      const view = projection({
        surface,
        panes: ["a", "b", "c", "d", "e", "f", "g"].map(pane),
        currentPlayback: entry("Now playing"),
        recent: ["a", "b", "c", "d", "e", "f"].map(recent),
      });

      expect(
        view.groups.map((group) => [group.id, group.entries.length]),
      ).toEqual(expectedGroups);
      expect(view.groups[0]?.entries.map((candidate) => candidate.label)).toEqual([
        "Pane a",
        "Pane b",
        "Pane c",
        "Pane d",
        "Pane e",
        "Manage tabs…",
      ]);
      expect(
        view.groups
          .find((group) => group.id === "Recent")
          ?.entries.map((candidate) => candidate.label),
      ).toEqual(["Recent a", "Recent b", "Recent c", "Recent d"]);
    },
  );

  it.each(["Desktop", "Mobile"] as const)(
    "projects a non-URL %s query as capped Results followed by five Do with query actions",
    (surface) => {
      const rawQuery = "  Quantum Gardens  ";
      const trimmedQuery = "Quantum Gardens";
      const reason = "Today contains an atomic draft";
      const view = projection({
        surface,
        query: rawQuery,
        results: Array.from({ length: 9 }, (_, index) =>
          entry(`result-${index}`, { score: 1 - index / 10 }),
        ),
        todayAppend: { kind: "Unavailable", reason },
      });

      expect(
        view.groups.map(({ id, label }) => ({ id, label })),
      ).toEqual([
        { id: "Results", label: "Results" },
        { id: "QuickActions", label: "Do with query" },
      ]);
      expect(
        view.groups.find((group) => group.id === "Results")?.entries,
      ).toHaveLength(8);
      const queryActions = view.groups.find(
        (group) => group.id === "QuickActions",
      );
      expect(queryActions?.entries).toHaveLength(5);
      expect(view.groups.flatMap((group) => group.entries)).toHaveLength(13);

      const labels =
        queryActions?.entries.map((candidate) => candidate.label) ?? [];
      expect(labels).toEqual([
        `Ask Nexus about “${trimmedQuery}”`,
        `Add “${trimmedQuery}” to Today`,
        `Browse for “${trimmedQuery}”…`,
        `Create “${trimmedQuery}”…`,
        `See all results for “${trimmedQuery}”`,
      ]);
      expect(labels.map((label) => label.split(" ", 1)[0])).toEqual([
        "Ask",
        "Add",
        "Browse",
        "Create",
        "See",
      ]);
      expect(
        labels.map((label) => label.split(trimmedQuery).length - 1),
      ).toEqual([1, 1, 1, 1, 1]);
      expect(
        queryActions?.entries.map((candidate) =>
          (candidate.metadata ?? "").includes(trimmedQuery),
        ),
      ).toEqual([false, false, false, false, false]);

      const addToToday = view.groups
        .find((group) => group.id === "QuickActions")
        ?.entries.find((candidate) => candidate.label.startsWith("Add "));
      expect(addToToday?.primaryAction).toMatchObject({
        activation: { kind: "DailyTextHandoff" },
        availability: { kind: "Unavailable", reason },
      });
    },
  );

  it.each(["Desktop", "Mobile"] as const)(
    "keeps Do with query actions when a non-URL %s query has no Results",
    (surface) => {
      const view = projection({
        surface,
        query: "No owned matches",
      });

      expect(
        view.groups.map(({ id, label, entries }) => ({
          id,
          label,
          entryCount: entries.length,
        })),
      ).toEqual([
        { id: "QuickActions", label: "Do with query", entryCount: 5 },
      ]);
    },
  );

  it.each(["Desktop", "Mobile"] as const)(
    "projects a bare URL as the exact Import URL Result only on %s",
    (surface) => {
      const rawUrl = "  https://Example.com  ";
      const results = projectNexusLocalEntries({
        query: rawUrl,
        panes: [],
        destinations: DESTINATIONS,
        frecencyByHref: {},
        commandShortcutHints: {},
      });
      const view = projection({ surface, query: rawUrl, results });

      expect(
        view.groups.map(({ id, label }) => ({ id, label })),
      ).toEqual([{ id: "Results", label: "Results" }]);
      expect(view.groups[0]?.entries).toMatchObject([
        {
          key: {
            kind: "ImportUrl",
            normalizedUrl: "https://example.com/",
          },
          label: "Import URL",
          metadata: "https://example.com/",
        },
      ]);
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
