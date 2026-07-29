import {
  FileText,
  Globe,
  Link as LinkIcon,
  MessageSquarePlus,
  PanelLeft,
  Search,
  X,
} from "lucide-react";
import { extractUrls } from "@/lib/extractUrls";
import type { Destination } from "@/lib/navigation/destinations";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { applyParsedInput, emptySearchQuery } from "@/lib/search/query";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import { searchHref } from "@/lib/search/searchParams";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { buildResourceNexusActions } from "./actions";
import type {
  NexusAction,
  NexusEntry,
  NexusEntryKey,
  NexusQuickAction,
  NexusRankTier,
} from "./model";
import { NEXUS_ZERO_STATE_ACTION_IDS } from "./quickActions";
import {
  nexusTextRankTier,
  rankNexusEntries,
  serializeNexusEntryKey,
} from "./ranking";

const OWNED_RESULT_CAP = 40;
const ZERO_STATE_NAVIGATION_CAP = 5;

export interface NexusPane {
  readonly id: string;
  readonly href: string;
  readonly visibility: "visible" | "minimized";
  readonly label: string;
  readonly current: boolean;
}

export interface NexusRecentTarget {
  readonly target_href: string;
  readonly label_snapshot: string;
  readonly source: string;
  readonly last_used_at: string;
}

function normalizedUrl(raw: string): string | null {
  const urls = extractUrls(raw);
  if (urls.length !== 1 || urls[0] !== raw.trim()) return null;
  return new URL(urls[0]).toString();
}

export function parseNexusFindQuery(raw: string) {
  const parsed = parseSearchInput(raw);
  return {
    text: parsed.text,
    searchQuery: applyParsedInput(emptySearchQuery(), parsed),
    importUrl: normalizedUrl(parsed.text),
  };
}

function action(
  id: string,
  label: string,
  icon: NexusAction["icon"],
  target: NexusAction["target"],
): NexusAction {
  return { id, label, icon, target };
}

function paneEntry(pane: NexusPane, tier: NexusRankTier): NexusEntry {
  return {
    key: { kind: "Pane", paneId: pane.id },
    historySource: "Workspace",
    label: pane.label,
    typeLabel: "Tab",
    metadata:
      pane.visibility === "minimized" ? "Minimized tab" : "Open tab",
    icon: getPaneRouteIcon(pane.href),
    openState: pane.current
      ? "Active"
      : pane.visibility === "minimized"
        ? "Minimized"
        : "Open",
    primaryAction: action("open", "Open", PanelLeft, {
      kind: "PaneOpen",
      paneId: pane.id,
    }),
    secondaryActions: [
      action("close", "Close tab", X, {
        kind: "PaneClose",
        paneId: pane.id,
      }),
    ],
    rank: { tier, score: pane.current ? 1 : 0, frecency: 0 },
  };
}

function recentEntry(
  recent: NexusRecentTarget,
  frecency: number,
): NexusEntry {
  return {
    key: {
      kind: "Resource",
      occurrenceRef: `Route:${recent.target_href}`,
    },
    historySource: "Recent",
    label: recent.label_snapshot,
    typeLabel: "Recent",
    metadata: recent.target_href,
    icon: getPaneRouteIcon(recent.target_href),
    primaryAction: action("open", "Open", getPaneRouteIcon(recent.target_href), {
      kind: "InternalHref",
      href: recent.target_href,
      labelHint: recent.label_snapshot,
    }),
    secondaryActions: [],
    rank: { tier: "OpenContext", score: 0, frecency },
  };
}

function quickActionTarget(quickAction: NexusQuickAction): NexusAction["target"] {
  switch (quickAction.target.kind) {
    case "TodayCapture":
      return { kind: "OpenTodayCapture" };
    case "CreatePage":
      return { kind: "CreatePage" };
    case "CreateChat":
      return { kind: "NewConversation" };
    case "CreateLibrary":
      return { kind: "CreateLibrary" };
    case "Import":
      return { kind: "OpenAdd", seed: quickAction.target.seed };
    case "PodcastDiscovery":
      return { kind: "PodcastDiscovery" };
  }
}

function quickActionEntry(
  quickAction: NexusQuickAction,
  query: string,
): NexusEntry | null {
  const tier = nexusTextRankTier({
    query,
    label: quickAction.label,
    aliases: quickAction.keywords,
    fallback: "Metadata",
  });
  if (tier === null) return null;
  return {
    key: { kind: "QuickAction", actionId: quickAction.id },
    historySource: "Static",
    label: quickAction.label,
    typeLabel: quickAction.category,
    icon: quickAction.icon,
    primaryAction: action(
      quickAction.id,
      quickAction.label,
      quickAction.icon,
      quickActionTarget(quickAction),
    ),
    secondaryActions: [],
    rank: { tier, score: 0, frecency: 0 },
  };
}

export function buildNexusZeroState(input: {
  readonly panes: readonly NexusPane[];
  readonly recent: readonly NexusRecentTarget[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
  readonly quickActions: readonly NexusQuickAction[];
}): NexusEntry[] {
  const openRouteIds = new Set(
    input.panes.map((pane) =>
      resolveWorkspaceActivationRouteId(pane.href),
    ),
  );
  const navigation = [
    ...input.panes.map((pane) => paneEntry(pane, "OpenContext")),
    ...input.recent
      .filter(
        (recent) =>
          !openRouteIds.has(
            resolveWorkspaceActivationRouteId(recent.target_href),
          ),
      )
      .map((recent) =>
        recentEntry(
          recent,
          input.frecencyByHref[recent.target_href] ?? 0,
        ),
      ),
  ].slice(0, ZERO_STATE_NAVIGATION_CAP);
  const quickActionById = new Map(
    input.quickActions.map((quickAction) => [quickAction.id, quickAction]),
  );
  const labels: Partial<Record<NexusQuickAction["id"], string>> = {
    "Nexus.Quick.Chat": "New Chat",
    "Nexus.Quick.Note": "New Note",
    "Nexus.Quick.Page": "New Page",
  };
  const quick = NEXUS_ZERO_STATE_ACTION_IDS.map((id) => {
    const quickAction = quickActionById.get(id);
    if (!quickAction) {
      throw new Error(`Missing Nexus quick action: ${id}`);
    }
    const entry = quickActionEntry(quickAction, "");
    if (!entry) {
      throw new Error(`Nexus zero-state action was not projected: ${id}`);
    }
    return { ...entry, label: labels[id] ?? quickAction.label };
  });
  return [...navigation, ...quick];
}

export function projectNexusLocalEntries(input: {
  readonly query: string;
  readonly panes: readonly NexusPane[];
  readonly destinations: readonly Destination[];
  readonly quickActions: readonly NexusQuickAction[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}): NexusEntry[] {
  const query = input.query.trim();
  if (!query) return [];
  const panes = input.panes.flatMap((pane) => {
    const tier = nexusTextRankTier({
      query,
      label: pane.label,
      aliases: [pane.href],
      openContext: true,
      fallback: "Metadata",
    });
    return tier === null ? [] : [paneEntry(pane, tier)];
  });
  const destinations = input.destinations.flatMap((destination) => {
    const tier = nexusTextRankTier({
      query,
      label: destination.label,
      aliases: destination.keywords,
      fallback: "Metadata",
    });
    if (tier === null) return [];
    const icon = destination.icon ?? getPaneRouteIcon(destination.href);
    return [
      {
        key: {
          kind: "Destination" as const,
          destinationId: destination.id,
        },
        historySource: "Static" as const,
        label: destination.label,
        typeLabel: "Place",
        icon,
        primaryAction: action("open", "Open", icon, {
          kind: "InternalHref",
          href: destination.href,
          labelHint: destination.label,
        }),
        secondaryActions: [],
        rank: {
          tier,
          score: 0,
          frecency: input.frecencyByHref[destination.href] ?? 0,
        },
      },
    ];
  });
  const quick = input.quickActions.flatMap((quickAction) => {
    const entry = quickActionEntry(quickAction, query);
    return entry ? [entry] : [];
  });
  const importUrl = normalizedUrl(query);
  const importEntry: NexusEntry[] = importUrl
    ? [
        {
          key: { kind: "ImportUrl", normalizedUrl: importUrl },
          historySource: "Static",
          label: "Import URL",
          typeLabel: new URL(importUrl).host,
          metadata: importUrl,
          icon: LinkIcon,
          primaryAction: action("import-url", "Import URL", LinkIcon, {
            kind: "OpenAdd",
            seed: {
              kind: "Content",
              initialFocus: "Url",
              initialDestinations: [],
              initialUrlDraft: importUrl,
            },
          }),
          secondaryActions: [],
          rank: { tier: "Exact", score: 1, frecency: 0 },
        },
      ]
    : [];
  return [...importEntry, ...panes, ...destinations, ...quick];
}

function resourceEntry(input: {
  readonly occurrenceRef: string;
  readonly label: string;
  readonly typeLabel: string;
  readonly metadata?: string;
  readonly snippetSegments?: NexusEntry["snippetSegments"];
  readonly subject: ResourceActionSubject;
  readonly icon: NexusEntry["icon"];
  readonly tier: NexusRankTier;
  readonly score: number;
  readonly queue?: { mediaId: string; title: string };
  readonly parent?: NexusEntry["parent"];
}): NexusEntry {
  const resourceActions = buildResourceNexusActions(
    input.subject,
    input.label,
  );
  const primaryAction = resourceActions.find(
    (candidate) => candidate.target.kind === "ResourceOpen",
  );
  if (!primaryAction) {
    throw new Error(`Routeable Nexus resource has no Open action: ${input.occurrenceRef}`);
  }
  const secondaryActions = resourceActions.filter(
    (candidate) => candidate !== primaryAction,
  );
  if (input.queue) {
    secondaryActions.push(
      action("queue-add", "Add to Lectern", FileText, {
        kind: "QueueAdd",
        mediaId: input.queue.mediaId,
        title: input.queue.title,
      }),
    );
  }
  return {
    key: { kind: "Resource", occurrenceRef: input.occurrenceRef },
    historySource: "Search",
    label: input.label,
    typeLabel: input.typeLabel,
    metadata: input.metadata,
    snippetSegments: input.snippetSegments,
    icon: input.icon,
    parent: input.parent,
    primaryAction,
    secondaryActions,
    rank: { tier: input.tier, score: input.score, frecency: 0 },
  };
}

function openPaneParent(
  href: string,
  panes: readonly NexusPane[],
): NexusEntry["parent"] {
  const routeId = resolveWorkspaceActivationRouteId(href);
  const pane = panes.find(
    (candidate) =>
      resolveWorkspaceActivationRouteId(candidate.href) === routeId,
  );
  return pane
    ? {
        key: { kind: "Pane", paneId: pane.id },
        label: pane.label,
      }
    : undefined;
}

export function projectNexusOpenableEntries(input: {
  readonly query: string;
  readonly items: readonly ResourceItem[];
  readonly panes: readonly NexusPane[];
}): NexusEntry[] {
  const openRouteIds = new Set(
    input.panes.map((pane) => resolveWorkspaceActivationRouteId(pane.href)),
  );
  return input.items.flatMap((item) => {
    const href = item.activation.href;
    if (
      item.missing ||
      item.activation.kind !== "route" ||
      href === null ||
      openRouteIds.has(resolveWorkspaceActivationRouteId(href))
    ) {
      return [];
    }
    const tier = nexusTextRankTier({
      query: input.query,
      label: item.label,
      aliases: [item.summary],
      fallback: "Metadata",
    });
    if (tier === null) return [];
    const ref = assumeCanonicalResourceRef(item.ref);
    return [
      resourceEntry({
        occurrenceRef: item.ref,
        label: item.label,
        typeLabel: item.scheme,
        metadata: item.summary || undefined,
        subject: {
          kind: "Resource",
          ref,
          activation: item.activation,
          missing: false,
        },
        icon: getPaneRouteIcon(href),
        tier,
        score: 0,
      }),
    ];
  });
}

export function projectNexusSearchEntries(input: {
  readonly query: string;
  readonly rows: readonly SearchResultRowViewModel[];
  readonly panes: readonly NexusPane[];
}): NexusEntry[] {
  const directOwner = new Map<
    string,
    { readonly key: NexusEntryKey; readonly label: string }
  >();
  for (const row of input.rows) {
    if (row.resourceRef === row.ownerResourceRef) {
      directOwner.set(row.ownerResourceRef, {
        key: {
          kind: "Resource",
          occurrenceRef: row.resourceRef,
        },
        label: row.primaryText,
      });
    }
  }
  const projected = input.rows.flatMap((row) => {
    if (row.type === "web_result") {
      throw new Error("Canonical Nexus Find returned a live Web result");
    }
    const href = row.actionTarget.activation.href;
    const paneParent = href ? openPaneParent(href, input.panes) : undefined;
    if (
      row.actionTarget.missing ||
      row.actionTarget.activation.kind !== "route" ||
      href === null ||
      (paneParent !== undefined && row.resourceRef === row.ownerResourceRef)
    ) {
      return [];
    }
    const tier =
      nexusTextRankTier({
        query: input.query,
        label: row.primaryText,
        aliases: row.sourceMeta ? [row.sourceMeta] : [],
        fallback: "FullText",
      }) ?? "FullText";
    const parent =
      paneParent ??
      (row.resourceRef === row.ownerResourceRef
        ? undefined
        : (directOwner.get(row.ownerResourceRef) ?? {
            key: {
              kind: "Resource",
              occurrenceRef: row.ownerResourceRef,
            },
            label: row.sourceMeta || row.ownerResourceRef,
          }));
    const queue =
      (row.type === "media" ||
        row.type === "episode" ||
        row.type === "video") &&
      row.mediaId !== null
        ? { mediaId: row.mediaId, title: row.primaryText }
        : undefined;
    return [
      resourceEntry({
        occurrenceRef: row.resourceRef,
        label: row.primaryText,
        typeLabel: row.typeLabel,
        metadata: row.sourceMeta ?? undefined,
        snippetSegments: row.snippetSegments,
        subject: row.actionTarget,
        icon: SEARCH_TYPE_ICON[row.type],
        tier,
        score: row.score,
        queue,
        parent,
      }),
    ];
  });
  return projected;
}

function continuationEntries(
  query: string,
  searchHrefValue: string,
): NexusEntry[] {
  return [
    {
      key: { kind: "Continuation", id: "Ask" },
      historySource: "Ai",
      label: `Ask Nexus about “${query}”`,
      typeLabel: "Chat",
      icon: MessageSquarePlus,
      primaryAction: action("ask", "Ask Nexus", MessageSquarePlus, {
        kind: "Ask",
        text: query,
      }),
      secondaryActions: [],
      rank: { tier: "FullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "SearchWeb" },
      historySource: "Ai",
      label: `Search the web for “${query}”`,
      typeLabel: "Web",
      icon: Globe,
      primaryAction: action("search-web", "Search the web", Globe, {
        kind: "OpenWebSearch",
        query,
      }),
      secondaryActions: [],
      rank: { tier: "FullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "SeeAll" },
      historySource: "Search",
      label: `See all results for “${query}”`,
      typeLabel: "Search",
      icon: Search,
      primaryAction: action("see-all", "See all results", Search, {
        kind: "InternalHref",
        href: searchHrefValue,
        labelHint: "Search",
      }),
      secondaryActions: [],
      rank: { tier: "FullText", score: 0, frecency: 0 },
    },
  ];
}

export function composeNexusFindEntries(input: {
  readonly query: string;
  readonly local: readonly NexusEntry[];
  readonly openables: readonly NexusEntry[];
  readonly search: readonly NexusEntry[];
  readonly ownedCap?: number;
}): NexusEntry[] {
  const unique = new Map<string, NexusEntry>();
  for (const entry of [...input.local, ...input.openables, ...input.search]) {
    const key = serializeNexusEntryKey(entry.key);
    if (!unique.has(key)) unique.set(key, entry);
  }
  const ranked = rankNexusEntries([...unique.values()]);
  const ownedCap = input.ownedCap ?? OWNED_RESULT_CAP;
  const parentKeys = new Set(
    ranked.flatMap((entry) =>
      entry.parent &&
      serializeNexusEntryKey(entry.parent.key) !==
        serializeNexusEntryKey(entry.key)
        ? [serializeNexusEntryKey(entry.parent.key)]
        : [],
    ),
  );
  const groups = new Map<string, NexusEntry[]>();
  const groupOrder: string[] = [];
  for (const entry of ranked) {
    const entryKey = serializeNexusEntryKey(entry.key);
    const parentKey =
      entry.parent &&
      serializeNexusEntryKey(entry.parent.key) !== entryKey
        ? serializeNexusEntryKey(entry.parent.key)
        : null;
    const groupKey =
      parentKey ?? (parentKeys.has(entryKey) ? entryKey : `Entry:${entryKey}`);
    const group = groups.get(groupKey);
    if (group) {
      group.push(entry);
    } else {
      groups.set(groupKey, [entry]);
      groupOrder.push(groupKey);
    }
  }
  const owned: NexusEntry[] = [];
  for (const groupKey of groupOrder) {
    if (owned.length >= ownedCap) break;
    const group = groups.get(groupKey)!;
    const ownerIndex = group.findIndex(
      (entry) => serializeNexusEntryKey(entry.key) === groupKey,
    );
    const orderedGroup =
      ownerIndex > 0
        ? [
            group[ownerIndex]!,
            ...group.slice(0, ownerIndex),
            ...group.slice(ownerIndex + 1),
          ]
        : group;
    // A canonical owner and its children are one presentation block. The cap
    // is deliberately soft at the boundary so it never creates an orphan.
    owned.push(...orderedGroup);
  }
  const parsed = parseNexusFindQuery(input.query);
  return parsed.importUrl || parsed.text.length < 2
    ? owned
    : [...owned, ...continuationEntries(parsed.text, searchHref(parsed.searchQuery))];
}

export interface ProgressiveNexusCommit {
  readonly entries: readonly NexusEntry[];
  readonly activeKey: string | null;
}

export function commitNexusRevision(
  entries: readonly NexusEntry[],
): ProgressiveNexusCommit {
  return {
    entries,
    activeKey:
      entries.length > 0 ? serializeNexusEntryKey(entries[0]!.key) : null,
  };
}

export function mergeProgressiveNexusEntries(input: {
  readonly previous: ProgressiveNexusCommit;
  readonly incoming: readonly NexusEntry[];
  readonly userMoved: boolean;
}): ProgressiveNexusCommit {
  const incomingByKey = new Map(
    input.incoming.map((entry) => [serializeNexusEntryKey(entry.key), entry]),
  );
  const activeKey = input.previous.activeKey;
  if (activeKey === null) return commitNexusRevision(input.incoming);
  const previousKeys = input.previous.entries.map((entry) =>
    serializeNexusEntryKey(entry.key),
  );
  const previousIndex = previousKeys.indexOf(activeKey);
  if (previousIndex < 0) return commitNexusRevision(input.incoming);

  if (!incomingByKey.has(activeKey)) {
    const fallbackIndex = Math.min(previousIndex, input.incoming.length - 1);
    return {
      entries: input.incoming,
      activeKey:
        fallbackIndex >= 0
          ? serializeNexusEntryKey(input.incoming[fallbackIndex]!.key)
          : null,
    };
  }

  const stableKeys = input.userMoved
    ? previousKeys
        .slice(0, previousIndex + 1)
        .filter((key) => incomingByKey.has(key))
    : [activeKey];
  const stableEntries = stableKeys.map((key) => incomingByKey.get(key)!);
  const stableKeySet = new Set(stableKeys);
  const tail = input.incoming.filter(
    (entry) => !stableKeySet.has(serializeNexusEntryKey(entry.key)),
  );
  if (!input.userMoved && previousIndex > 0) {
    tail.splice(previousIndex, 0, stableEntries[0]!);
    return { entries: tail, activeKey };
  }
  return {
    entries: [...stableEntries, ...tail],
    activeKey,
  };
}
