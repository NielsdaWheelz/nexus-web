import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { absent } from "@/lib/api/presence";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import {
  nexusEntryKeyValue,
  type NexusEntry,
  type NexusEntryKey,
  type NexusRankTier,
  type NexusTarget,
} from "./model";
import {
  commitNexusRevision,
  composeNexusProjection,
  composeNexusResultCandidates,
  mergeProgressiveNexusEntries,
  nexusBrowseChoiceActions,
  nexusCreateChoiceActions,
  parseNexusQuery,
  projectNexusCurrentPlaybackEntry,
  projectNexusLocalEntries,
  projectNexusPaneEntries,
  projectNexusSearchEntries,
  type NexusPane,
} from "./results";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function pane(
  id: string,
  input: { readonly label?: string; readonly href?: string } = {},
): NexusPane {
  return {
    id,
    href: input.href ?? `/pages/${id}`,
    visibility: "visible",
    label: input.label ?? `Pane ${id}`,
    current: id === "a",
  };
}

function availableTarget(entry: NexusEntry): NexusTarget {
  const availability = entry.primaryAction.availability;
  if (availability.kind !== "Available") {
    throw new Error(`Expected ${entry.label} to be available`);
  }
  return availability.target;
}

function resultEntry(input: {
  readonly id: string;
  readonly tier?: NexusRankTier;
  readonly score?: number;
  readonly frecency?: number;
  readonly parent?: NexusEntry["parent"];
}): NexusEntry {
  return {
    key: { kind: "Resource", occurrenceRef: input.id },
    historySource: "Search",
    label: input.id,
    typeLabel: "Page",
    icon: FileText,
    parent: input.parent,
    primaryAction: {
      id: "open",
      label: "Open",
      icon: FileText,
      activation: { kind: "Standard" },
      availability: {
        kind: "Available",
        target: { kind: "InternalHref", href: `/pages/${input.id}` },
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

function searchRow(
  overrides: Partial<SearchResultRowViewModel> = {},
): SearchResultRowViewModel {
  const ref = assumeCanonicalResourceRef(`media:${MEDIA_ID}`);
  const activation = {
    resourceRef: ref,
    kind: "route" as const,
    href: `/media/${MEDIA_ID}`,
    unresolvedReason: null,
  };
  return {
    key: "media-result",
    score: 0.73,
    resourceRef: ref,
    ownerResourceRef: ref,
    activation,
    actionTarget: {
      kind: "Resource",
      ref,
      activation,
      missing: false,
    },
    citationTarget: ref,
    paneLabelHint: "A story",
    type: "media",
    mediaId: MEDIA_ID,
    contextRef: null,
    typeLabel: "Article",
    primaryText: "A story",
    snippetSegments: [
      { text: "matched", emphasized: true },
      { text: " excerpt", emphasized: false },
    ],
    sourceMeta: "An author",
    publicationDate: absent(),
    contributorCredits: [],
    noteBody: null,
    noteOrigin: null,
    ...overrides,
  };
}

const EMPTY_SHORTCUTS = {};

function projection(input: {
  readonly surface: "Desktop" | "Mobile";
  readonly query?: string;
  readonly panes?: readonly NexusPane[];
  readonly currentPlayback?: NexusEntry | null;
  readonly recent?: readonly {
    readonly target_href: string;
    readonly label_snapshot: string;
    readonly source: string;
    readonly last_used_at: string;
  }[];
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
    commandShortcutHints: EMPTY_SHORTCUTS,
    results: input.results ?? [],
    activeKey: input.activeKey ?? null,
    todayAppend: input.todayAppend ?? { kind: "Available" },
  });
}

describe("Nexus semantic projection", () => {
  it("applies independent blank caps and the exact desktop/mobile group policy", () => {
    const panes = ["a", "b", "c", "d", "e", "f", "g"].map((id) => pane(id));
    const recent = ["notes", "libraries", "browse", "podcasts", "settings"].map(
      (id, index) => ({
        target_href: `/${id}`,
        label_snapshot: `Recent ${id}`,
        source: "Nexus",
        last_used_at: `2026-07-${29 - index}T00:00:00Z`,
      }),
    );
    const currentPlayback = projectNexusCurrentPlaybackEntry({
      label: "A story",
      metadata: "12 min left",
    });

    const desktop = projection({
      surface: "Desktop",
      panes,
      currentPlayback,
      recent,
    });
    expect(desktop.groups.map((group) => group.id)).toEqual([
      "Open",
      "Continue",
      "Recent",
      "QuickActions",
    ]);
    expect(desktop.groups.every((group) => group.layout === "Flow")).toBe(true);
    expect(desktop.groups[0]?.entries.map((entry) => entry.label)).toEqual([
      "Pane a",
      "Pane b",
      "Pane c",
      "Pane d",
      "Pane e",
      "Manage tabs…",
    ]);
    expect(desktop.groups[1]?.entries).toEqual([currentPlayback]);
    expect(desktop.groups[2]?.entries).toHaveLength(4);
    expect(desktop.groups[3]?.entries.map((entry) => entry.label)).toEqual([
      "Quick Note",
      "Today",
      "New Chat",
      "New Page",
      "New Library",
      "Import",
    ]);

    const mobile = projection({
      surface: "Mobile",
      panes,
      currentPlayback,
      recent,
    });
    expect(mobile.groups.map((group) => group.id)).toEqual([
      "Open",
      "QuickActions",
      "Continue",
      "Recent",
      "Places",
    ]);
    expect(mobile.groups.every((group) => group.layout === "CompactRail")).toBe(true);
    expect(mobile.groups[4]?.entries.map((entry) => entry.label)).toEqual([
      "Lectern",
      "Libraries",
      "Browse",
      "Podcasts",
      "Chats",
      "Notes",
    ]);
  });

  it("omits empty headings and deduplicates Recent against all open panes", () => {
    const view = projection({
      surface: "Desktop",
      panes: [pane("notes", { href: "/notes#section" })],
      recent: [
        {
          target_href: "/notes",
          label_snapshot: "Recent notes",
          source: "Nexus",
          last_used_at: "2026-07-29T00:00:00Z",
        },
      ],
    });

    expect(view.groups.map((group) => group.id)).toEqual(["Open", "QuickActions"]);
    expect(
      view.groups.flatMap((group) => group.entries).some((entry) => entry.label === "Recent notes"),
    ).toBe(false);
  });

  it("authors factual command teaching and a sole resumable Continue action", () => {
    const view = projection({ surface: "Desktop" });
    const quick = view.groups.find((group) => group.id === "QuickActions")!.entries;
    const note = quick.find((entry) => entry.label === "Quick Note")!;
    const page = quick.find((entry) => entry.label === "New Page")!;
    expect(note).toMatchObject({ typeLabel: "Command", metadata: "Create · /n" });
    expect(note.primaryAction).toMatchObject({
      activation: { kind: "DailyTextHandoff" },
      availability: {
        kind: "Available",
        target: {
          kind: "OpenDailyPage",
          entry: { kind: "AppendNote", initialText: "" },
        },
      },
    });
    expect(availableTarget(page)).toEqual({ kind: "CreatePage", titleDraft: "Untitled" });

    const playback = projectNexusCurrentPlaybackEntry({ label: "Episode 4" });
    expect(playback).toMatchObject({ typeLabel: "Media", label: "Episode 4" });
    expect(availableTarget(playback)).toEqual({ kind: "ResumeCurrentPlayback" });
  });

  it("renders fixed query actions outside the eight-result cap with honest availability", () => {
    const reason = "Open Today to finish the current embedded draft";
    const results = Array.from({ length: 9 }, (_, index) =>
      resultEntry({ id: `result-${index}`, score: 1 - index / 10 }),
    );
    const desktop = projection({
      surface: "Desktop",
      query: "Quantum Gardens",
      results,
      todayAppend: { kind: "Unavailable", reason },
    });

    expect(desktop.groups.map((group) => group.id)).toEqual(["Results", "QueryActions"]);
    expect(desktop.groups[0]?.entries).toHaveLength(8);
    const queryActions = desktop.groups[1]!;
    expect(queryActions).toMatchObject({
      label: "Do with query",
      layout: "Flow",
    });
    expect(queryActions.entries.map((entry) => [entry.label, entry.typeLabel, entry.metadata])).toEqual([
      ["Ask Nexus about “Quantum Gardens”", "Chat", "Ask Nexus"],
      ["Add “Quantum Gardens” to Today", "Today", "Append note"],
      ["Browse for “Quantum Gardens”…", "Browse", "Choose a kind"],
      ["Create “Quantum Gardens”…", "Create", "Choose a type"],
      ["See all results for “Quantum Gardens”", "Search", "All results"],
    ]);
    expect(queryActions.entries[1]?.primaryAction).toEqual({
      id: "add-to-today",
      label: "Add to Today",
      icon: FileText,
      activation: { kind: "DailyTextHandoff" },
      availability: { kind: "Unavailable", reason },
    });

    const mobile = projection({ surface: "Mobile", query: "Quantum Gardens", results });
    expect(mobile.groups.map((group) => group.id)).toEqual(["QueryActions", "Results"]);
    expect(mobile.groups[0]?.layout).toBe("PinnedBelowInput");
    expect(mobile.groups[1]?.layout).toBe("Flow");
    expect(mobile.activeKey).toEqual({ kind: "Continuation", id: "Ask" });
    expect(availableTarget(mobile.groups[0]!.entries[1]!)).toEqual({
      kind: "OpenDailyPage",
      date: { kind: "Today" },
      entry: { kind: "AppendNote", initialText: "Quantum Gardens" },
    });
  });

  it("keeps a bare URL exact, prefilled, and free of generic query actions", () => {
    const parsed = parseNexusQuery("https://example.com/story");
    const local = projectNexusLocalEntries({
      query: parsed.text,
      panes: [],
      destinations: DESTINATIONS,
      frecencyByHref: {},
      commandShortcutHints: EMPTY_SHORTCUTS,
    });
    const candidates = composeNexusResultCandidates({ local, openables: [], search: [] });
    const committed = commitNexusRevision({
      normalizedQuery: parsed.normalizedText,
      incoming: candidates,
      activeKey: null,
    });
    const view = projection({
      surface: "Desktop",
      query: parsed.text,
      results: committed.entries,
      activeKey: committed.activeKey,
    });

    expect(view.groups.map((group) => group.id)).toEqual(["Results"]);
    const imported = view.groups[0]!.entries[0]!;
    expect(imported).toMatchObject({
      label: "Import URL",
      typeLabel: "URL",
      metadata: "https://example.com/story",
      rank: { tier: "Exact" },
    });
    expect(availableTarget(imported)).toEqual({
      kind: "OpenAdd",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
        initialUrlDraft: "https://example.com/story",
      },
    });
  });

  it("keeps exact objects ahead of ordinary command keywords and generic Create", () => {
    const local = projectNexusLocalEntries({
      query: "page",
      panes: [pane("exact", { label: "Page" })],
      destinations: DESTINATIONS,
      frecencyByHref: {},
      commandShortcutHints: EMPTY_SHORTCUTS,
    });
    const candidates = composeNexusResultCandidates({ local, openables: [], search: [] });

    expect(candidates[0]?.key).toEqual({ kind: "Pane", paneId: "exact" });
    expect(candidates[0]?.rank.tier).toBe("Exact");
    expect(
      candidates.findIndex(
        (entry) =>
          entry.key.kind === "QuickAction" && entry.key.actionId === "Nexus.Quick.Page",
      ),
    ).toBeGreaterThan(0);

    const view = projection({ surface: "Desktop", query: "page", results: candidates });
    expect(view.groups.at(-1)?.entries[3]?.key).toEqual({
      kind: "Continuation",
      id: "Create",
    });
  });

  it.each(["a tale of two cities", "i robot", "c programming"])(
    "does not compile the named retrieval collision %s as explicit intent",
    (query) => {
      const local = projectNexusLocalEntries({
        query,
        panes: [],
        destinations: DESTINATIONS,
        frecencyByHref: {},
        commandShortcutHints: EMPTY_SHORTCUTS,
      });
      expect(local.some((entry) => entry.rank.tier === "ExplicitIntent")).toBe(false);
    },
  );

  it("projects one direct seeded result for reserved Create and Browse intent", () => {
    const page = projectNexusLocalEntries({
      query: "create page Dune Notes",
      panes: [],
      destinations: DESTINATIONS,
      frecencyByHref: {},
      commandShortcutHints: { "Nexus.Quick.Page": "Ctrl Shift P" },
    }).find((entry) => entry.rank.tier === "ExplicitIntent")!;
    expect(page).toMatchObject({
      label: "New Page",
      metadata: "Dune Notes",
      shortcutHint: "Ctrl Shift P",
    });
    expect(availableTarget(page)).toEqual({
      kind: "CreatePage",
      titleDraft: "Dune Notes",
    });

    const browse = projectNexusLocalEntries({
      query: "find podcast systems",
      panes: [],
      destinations: DESTINATIONS,
      frecencyByHref: {},
      commandShortcutHints: EMPTY_SHORTCUTS,
    }).find((entry) => entry.rank.tier === "ExplicitIntent")!;
    expect(availableTarget(browse)).toEqual({
      kind: "Browse",
      query: "systems",
      browseKind: "Podcast",
    });
  });

  it("authors the exact shared Create and Browse chooser actions with preserved seeds", () => {
    const create = nexusCreateChoiceActions("Seed Text");
    expect(create.map((candidate) => candidate.label)).toEqual([
      "Today Note",
      "Page",
      "Chat",
      "Library",
    ]);
    expect(
      create.map((candidate) => [candidate.activation.kind, candidate.availability]),
    ).toEqual([
      [
        "DailyTextHandoff",
        {
          kind: "Available",
          target: {
            kind: "OpenDailyPage",
            date: { kind: "Today" },
            entry: { kind: "AppendNote", initialText: "Seed Text" },
          },
        },
      ],
      [
        "Standard",
        { kind: "Available", target: { kind: "CreatePage", titleDraft: "Seed Text" } },
      ],
      [
        "Standard",
        {
          kind: "Available",
          target: { kind: "NewConversation", initialDraft: "Seed Text" },
        },
      ],
      [
        "Standard",
        {
          kind: "Available",
          target: { kind: "CreateLibrary", nameDraft: "Seed Text" },
        },
      ],
    ]);

    const browse = nexusBrowseChoiceActions("Seed Text");
    expect(browse.map((candidate) => candidate.label)).toEqual([
      "Articles",
      "Podcasts",
      "Videos",
      "Books",
    ]);
    expect(
      browse.map((candidate) =>
        candidate.availability.kind === "Available"
          ? candidate.availability.target
          : null,
      ),
    ).toEqual([
      { kind: "Browse", query: "Seed Text", browseKind: "WebArticle" },
      { kind: "Browse", query: "Seed Text", browseKind: "Podcast" },
      { kind: "Browse", query: "Seed Text", browseKind: "Video" },
      { kind: "Browse", query: "Seed Text", browseKind: "Epub" },
    ]);
  });

  it("never keeps a typed open tab whose label, route, or aliases do not match", () => {
    expect(
      projectNexusPaneEntries({
        query: "unrelated",
        panes: [pane("a", { label: "A page", href: "/pages/a" })],
        frecencyByHref: {},
      }),
    ).toEqual([]);
  });

  it("joins href frecency only to direct canonical Search owners", () => {
    const owner = searchRow();
    const childRef = assumeCanonicalResourceRef(
      "content_chunk:22222222-2222-4222-8222-222222222222",
    );
    const child = searchRow({
      key: "deep-result",
      resourceRef: childRef,
      ownerResourceRef: owner.resourceRef,
      primaryText: "Exact story",
      type: "content_chunk",
      typeLabel: "Passage",
      mediaId: MEDIA_ID,
      score: 1,
    });
    const entries = projectNexusSearchEntries({
      query: "story",
      rows: [child, owner],
      panes: [],
      frecencyByHref: { [`/media/${MEDIA_ID}`]: 0.91 },
    });
    const projectedOwner = entries.find(
      (entry) => nexusEntryKeyValue(entry.key) === `Resource:${owner.resourceRef}`,
    )!;
    const projectedChild = entries.find(
      (entry) => nexusEntryKeyValue(entry.key) === `Resource:${child.resourceRef}`,
    )!;

    expect(projectedOwner.rank).toMatchObject({ score: 0.73, frecency: 0.91 });
    expect(projectedChild.rank.frecency).toBe(0);
    expect(
      projectedOwner.secondaryActions.some(
        (candidate) =>
          candidate.availability.kind === "Available" &&
          candidate.availability.target.kind === "QueueAdd",
      ),
    ).toBe(true);
  });

  it("drops deep Search rows when neither canonical owner nor matching pane is present", () => {
    const owner = searchRow();
    const child = searchRow({
      key: "orphan-child",
      resourceRef: assumeCanonicalResourceRef(
        "content_chunk:22222222-2222-4222-8222-222222222222",
      ),
      ownerResourceRef: owner.resourceRef,
      primaryText: "Exact story passage",
      type: "content_chunk",
      typeLabel: "Passage",
    });

    expect(
      projectNexusSearchEntries({
        query: "exact story",
        rows: [child],
        panes: [
          pane("open-owner", {
            label: "Unrelated open media",
            href: `/media/${MEDIA_ID}`,
          }),
        ],
        frecencyByHref: {},
      }),
    ).toEqual([]);
  });

  it("defects if canonical Search admits a live Web result", () => {
    expect(() =>
      projectNexusSearchEntries({
        query: "story",
        rows: [searchRow({ type: "web_result" })],
        panes: [],
        frecencyByHref: {},
      }),
    ).toThrow(/live Web result/);
  });

  it("deduplicates semantic identity and strictly caps at a parent boundary", () => {
    const exact = Array.from({ length: 7 }, (_, index) =>
      resultEntry({ id: `exact-${index}`, tier: "Exact", score: 1 - index / 100 }),
    );
    const owner = resultEntry({ id: "owner", tier: "MetadataOrFullText" });
    const child = resultEntry({
      id: "child",
      tier: "PrefixOrToken",
      parent: { key: owner.key, label: owner.label },
    });
    const duplicateChild = { ...child, label: "Duplicate should lose" };
    const candidates = composeNexusResultCandidates({
      local: exact,
      openables: [child],
      search: [duplicateChild, owner],
    });
    const commit = commitNexusRevision({
      normalizedQuery: "query",
      incoming: candidates,
      activeKey: null,
    });

    expect(
      candidates
        .filter((entry) => nexusEntryKeyValue(entry.key) === "Resource:child")
        .map((entry) => entry.label),
    ).toEqual(["child"]);
    expect(commit.entries).toHaveLength(8);
    expect(commit.entries.filter((entry) => nexusEntryKeyValue(entry.key) === "Resource:child")).toHaveLength(
      0,
    );
    expect(commit.entries.at(-1)?.key).toEqual({ kind: "Resource", occurrenceRef: "owner" });
  });
});

describe("Nexus progressive stability", () => {
  const initial = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) =>
    resultEntry({ id }),
  );

  it("reserves the moved prefix inside, never beyond, eight slots", () => {
    const previous = commitNexusRevision({
      normalizedQuery: "query",
      incoming: initial,
      activeKey: { kind: "Resource", occurrenceRef: "d" },
    });
    const incoming = ["i", "j", "h", "g", "f", "e", "d", "c", "b", "a"].map(
      (id) => resultEntry({ id }),
    );
    const merged = mergeProgressiveNexusEntries({
      previous,
      normalizedQuery: "query",
      incoming,
      userMoved: true,
    });

    expect(merged.entries.map((entry) => entry.label)).toEqual([
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
    expect(merged.activeKey).toEqual({ kind: "Resource", occurrenceRef: "d" });
  });

  it("reserves only the active identity before explicit movement", () => {
    const previous = commitNexusRevision({
      normalizedQuery: "query",
      incoming: initial,
      activeKey: { kind: "Resource", occurrenceRef: "d" },
    });
    const incoming = ["i", "j", "h", "g", "f", "e", "d", "c", "b", "a"].map(
      (id) => resultEntry({ id }),
    );
    const merged = mergeProgressiveNexusEntries({
      previous,
      normalizedQuery: "query",
      incoming,
      userMoved: false,
    });

    expect(merged.entries.map((entry) => entry.label)).toEqual([
      "i",
      "j",
      "h",
      "g",
      "f",
      "e",
      "d",
      "c",
    ]);
    expect(merged.entries).toHaveLength(8);
    expect(merged.activeKey).toEqual({ kind: "Resource", occurrenceRef: "d" });
  });

  it("selects the nearest surviving index only when the active key disappears", () => {
    const previous = commitNexusRevision({
      normalizedQuery: "query",
      incoming: initial,
      activeKey: { kind: "Resource", occurrenceRef: "d" },
    });
    const incoming = ["a", "b", "c", "e", "f", "g", "h", "i"].map((id) =>
      resultEntry({ id }),
    );
    const merged = mergeProgressiveNexusEntries({
      previous,
      normalizedQuery: "query",
      incoming,
      userMoved: true,
    });

    expect(merged.entries.slice(0, 3).map((entry) => entry.label)).toEqual(["a", "b", "c"]);
    expect(merged.activeKey).toEqual({ kind: "Resource", occurrenceRef: "e" });
  });

  it("resets all stabilization on a normalized-query change", () => {
    const previous = commitNexusRevision({
      normalizedQuery: "old",
      incoming: initial,
      activeKey: { kind: "Resource", occurrenceRef: "d" },
    });
    const incoming = ["z", "a", "b", "c", "d"].map((id) => resultEntry({ id }));
    const merged = mergeProgressiveNexusEntries({
      previous,
      normalizedQuery: "new",
      incoming,
      userMoved: true,
    });

    expect(merged.entries[0]?.label).toBe("z");
    expect(merged.activeKey).toEqual({ kind: "Resource", occurrenceRef: "z" });
  });
});
