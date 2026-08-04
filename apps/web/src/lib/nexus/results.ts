import {
  FilePlus2,
  FileText,
  Globe,
  Library,
  Link as LinkIcon,
  MessageSquarePlus,
  PanelLeft,
  Play,
  Search,
  X,
} from "lucide-react";
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
import {
  NEXUS_COMMAND_IDS,
  getNexusCommand,
} from "./commands";
import { compileNexusIntent, type NexusIntent } from "./intent";
import {
  nexusEntryKeyValue,
  type NexusAction,
  type NexusCommand,
  type NexusCommandId,
  type NexusEntry,
  type NexusEntryKey,
  type NexusGroup,
  type NexusProjection,
  type NexusRankTier,
  type NexusSurface,
  type NexusTarget,
} from "./model";
import { nexusTextRankTier, rankNexusEntries } from "./ranking";

const OWNED_RESULT_CAP = 8;
const OPEN_CAP = 5;
const RECENT_CAP = 4;
const MOBILE_PLACE_IDS = [
  "lectern",
  "libraries",
  "browse",
  "podcasts",
  "chats",
  "notes",
] as const;
const QUICK_COMMAND_IDS = [
  "Nexus.Quick.Note",
  "Nexus.Quick.Chat",
  "Nexus.Quick.Page",
  "Nexus.Quick.Library",
  "Nexus.Quick.Import",
] as const satisfies readonly NexusCommandId[];

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

export type NexusTodayAppend =
  | { readonly kind: "Available" }
  | { readonly kind: "Unavailable"; readonly reason: string };

export function parseNexusQuery(raw: string) {
  const compiled = compileNexusIntent(raw);
  const parsed = parseSearchInput(compiled.query);
  return {
    text: compiled.query,
    normalizedText: compiled.normalizedQuery,
    intent: compiled.intent,
    searchQuery: applyParsedInput(emptySearchQuery(), parsed),
    importUrl:
      compiled.intent.kind === "ImportUrl" ? compiled.intent.url : null,
  };
}

function action(input: {
  readonly id: string;
  readonly label: string;
  readonly icon: NexusAction["icon"];
  readonly target: NexusTarget;
  readonly activation?: NexusAction["activation"];
}): NexusAction {
  return {
    id: input.id,
    label: input.label,
    icon: input.icon,
    activation: input.activation ?? { kind: "Standard" },
    availability: { kind: "Available", target: input.target },
  };
}

function unavailableAction(input: {
  readonly id: string;
  readonly label: string;
  readonly icon: NexusAction["icon"];
  readonly reason: string;
  readonly activation: NexusAction["activation"];
}): NexusAction {
  return {
    id: input.id,
    label: input.label,
    icon: input.icon,
    activation: input.activation,
    availability: { kind: "Unavailable", reason: input.reason },
  };
}

export function nexusCreateChoiceActions(
  initialDraft: string,
  todayAppend: NexusTodayAppend = { kind: "Available" },
): readonly NexusAction[] {
  return [
    todayAppend.kind === "Available"
      ? action({
          id: "create-today-note",
          label: "Today Note",
          icon: FileText,
          target: getNexusCommand("Nexus.Quick.Note").target({
            argument: initialDraft,
          }),
          activation: { kind: "DailyTextHandoff" },
        })
      : unavailableAction({
          id: "create-today-note",
          label: "Today Note",
          icon: FileText,
          reason: todayAppend.reason,
          activation: { kind: "DailyTextHandoff" },
        }),
    action({
      id: "create-page",
      label: "Page",
      icon: FilePlus2,
      target: getNexusCommand("Nexus.Quick.Page").target({
        argument: initialDraft,
      }),
    }),
    action({
      id: "create-chat",
      label: "Chat",
      icon: MessageSquarePlus,
      target: getNexusCommand("Nexus.Quick.Chat").target({
        argument: initialDraft,
      }),
    }),
    action({
      id: "create-library",
      label: "Library",
      icon: Library,
      target: getNexusCommand("Nexus.Quick.Library").target({
        argument: initialDraft,
      }),
    }),
  ];
}

const BROWSE_CHOICES = [
  { id: "browse-articles", label: "Articles", browseKind: "WebArticle" },
  { id: "browse-podcasts", label: "Podcasts", browseKind: "Podcast" },
  { id: "browse-videos", label: "Videos", browseKind: "Video" },
  { id: "browse-books", label: "Books", browseKind: "Epub" },
] as const;

export function nexusBrowseChoiceActions(query: string): readonly NexusAction[] {
  return BROWSE_CHOICES.map((choice) =>
    action({
      id: choice.id,
      label: choice.label,
      icon: Globe,
      target: {
        kind: "Browse",
        query,
        browseKind: choice.browseKind,
      },
    }),
  );
}

function paneEntry(
  pane: NexusPane,
  tier: NexusRankTier,
  frecency: number,
): NexusEntry {
  return {
    key: { kind: "Pane", paneId: pane.id },
    historySource: "Workspace",
    label: pane.label,
    typeLabel: "Tab",
    metadata: pane.current
      ? "Current tab"
      : pane.visibility === "minimized"
        ? "Minimized tab"
        : "Open tab",
    icon: getPaneRouteIcon(pane.href),
    openState: pane.current
      ? "Active"
      : pane.visibility === "minimized"
        ? "Minimized"
        : "Open",
    primaryAction: action({
      id: "open",
      label: "Open",
      icon: PanelLeft,
      target: { kind: "PaneOpen", paneId: pane.id },
    }),
    secondaryActions: [
      action({
        id: "close",
        label: "Close tab",
        icon: X,
        target: { kind: "PaneClose", paneId: pane.id },
      }),
    ],
    rank: { tier, score: pane.current ? 1 : 0, frecency },
  };
}

export function projectNexusPaneEntries(input: {
  readonly query: string;
  readonly panes: readonly NexusPane[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}): NexusEntry[] {
  if (!input.query) {
    return input.panes.map((pane) =>
      paneEntry(pane, "CurrentContext", input.frecencyByHref[pane.href] ?? 0),
    );
  }
  return input.panes.flatMap((pane) => {
    const tier = nexusTextRankTier({
      query: input.query,
      label: pane.label,
      aliases: [pane.href],
      currentContext: true,
    });
    return tier === null
      ? []
      : [paneEntry(pane, tier, input.frecencyByHref[pane.href] ?? 0)];
  });
}

function recentEntry(recent: NexusRecentTarget, frecency: number): NexusEntry {
  const icon = getPaneRouteIcon(recent.target_href);
  return {
    key: {
      kind: "Resource",
      occurrenceRef: `Route:${recent.target_href}`,
    },
    historySource: "Recent",
    label: recent.label_snapshot,
    typeLabel: "Recent",
    metadata: recent.target_href,
    icon,
    primaryAction: action({
      id: "open",
      label: "Open",
      icon,
      target: {
        kind: "InternalHref",
        href: recent.target_href,
        labelHint: recent.label_snapshot,
      },
    }),
    secondaryActions: [],
    rank: { tier: "CurrentContext", score: 0, frecency },
  };
}

export function projectNexusRecentEntries(input: {
  readonly panes: readonly NexusPane[];
  readonly recent: readonly NexusRecentTarget[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}): NexusEntry[] {
  const seenRouteIds = new Set(
    input.panes.map((pane) => resolveWorkspaceActivationRouteId(pane.href)),
  );
  const entries: NexusEntry[] = [];
  for (const recent of input.recent) {
    const routeId = resolveWorkspaceActivationRouteId(recent.target_href);
    if (seenRouteIds.has(routeId)) continue;
    seenRouteIds.add(routeId);
    entries.push(
      recentEntry(
        recent,
        input.frecencyByHref[recent.target_href] ?? 0,
      ),
    );
  }
  return entries;
}

export function projectNexusCurrentPlaybackEntry(input: {
  readonly label: string;
  readonly metadata?: string;
}): NexusEntry {
  return {
    key: { kind: "Resource", occurrenceRef: "Playback:Current" },
    historySource: "Workspace",
    label: input.label,
    typeLabel: "Media",
    metadata: input.metadata,
    icon: Play,
    primaryAction: action({
      id: "resume-current-playback",
      label: "Resume",
      icon: Play,
      target: { kind: "ResumeCurrentPlayback" },
    }),
    secondaryActions: [],
    rank: { tier: "CurrentContext", score: 0, frecency: 0 },
  };
}

function destinationEntry(
  destination: Destination,
  tier: NexusRankTier,
  frecency: number,
): NexusEntry {
  const icon = destination.icon ?? getPaneRouteIcon(destination.href);
  return {
    key: { kind: "Destination", destinationId: destination.id },
    historySource: "Static",
    label: destination.label,
    typeLabel: "Place",
    icon,
    primaryAction: action({
      id: "open",
      label: "Open",
      icon,
      target:
        destination.id === "today"
          ? {
              kind: "OpenDailyPage",
              date: { kind: "Today" },
              entry: { kind: "View" },
            }
          : {
              kind: "InternalHref",
              href: destination.href,
              labelHint: destination.label,
            },
    }),
    secondaryActions: [],
    rank: { tier, score: 0, frecency },
  };
}

export function projectNexusDestinationEntries(input: {
  readonly query: string;
  readonly destinations: readonly Destination[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}): NexusEntry[] {
  if (!input.query) {
    return input.destinations.map((destination) =>
      destinationEntry(
        destination,
        "CurrentContext",
        input.frecencyByHref[destination.href] ?? 0,
      ),
    );
  }
  return input.destinations.flatMap((destination) => {
    const tier = nexusTextRankTier({
      query: input.query,
      label: destination.label,
      aliases: destination.keywords,
      metadata: [destination.href],
    });
    return tier === null
      ? []
      : [
          destinationEntry(
            destination,
            tier,
            input.frecencyByHref[destination.href] ?? 0,
          ),
        ];
  });
}

function commandMetadata(command: NexusCommand, argument: string): string {
  return argument || `${command.category} · ${command.aliases[0]!.trimEnd()}`;
}

function commandEntry(input: {
  readonly command: NexusCommand;
  readonly tier: NexusRankTier;
  readonly argument: string;
  readonly shortcutHint: string | undefined;
}): NexusEntry {
  return {
    key: { kind: "QuickAction", actionId: input.command.id },
    historySource: "Static",
    label: input.command.label,
    shortcutHint: input.shortcutHint,
    typeLabel: "Command",
    metadata: commandMetadata(input.command, input.argument),
    icon: input.command.icon,
    primaryAction: action({
      id: input.command.id,
      label: input.command.label,
      icon: input.command.icon,
      target: input.command.target({ argument: input.argument }),
      activation: input.command.activation,
    }),
    secondaryActions: [],
    rank: { tier: input.tier, score: 0, frecency: 0 },
  };
}

function importUrlEntry(url: string): NexusEntry {
  return {
    key: { kind: "ImportUrl", normalizedUrl: url },
    historySource: "Static",
    label: "Import URL",
    typeLabel: "URL",
    metadata: url,
    icon: LinkIcon,
    primaryAction: action({
      id: "import-url",
      label: "Import URL",
      icon: LinkIcon,
      target: getNexusCommand("Nexus.Quick.Import").target({ argument: url }),
    }),
    secondaryActions: [],
    rank: { tier: "Exact", score: 1, frecency: 0 },
  };
}

const BROWSE_KIND_LABEL = {
  WebArticle: "articles",
  Podcast: "podcasts",
  Video: "videos",
  Epub: "books",
} as const;

function explicitIntentEntry(
  intent: NexusIntent,
  commandShortcutHints: Readonly<Partial<Record<NexusCommandId, string>>>,
): NexusEntry | null {
  switch (intent.kind) {
    case "Search":
    case "ImportUrl":
      return null;
    case "Command":
      return commandEntry({
        command: getNexusCommand(intent.commandId),
        tier: "ExplicitIntent",
        argument: intent.argument,
        shortcutHint: commandShortcutHints[intent.commandId],
      });
    case "Ask":
      return {
        key: { kind: "Intent", id: "Ask" },
        historySource: "Ai",
        label: `Ask Nexus about “${intent.argument}”`,
        typeLabel: "Chat",
        metadata: "Explicit intent",
        icon: MessageSquarePlus,
        primaryAction: action({
          id: "ask",
          label: "Ask Nexus",
          icon: MessageSquarePlus,
          target: { kind: "Ask", text: intent.argument },
        }),
        secondaryActions: [],
        rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
      };
    case "ChooseBrowse":
      return {
        key: { kind: "Intent", id: "ChooseBrowse" },
        historySource: "Static",
        label: intent.query ? `Browse for “${intent.query}”…` : "Browse…",
        typeLabel: "Browse",
        metadata: "Choose a kind",
        icon: Globe,
        primaryAction: action({
          id: "choose-browse",
          label: "Choose a browse kind",
          icon: Globe,
          target: { kind: "ChooseBrowse", query: intent.query },
        }),
        secondaryActions: [],
        rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
      };
    case "Browse": {
      const kindLabel = BROWSE_KIND_LABEL[intent.browseKind];
      return {
        key: { kind: "Intent", id: `Browse.${intent.browseKind}` },
        historySource: "Static",
        label: intent.query
          ? `Browse ${kindLabel} for “${intent.query}”…`
          : `Browse ${kindLabel}…`,
        typeLabel: "Browse",
        metadata: "Explicit kind",
        icon: Globe,
        primaryAction: action({
          id: "browse",
          label: `Browse ${kindLabel}`,
          icon: Globe,
          target: {
            kind: "Browse",
            query: intent.query,
            browseKind: intent.browseKind,
          },
        }),
        secondaryActions: [],
        rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
      };
    }
  }
}

export function projectNexusLocalEntries(input: {
  readonly query: string;
  readonly panes: readonly NexusPane[];
  readonly destinations: readonly Destination[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
  readonly commandShortcutHints: Readonly<Partial<Record<NexusCommandId, string>>>;
}): NexusEntry[] {
  const parsed = parseNexusQuery(input.query);
  if (!parsed.text) return [];

  const panes = projectNexusPaneEntries({
    query: parsed.text,
    panes: input.panes,
    frecencyByHref: input.frecencyByHref,
  });
  const destinations = projectNexusDestinationEntries({
    query: parsed.text,
    destinations: input.destinations,
    frecencyByHref: input.frecencyByHref,
  });
  const explicit = explicitIntentEntry(
    parsed.intent,
    input.commandShortcutHints,
  );
  const commands =
    parsed.intent.kind === "Search"
      ? NEXUS_COMMAND_IDS.flatMap((id) => {
          const command = getNexusCommand(id);
          const tier = nexusTextRankTier({
            query: parsed.text,
            label: command.label,
            aliases: command.keywords,
          });
          return tier === null
            ? []
            : [
                commandEntry({
                  command,
                  tier,
                  argument: "",
                  shortcutHint: input.commandShortcutHints[id],
                }),
              ];
        })
      : [];
  const importUrl =
    parsed.intent.kind === "ImportUrl"
      ? [importUrlEntry(parsed.intent.url)]
      : [];
  return [
    ...importUrl,
    ...(explicit ? [explicit] : []),
    ...panes,
    ...destinations,
    ...commands,
  ];
}

function resourceEntry(input: {
  readonly occurrenceRef: string;
  readonly label: string;
  readonly typeLabel: string;
  readonly metadata?: string;
  readonly snippetSegments?: NexusEntry["snippetSegments"];
  readonly subject: ResourceActionSubject;
  readonly icon: NexusEntry["icon"];
  readonly historySource: NexusEntry["historySource"];
  readonly tier: NexusRankTier;
  readonly score: number;
  readonly frecency: number;
  readonly parent?: NexusEntry["parent"];
}): NexusEntry {
  // A resource entry keeps its resource identity + primary activation (Open as
  // the row primary). Its secondary/overflow actions are the ONE canonical
  // resource dropdown, projected from the shared planner off `resourceTarget`
  // by the render site — never a private NexusAction array. Both callers only
  // build resource entries for routeable resources, so Open is always valid.
  return {
    key: { kind: "Resource", occurrenceRef: input.occurrenceRef },
    historySource: input.historySource,
    label: input.label,
    typeLabel: input.typeLabel,
    metadata: input.metadata,
    snippetSegments: input.snippetSegments,
    icon: input.icon,
    parent: input.parent,
    primaryAction: action({
      id: "open",
      label: "Open",
      icon: input.icon,
      target: {
        kind: "ResourceOpen",
        subject: input.subject,
        labelHint: input.label,
      },
    }),
    secondaryActions: [],
    resourceTarget: input.subject,
    rank: {
      tier: input.tier,
      score: input.score,
      frecency: input.frecency,
    },
  };
}

function openPaneParent(
  href: string,
  panes: readonly NexusPane[],
  query: string,
): NexusEntry["parent"] {
  const routeId = resolveWorkspaceActivationRouteId(href);
  const pane = panes.find(
    (candidate) =>
      resolveWorkspaceActivationRouteId(candidate.href) === routeId,
  );
  if (!pane) return undefined;
  const tier = nexusTextRankTier({
    query,
    label: pane.label,
    aliases: [pane.href],
    currentContext: true,
  });
  return tier === null
    ? undefined
    : { key: { kind: "Pane", paneId: pane.id }, label: pane.label };
}

export function projectNexusOpenableEntries(input: {
  readonly query: string;
  readonly items: readonly ResourceItem[];
  readonly panes: readonly NexusPane[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
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
      metadata: [item.summary],
      fullText: true,
    });
    if (tier === null) return [];
    return [
      resourceEntry({
        occurrenceRef: item.ref,
        label: item.label,
        typeLabel: item.scheme,
        metadata: item.summary || undefined,
        subject: {
          kind: "Resource",
          ref: assumeCanonicalResourceRef(item.ref),
          activation: item.activation,
          missing: false,
        },
        icon: getPaneRouteIcon(href),
        historySource: "Oracle",
        tier,
        score: 0,
        frecency: input.frecencyByHref[href] ?? 0,
      }),
    ];
  });
}

export function projectNexusSearchEntries(input: {
  readonly query: string;
  readonly rows: readonly SearchResultRowViewModel[];
  readonly panes: readonly NexusPane[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}): NexusEntry[] {
  const directOwner = new Map<
    string,
    { readonly key: NexusEntryKey; readonly label: string }
  >();
  for (const row of input.rows) {
    if (row.resourceRef === row.ownerResourceRef) {
      directOwner.set(row.ownerResourceRef, {
        key: { kind: "Resource", occurrenceRef: row.resourceRef },
        label: row.primaryText,
      });
    }
  }

  return input.rows.flatMap((row) => {
    if (row.type === "web_result") {
      throw new Error("Canonical Nexus Search returned a live Web result");
    }
    const href = row.actionTarget.activation.href;
    const paneParent = href
      ? openPaneParent(href, input.panes, input.query)
      : undefined;
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
        metadata: row.sourceMeta ? [row.sourceMeta] : [],
        fullText: true,
      }) ?? "MetadataOrFullText";
    const directParent = directOwner.get(row.ownerResourceRef);
    if (
      row.resourceRef !== row.ownerResourceRef &&
      paneParent === undefined &&
      directParent === undefined
    ) {
      return [];
    }
    const parent =
      paneParent ??
      (row.resourceRef === row.ownerResourceRef
        ? undefined
        : directParent);
    return [
      resourceEntry({
        occurrenceRef: row.resourceRef,
        label: row.primaryText,
        typeLabel: row.typeLabel,
        metadata: row.sourceMeta ?? undefined,
        snippetSegments: row.snippetSegments,
        subject: row.actionTarget,
        icon: SEARCH_TYPE_ICON[row.type],
        historySource: "Search",
        tier,
        score: row.score,
        frecency:
          row.resourceRef === row.ownerResourceRef
            ? (input.frecencyByHref[href] ?? 0)
            : 0,
        parent,
      }),
    ];
  });
}

function canonicalResultOrder(entries: readonly NexusEntry[]): NexusEntry[] {
  const ranked = rankNexusEntries(entries);
  const parentKeys = new Set(
    ranked.flatMap((entry) => {
      if (!entry.parent) return [];
      const entryKey = nexusEntryKeyValue(entry.key);
      const parentKey = nexusEntryKeyValue(entry.parent.key);
      return entryKey === parentKey ? [] : [parentKey];
    }),
  );
  const groups = new Map<string, NexusEntry[]>();
  const groupOrder: string[] = [];
  for (const entry of ranked) {
    const entryKey = nexusEntryKeyValue(entry.key);
    const parentKey = entry.parent ? nexusEntryKeyValue(entry.parent.key) : null;
    const groupKey =
      parentKey && parentKey !== entryKey
        ? parentKey
        : parentKeys.has(entryKey)
          ? entryKey
          : `Entry:${entryKey}`;
    const group = groups.get(groupKey);
    if (group) {
      group.push(entry);
    } else {
      groups.set(groupKey, [entry]);
      groupOrder.push(groupKey);
    }
  }

  return groupOrder.flatMap((groupKey) => {
    const group = groups.get(groupKey)!;
    const ownerIndex = group.findIndex(
      (entry) => nexusEntryKeyValue(entry.key) === groupKey,
    );
    return ownerIndex < 0
      ? group
      : [
          group[ownerIndex]!,
          ...group.slice(0, ownerIndex),
          ...group.slice(ownerIndex + 1),
        ];
  });
}

export function composeNexusResultCandidates(input: {
  readonly local: readonly NexusEntry[];
  readonly openables: readonly NexusEntry[];
  readonly search: readonly NexusEntry[];
}): NexusEntry[] {
  const unique = new Map<string, NexusEntry>();
  for (const entry of [...input.local, ...input.openables, ...input.search]) {
    const key = nexusEntryKeyValue(entry.key);
    if (!unique.has(key)) unique.set(key, entry);
  }
  return canonicalResultOrder([...unique.values()]);
}

export interface ProgressiveNexusCommit {
  readonly normalizedQuery: string;
  readonly entries: readonly NexusEntry[];
  readonly activeKey: NexusEntryKey | null;
}

function matchingEntryKey(
  entries: readonly NexusEntry[],
  key: NexusEntryKey | null,
): NexusEntryKey | null {
  if (key === null) return null;
  const value = nexusEntryKeyValue(key);
  return entries.find((entry) => nexusEntryKeyValue(entry.key) === value)?.key ?? null;
}

export function commitNexusRevision(input: {
  readonly normalizedQuery: string;
  readonly incoming: readonly NexusEntry[];
  readonly activeKey: NexusEntryKey | null;
}): ProgressiveNexusCommit {
  const entries = input.incoming.slice(0, OWNED_RESULT_CAP);
  return {
    normalizedQuery: input.normalizedQuery,
    entries,
    activeKey: matchingEntryKey(entries, input.activeKey) ?? entries[0]?.key ?? null,
  };
}

function entriesWithStablePrefix(
  incoming: readonly NexusEntry[],
  stableKeys: readonly string[],
): NexusEntry[] {
  const incomingByKey = new Map(
    incoming.map((entry) => [nexusEntryKeyValue(entry.key), entry]),
  );
  const stable = stableKeys.flatMap((key) => {
    const entry = incomingByKey.get(key);
    return entry ? [entry] : [];
  });
  const stableSet = new Set(stableKeys);
  return [
    ...stable,
    ...incoming.filter((entry) => !stableSet.has(nexusEntryKeyValue(entry.key))),
  ].slice(0, OWNED_RESULT_CAP);
}

export function mergeProgressiveNexusEntries(input: {
  readonly previous: ProgressiveNexusCommit;
  readonly normalizedQuery: string;
  readonly incoming: readonly NexusEntry[];
  readonly userMoved: boolean;
}): ProgressiveNexusCommit {
  if (input.previous.normalizedQuery !== input.normalizedQuery) {
    return commitNexusRevision({
      normalizedQuery: input.normalizedQuery,
      incoming: input.incoming,
      activeKey: null,
    });
  }

  const activeKey = input.previous.activeKey;
  if (activeKey === null) {
    return commitNexusRevision({
      normalizedQuery: input.normalizedQuery,
      incoming: input.incoming,
      activeKey: null,
    });
  }
  const activeValue = nexusEntryKeyValue(activeKey);
  const previousValues = input.previous.entries.map((entry) =>
    nexusEntryKeyValue(entry.key),
  );
  const previousIndex = previousValues.indexOf(activeValue);
  if (previousIndex < 0) {
    return commitNexusRevision({
      normalizedQuery: input.normalizedQuery,
      incoming: input.incoming,
      activeKey: null,
    });
  }

  const incomingByKey = new Map(
    input.incoming.map((entry) => [nexusEntryKeyValue(entry.key), entry]),
  );
  if (!incomingByKey.has(activeValue)) {
    const stableValues = input.userMoved
      ? previousValues.slice(0, previousIndex).filter((key) => incomingByKey.has(key))
      : [];
    const entries = entriesWithStablePrefix(input.incoming, stableValues);
    const fallbackIndex = Math.min(previousIndex, entries.length - 1);
    return {
      normalizedQuery: input.normalizedQuery,
      entries,
      activeKey: fallbackIndex < 0 ? null : entries[fallbackIndex]!.key,
    };
  }

  if (input.userMoved) {
    const stableValues = previousValues
      .slice(0, previousIndex + 1)
      .filter((key) => incomingByKey.has(key));
    return {
      normalizedQuery: input.normalizedQuery,
      entries: entriesWithStablePrefix(input.incoming, stableValues),
      activeKey: incomingByKey.get(activeValue)!.key,
    };
  }

  const activeEntry = incomingByKey.get(activeValue)!;
  const reranked = input.incoming.slice(0, OWNED_RESULT_CAP);
  if (reranked.some((entry) => nexusEntryKeyValue(entry.key) === activeValue)) {
    return {
      normalizedQuery: input.normalizedQuery,
      entries: reranked,
      activeKey: activeEntry.key,
    };
  }

  const parentValue = activeEntry.parent
    ? nexusEntryKeyValue(activeEntry.parent.key)
    : null;
  const owner = parentValue ? incomingByKey.get(parentValue) : undefined;
  const reservedValues = new Set([
    activeValue,
    ...(owner ? [nexusEntryKeyValue(owner.key)] : []),
  ]);
  const entries = input.incoming
    .filter((entry) => !reservedValues.has(nexusEntryKeyValue(entry.key)))
    .slice(0, OWNED_RESULT_CAP - reservedValues.size);
  if (owner) entries.push(owner);
  entries.push(activeEntry);
  return {
    normalizedQuery: input.normalizedQuery,
    entries,
    activeKey: activeEntry.key,
  };
}

function queryActionEntries(input: {
  readonly query: string;
  readonly searchHref: string;
  readonly todayAppend: NexusTodayAppend;
}): NexusEntry[] {
  const addToToday =
    input.todayAppend.kind === "Available"
      ? action({
          id: "add-to-today",
          label: "Add to Today",
          icon: FileText,
          target: {
            kind: "OpenDailyPage",
            date: { kind: "Today" },
            entry: { kind: "AppendNote", initialText: input.query },
          },
          activation: { kind: "DailyTextHandoff" },
        })
      : unavailableAction({
          id: "add-to-today",
          label: "Add to Today",
          icon: FileText,
          reason: input.todayAppend.reason,
          activation: { kind: "DailyTextHandoff" },
        });
  return [
    {
      key: { kind: "Continuation", id: "Ask" },
      historySource: "Ai",
      label: `Ask Nexus about “${input.query}”`,
      typeLabel: "Chat",
      metadata: "Ask Nexus",
      icon: MessageSquarePlus,
      primaryAction: action({
        id: "ask",
        label: "Ask Nexus",
        icon: MessageSquarePlus,
        target: { kind: "Ask", text: input.query },
      }),
      secondaryActions: [],
      rank: { tier: "MetadataOrFullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "AddToToday" },
      historySource: "Static",
      label: `Add “${input.query}” to Today`,
      typeLabel: "Today",
      metadata: "Append note",
      icon: FileText,
      primaryAction: addToToday,
      secondaryActions: [],
      rank: { tier: "MetadataOrFullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "Browse" },
      historySource: "Static",
      label: `Browse for “${input.query}”…`,
      typeLabel: "Browse",
      metadata: "Choose a kind",
      icon: Globe,
      primaryAction: action({
        id: "browse",
        label: "Choose a browse kind",
        icon: Globe,
        target: { kind: "ChooseBrowse", query: input.query },
      }),
      secondaryActions: [],
      rank: { tier: "MetadataOrFullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "Create" },
      historySource: "Static",
      label: `Create “${input.query}”…`,
      typeLabel: "Create",
      metadata: "Choose a type",
      icon: FilePlus2,
      primaryAction: action({
        id: "create",
        label: "Choose what to create",
        icon: FilePlus2,
        target: { kind: "ChooseCreate", initialDraft: input.query },
      }),
      secondaryActions: [],
      rank: { tier: "MetadataOrFullText", score: 0, frecency: 0 },
    },
    {
      key: { kind: "Continuation", id: "SeeAll" },
      historySource: "Search",
      label: `See all results for “${input.query}”`,
      typeLabel: "Search",
      metadata: "All results",
      icon: Search,
      primaryAction: action({
        id: "see-all",
        label: "See all results",
        icon: Search,
        target: {
          kind: "InternalHref",
          href: input.searchHref,
          labelHint: "Search",
        },
      }),
      secondaryActions: [],
      rank: { tier: "MetadataOrFullText", score: 0, frecency: 0 },
    },
  ];
}

function requiredDestination(
  destinations: readonly Destination[],
  id: string,
): Destination {
  const destination = destinations.find((candidate) => candidate.id === id);
  if (!destination) {
    throw new Error(`Missing canonical Nexus destination: ${id}`);
  }
  return destination;
}

function manageTabsEntry(): NexusEntry {
  return {
    key: { kind: "ManageTabs" },
    historySource: "Workspace",
    label: "Manage tabs…",
    typeLabel: "Tabs",
    metadata: "More open tabs",
    icon: PanelLeft,
    primaryAction: action({
      id: "manage-tabs",
      label: "Manage tabs",
      icon: PanelLeft,
      target: { kind: "ManageTabs" },
    }),
    secondaryActions: [],
    rank: { tier: "CurrentContext", score: 0, frecency: 0 },
  };
}

function group(input: {
  readonly id: NexusGroup["id"];
  readonly label: string;
  readonly layout: NexusGroup["layout"];
  readonly entries: readonly NexusEntry[];
}): NexusGroup[] {
  return input.entries.length === 0 ? [] : [input];
}

function blankGroups(input: {
  readonly surface: NexusSurface;
  readonly panes: readonly NexusPane[];
  readonly currentPlayback: NexusEntry | null;
  readonly recent: readonly NexusRecentTarget[];
  readonly destinations: readonly Destination[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
  readonly commandShortcutHints: Readonly<Partial<Record<NexusCommandId, string>>>;
}): NexusGroup[] {
  const layout = input.surface === "Mobile" ? "CompactRail" : "Flow";
  const allOpen = projectNexusPaneEntries({
    query: "",
    panes: input.panes,
    frecencyByHref: input.frecencyByHref,
  });
  const open = [
    ...allOpen.slice(0, OPEN_CAP),
    ...(allOpen.length > OPEN_CAP ? [manageTabsEntry()] : []),
  ];
  const recent = projectNexusRecentEntries({
    panes: input.panes,
    recent: input.recent,
    frecencyByHref: input.frecencyByHref,
  }).slice(0, RECENT_CAP);
  const destinationEntries = new Map(
    projectNexusDestinationEntries({
      query: "",
      destinations: input.destinations,
      frecencyByHref: input.frecencyByHref,
    }).map((entry) => [
      entry.key.kind === "Destination" ? entry.key.destinationId : "",
      entry,
    ]),
  );
  const today = destinationEntries.get("today");
  if (!today) throw new Error("Missing canonical Nexus destination: today");
  const commandEntries = new Map(
    QUICK_COMMAND_IDS.map((id) => [
      id,
      commandEntry({
        command: getNexusCommand(id),
        tier: "CurrentContext",
        argument: "",
        shortcutHint: input.commandShortcutHints[id],
      }),
    ]),
  );
  const quickActions = [
    commandEntries.get("Nexus.Quick.Note")!,
    today,
    commandEntries.get("Nexus.Quick.Chat")!,
    commandEntries.get("Nexus.Quick.Page")!,
    commandEntries.get("Nexus.Quick.Library")!,
    commandEntries.get("Nexus.Quick.Import")!,
  ];
  const places = MOBILE_PLACE_IDS.map((id) => {
    requiredDestination(input.destinations, id);
    return destinationEntries.get(id)!;
  });

  const openGroup = group({ id: "Open", label: "Open", layout, entries: open });
  const continueGroup = group({
    id: "Continue",
    label: "Continue",
    layout,
    entries: input.currentPlayback ? [input.currentPlayback] : [],
  });
  const recentGroup = group({
    id: "Recent",
    label: "Recent",
    layout,
    entries: recent,
  });
  const quickGroup = group({
    id: "QuickActions",
    label: "Quick Actions",
    layout,
    entries: quickActions,
  });
  const placesGroup = group({
    id: "Places",
    label: "Places",
    layout,
    entries: places,
  });
  return input.surface === "Desktop"
    ? [...openGroup, ...continueGroup, ...recentGroup, ...quickGroup]
    : [...openGroup, ...quickGroup, ...continueGroup, ...recentGroup, ...placesGroup];
}

function activeProjectionKey(
  entries: readonly NexusEntry[],
  requested: NexusEntryKey | null,
): NexusEntryKey | null {
  return matchingEntryKey(entries, requested) ?? entries[0]?.key ?? null;
}

export function composeNexusProjection(input: {
  readonly surface: NexusSurface;
  readonly query: string;
  readonly panes: readonly NexusPane[];
  readonly currentPlayback: NexusEntry | null;
  readonly recent: readonly NexusRecentTarget[];
  readonly destinations: readonly Destination[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
  readonly commandShortcutHints: Readonly<Partial<Record<NexusCommandId, string>>>;
  readonly results: readonly NexusEntry[];
  readonly activeKey: NexusEntryKey | null;
  readonly todayAppend: NexusTodayAppend;
}): NexusProjection {
  const parsed = parseNexusQuery(input.query);
  if (!parsed.text) {
    const groups = blankGroups(input);
    const entries = groups.flatMap((candidate) => candidate.entries);
    return {
      surface: input.surface,
      groups,
      activeKey: activeProjectionKey(entries, input.activeKey),
    };
  }

  const results = input.results.slice(0, OWNED_RESULT_CAP);
  const queryActions =
    parsed.intent.kind === "ImportUrl"
      ? []
      : queryActionEntries({
          query: parsed.text,
          searchHref: searchHref(parsed.searchQuery),
          todayAppend: input.todayAppend,
        });
  const resultGroup = group({
    id: "Results",
    label: "Results",
    layout: "Flow",
    entries: results,
  });
  const queryGroup = group({
    id: "QueryActions",
    label: "Do with query",
    layout: input.surface === "Mobile" ? "PinnedBelowInput" : "Flow",
    entries: queryActions,
  });
  const groups =
    input.surface === "Desktop"
      ? [...resultGroup, ...queryGroup]
      : [...queryGroup, ...resultGroup];
  const orderedEntries = groups.flatMap((group) => group.entries);
  return {
    surface: input.surface,
    groups,
    activeKey: activeProjectionKey(orderedEntries, input.activeKey),
  };
}
