import { describe, expect, it } from "vitest";
import { absent } from "@/lib/api/presence";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  RESULT_TYPE_VALUES,
  type SearchResultRowViewModel,
} from "@/lib/search/types";
import {
  QUICK_ACTION_REGISTRY,
  SWITCHBOARD_QUICK_ACTION_IDS,
} from "./quickActions";
import {
  buildNexusZeroState,
  commitNexusRevision,
  composeNexusFindEntries,
  mergeProgressiveNexusEntries,
  parseNexusFindQuery,
  projectNexusLocalEntries,
  projectNexusOpenableEntries,
  projectNexusSearchEntries,
  type NexusPane,
} from "./results";
import { serializeNexusEntryKey } from "./ranking";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function pane(id: string, href = `/pages/${id}`): NexusPane {
  return {
    id,
    href,
    visibility: "visible",
    label: `Pane ${id}`,
    current: id === "a",
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

const quickActions = SWITCHBOARD_QUICK_ACTION_IDS.map(
  (id) => QUICK_ACTION_REGISTRY[id],
);

describe("Nexus result composition", () => {
  it("caps open/recent navigation together and appends exactly Chat, Note, Page, Import", () => {
    const entries = buildNexusZeroState({
      panes: ["a", "b", "c", "d"].map((id) => pane(id)),
      recent: [
        {
          target_href: "/notes",
          label_snapshot: "Notes",
          source: "Recent",
          last_used_at: "2026-07-29T00:00:00Z",
        },
        {
          target_href: "/libraries",
          label_snapshot: "Libraries",
          source: "Recent",
          last_used_at: "2026-07-28T00:00:00Z",
        },
      ],
      frecencyByHref: {},
      quickActions,
    });

    expect(entries.slice(0, 5).map((entry) => entry.label)).toEqual([
      "Pane a",
      "Pane b",
      "Pane c",
      "Pane d",
      "Notes",
    ]);
    expect(entries.slice(5).map((entry) => entry.label)).toEqual([
      "New Chat",
      "New Note",
      "New Page",
      "Import",
    ]);
  });

  it("deduplicates open and recent targets by canonical activation route", () => {
    const entries = buildNexusZeroState({
      panes: [pane("notes", "/notes#section")],
      recent: [
        {
          target_href: "/notes",
          label_snapshot: "Recent notes",
          source: "Recent",
          last_used_at: "2026-07-29T00:00:00Z",
        },
      ],
      frecencyByHref: {},
      quickActions,
    });

    expect(entries.some((entry) => entry.label === "Recent notes")).toBe(
      false,
    );
  });

  it("parses a bare URL once and pre-fills Add without ingesting", () => {
    const parsed = parseNexusFindQuery("https://example.com/story");
    const entries = projectNexusLocalEntries({
      query: parsed.text,
      panes: [],
      destinations: DESTINATIONS,
      quickActions,
      frecencyByHref: {},
    });
    const imported = entries.find(
      (entry) => entry.key.kind === "ImportUrl",
    );

    expect(imported?.rank.tier).toBe("Exact");
    expect(imported?.primaryAction.target).toEqual({
      kind: "OpenAdd",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
        initialUrlDraft: "https://example.com/story",
      },
    });
  });

  it("keeps every destination and registered quick capability reachable by prefix", () => {
    for (const destination of DESTINATIONS) {
      const entries = projectNexusLocalEntries({
        query: destination.label.slice(0, 1),
        panes: [],
        destinations: DESTINATIONS,
        quickActions,
        frecencyByHref: {},
      });
      expect(
        entries.some(
          (entry) =>
            entry.key.kind === "Destination" &&
            entry.key.destinationId === destination.id,
        ),
        destination.id,
      ).toBe(true);
    }
    for (const quickAction of Object.values(QUICK_ACTION_REGISTRY)) {
      const entries = projectNexusLocalEntries({
        query: quickAction.label.slice(0, 1),
        panes: [],
        destinations: DESTINATIONS,
        quickActions,
        frecencyByHref: {},
      });
      expect(
        entries.some(
          (entry) =>
            entry.key.kind === "QuickAction" &&
            entry.key.actionId === quickAction.id,
        ),
        quickAction.id,
      ).toBe(true);
    }
  });

  it("projects typed openables beginning at one character", () => {
    const ref = assumeCanonicalResourceRef(
      "page:55555555-5555-4555-8555-555555555555",
    );
    const item = {
      ref,
      scheme: "page",
      id: "55555555-5555-4555-8555-555555555555",
      label: "Alpha page",
      summary: "A typed openable",
      route: "/pages/55555555-5555-4555-8555-555555555555",
      activation: {
        resourceRef: ref,
        kind: "route",
        href: "/pages/55555555-5555-4555-8555-555555555555",
        unresolvedReason: null,
      },
      missing: false,
      capabilities: {
        userRelation: {
          userLinkSource: false,
          userLinkTarget: "none",
          noteReferenceTarget: false,
        },
        sharing: "None",
        libraryPlacement: "None",
        attachable: false,
        chatSubject: "none",
        readable: "none",
        inspectable: "none",
        citableResultType: null,
        citationOutputSource: false,
        appSearchScope: true,
        conversationSearchScope: false,
        promptRender: "none",
        expansionPolicy: "none",
        expandable: false,
        adjacencySource: false,
        adjacencyTarget: false,
      },
      versionByLane: {},
    } satisfies ResourceItem;

    expect(
      projectNexusOpenableEntries({
        query: "a",
        items: [item],
        panes: [],
      }),
    ).toHaveLength(1);
  });

  it("carries canonical Search score and keeps QueueAdd on queueable results", () => {
    const [entry] = projectNexusSearchEntries({
      query: "story",
      rows: [searchRow()],
      panes: [],
    });

    expect(entry?.rank.score).toBe(0.73);
    expect(
      entry?.secondaryActions.some(
        (candidate) => candidate.target.kind === "QueueAdd",
      ),
    ).toBe(true);
  });

  it.each(
    RESULT_TYPE_VALUES.filter((type) => type !== "web_result"),
  )("admits canonical owned result type %s", (type) => {
    const [entry] = projectNexusSearchEntries({
      query: "story",
      rows: [
        searchRow({
          type,
          typeLabel: type,
          mediaId:
            type === "media" || type === "episode" || type === "video"
              ? MEDIA_ID
              : null,
        }),
      ],
      panes: [],
    });

    expect(entry?.typeLabel).toBe(type);
  });

  it("defects if canonical Find admits a live Web result", () => {
    expect(() =>
      projectNexusSearchEntries({
        query: "story",
        rows: [searchRow({ type: "web_result" })],
        panes: [],
      }),
    ).toThrow(/live Web result/);
  });

  it("keeps fixed continuations after the capped owned results", () => {
    const local = projectNexusLocalEntries({
      query: "notes",
      panes: [],
      destinations: DESTINATIONS,
      quickActions,
      frecencyByHref: {},
    });
    const entries = composeNexusFindEntries({
      query: "notes",
      local,
      openables: [],
      search: [],
      ownedCap: 1,
    });

    expect(
      entries.slice(-3).map((entry) => serializeNexusEntryKey(entry.key)),
    ).toEqual([
      "Continuation:Ask",
      "Continuation:SearchWeb",
      "Continuation:SeeAll",
    ]);
    expect(entries.at(-2)?.primaryAction.target).toEqual({
      kind: "OpenWebSearch",
      query: "notes",
    });
  });

  it("keeps an actionable owner and deep child atomic across the owned cap", () => {
    const owner = searchRow({
      primaryText: "Owner article",
      sourceMeta: "Owner source",
      score: 0.1,
    });
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
    const search = projectNexusSearchEntries({
      query: "Exact story",
      rows: [child, owner],
      panes: [],
    });
    const entries = composeNexusFindEntries({
      query: "Exact story",
      local: [],
      openables: [],
      search,
      ownedCap: 1,
    }).filter((entry) => entry.key.kind === "Resource");

    expect(
      entries.map((entry) => serializeNexusEntryKey(entry.key)),
    ).toEqual([
      serializeNexusEntryKey({
        kind: "Resource",
        occurrenceRef: owner.resourceRef,
      }),
      serializeNexusEntryKey({
        kind: "Resource",
        occurrenceRef: childRef,
      }),
    ]);
    expect(entries[1]?.parent).toEqual({
      key: {
        kind: "Resource",
        occurrenceRef: owner.resourceRef,
      },
      label: "Owner article",
    });
  });

  it("retains an honest non-actionable owner group for ownerless deep rows", () => {
    const ownerRef = assumeCanonicalResourceRef(
      "media:33333333-3333-4333-8333-333333333333",
    );
    const childRef = assumeCanonicalResourceRef(
      "highlight:44444444-4444-4444-8444-444444444444",
    );
    const [entry] = projectNexusSearchEntries({
      query: "story",
      rows: [
        searchRow({
          key: "highlight-result",
          resourceRef: childRef,
          ownerResourceRef: ownerRef,
          sourceMeta: "Existing owner fact",
          type: "highlight",
          typeLabel: "Highlight",
          mediaId: null,
        }),
      ],
      panes: [],
    });

    expect(entry?.parent).toEqual({
      key: { kind: "Resource", occurrenceRef: ownerRef },
      label: "Existing owner fact",
    });
  });

  it("preserves the active identity and surviving prefix after user movement", () => {
    const initial = projectNexusLocalEntries({
      query: "n",
      panes: [pane("a"), pane("b")],
      destinations: DESTINATIONS,
      quickActions,
      frecencyByHref: {},
    }).slice(0, 3);
    const previous = {
      ...commitNexusRevision(initial),
      activeKey: serializeNexusEntryKey(initial[1]!.key),
    };
    const arriving = [initial[2]!, initial[0]!, initial[1]!];
    const merged = mergeProgressiveNexusEntries({
      previous,
      incoming: arriving,
      userMoved: true,
    });

    expect(
      merged.entries.map((entry) => serializeNexusEntryKey(entry.key)),
    ).toEqual([
      serializeNexusEntryKey(initial[0]!.key),
      serializeNexusEntryKey(initial[1]!.key),
      serializeNexusEntryKey(initial[2]!.key),
    ]);
    expect(merged.activeKey).toBe(
      serializeNexusEntryKey(initial[1]!.key),
    );
  });

  it("preserves user movement when same-query history arrives", () => {
    const initial = buildNexusZeroState({
      panes: [pane("a"), pane("b")],
      recent: [],
      frecencyByHref: {},
      quickActions,
    });
    const activeKey = serializeNexusEntryKey(initial[1]!.key);
    const previous = {
      entries: initial,
      activeKey,
    };
    const withHistory = buildNexusZeroState({
      panes: [pane("a"), pane("b")],
      recent: [
        {
          target_href: "/libraries",
          label_snapshot: "Libraries",
          source: "Recent",
          last_used_at: "2026-07-29T00:00:00Z",
        },
      ],
      frecencyByHref: { "/libraries": 0.8 },
      quickActions,
    });
    const merged = mergeProgressiveNexusEntries({
      previous,
      incoming: withHistory,
      userMoved: true,
    });

    expect(merged.activeKey).toBe(activeKey);
    expect(
      merged.entries
        .slice(0, 2)
        .map((entry) => serializeNexusEntryKey(entry.key)),
    ).toEqual(
      initial
        .slice(0, 2)
        .map((entry) => serializeNexusEntryKey(entry.key)),
    );
  });

  it("selects the same surviving index, or the preceding row, when active disappears", () => {
    const initial = projectNexusLocalEntries({
      query: "n",
      panes: [pane("a"), pane("b")],
      destinations: DESTINATIONS,
      quickActions,
      frecencyByHref: {},
    }).slice(0, 3);
    const previous = {
      entries: initial,
      activeKey: serializeNexusEntryKey(initial[2]!.key),
    };
    const incoming = initial.slice(0, 2);
    const merged = mergeProgressiveNexusEntries({
      previous,
      incoming,
      userMoved: true,
    });

    expect(merged.activeKey).toBe(
      serializeNexusEntryKey(incoming[1]!.key),
    );
  });
});
