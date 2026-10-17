// Pure projection: panes, places, commands, history, openables and owned search become
// ranked rows and groups. `mergeResults` keeps the active row stable while late sources land.
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
} from "lucide-react";
import { DESTINATIONS, getDestination, type Destination, type DestinationId } from "@/lib/navigation/destinations";
import {
  getPaneRouteIcon,
  resolveWorkspaceActivationRouteId,
} from "@/lib/panes/paneRouteModel";
import type { ResourceItem } from "@/lib/resources/items";
import { resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { searchHref } from "@/lib/search/searchParams";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  NexusAction,
  NexusCommandId,
  NexusGroup,
  NexusPage,
  NexusPane,
  NexusRankTier,
  NexusRecent,
  NexusRow,
  NexusRootMode,
} from "./model";
import { chatHref, NEXUS_COMMANDS, nexusBrowseTarget, type BrowseKind, type NexusQuery } from "./query";

const RESULT_CAP = 8;
const OPEN_CAP = 5;
const RECENT_CAP = 4;
const TIERS: readonly NexusRankTier[] = [
  "ExplicitIntent",
  "Exact",
  "PrefixOrToken",
  "CurrentContext",
  "FuzzyOrSynonym",
  "MetadataOrFullText",
];
const KEY_KINDS = ["Pane", "Destination", "Resource", "QuickAction", "ImportUrl", "Intent", "ManageTabs", "Continuation"];
const UNRANKED = { tier: "CurrentContext", score: 0, frecency: 0 } as const;
const MOBILE_PLACES: readonly DestinationId[] = ["lectern", "libraries", "browse", "podcasts", "chats", "notes"];
const BROWSE_LABELS: Record<BrowseKind, string> = { WebArticle: "articles", Podcast: "podcasts", Video: "videos", Epub: "books" };

type Frecency = Readonly<Record<string, number>>;

/** The ranked result rows of one query identity and the row the keyboard acts on. */
export interface NexusList {
  readonly identity: string;
  readonly rows: readonly NexusRow[];
  readonly active: string | null;
  readonly moved: boolean;
}

export const EMPTY_LIST: NexusList = { identity: "", rows: [], active: null, moved: false };

function prefixOrToken(query: string, candidate: string): boolean {
  return candidate.startsWith(query) || candidate.split(/\s+/).some((token) => token.startsWith(query));
}

function fuzzy(query: string, candidate: string): boolean {
  let cursor = 0;
  for (const character of query) {
    cursor = candidate.indexOf(character, cursor) + 1;
    if (cursor === 0) return false;
  }
  return true;
}

function textTier(
  rawQuery: string,
  rawLabel: string,
  input: { aliases?: readonly string[]; metadata?: readonly string[]; currentContext?: boolean },
): NexusRankTier | null {
  const query = rawQuery.trim().toLowerCase();
  const label = rawLabel.trim().toLowerCase();
  const near = input.currentContext ? "CurrentContext" : "FuzzyOrSynonym";
  if (label === query) return "Exact";
  if (prefixOrToken(query, label)) return "PrefixOrToken";
  const aliases = (input.aliases ?? []).map((alias) => alias.trim().toLowerCase());
  if (aliases.some((alias) => prefixOrToken(query, alias) || fuzzy(query, alias)) || fuzzy(query, label)) return near;
  return (input.metadata ?? []).some((value) => fuzzy(query, value.trim().toLowerCase())) ? "MetadataOrFullText" : null;
}

function compareRows(left: NexusRow, right: NexusRow): number {
  return (
    TIERS.indexOf(left.rank.tier) - TIERS.indexOf(right.rank.tier) ||
    right.rank.score - left.rank.score ||
    right.rank.frecency - left.rank.frecency ||
    KEY_KINDS.indexOf(left.key.split(":")[0]!) - KEY_KINDS.indexOf(right.key.split(":")[0]!) ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
}

export function tabState(pane: NexusPane): "Current" | "Open" | "Minimized" {
  return pane.current ? "Current" : pane.visibility === "minimized" ? "Minimized" : "Open";
}

function tabRow(pane: NexusPane, tier: NexusRankTier, frecency: Frecency): NexusRow {
  return {
    key: `Pane:${pane.id}`,
    label: pane.presentation.title,
    icon: getPaneRouteIcon(pane.href),
    type: "Tab",
    detail: pane.presentation.detail ?? undefined,
    state: tabState(pane),
    action: { kind: "Available", target: { kind: "PaneOpen", paneId: pane.id } },
    secondary: { kind: "CloseTab", paneId: pane.id },
    source: "Workspace",
    rank: { tier, score: pane.current ? 1 : 0, frecency: frecency[pane.href] ?? 0 },
  };
}

function placeRow(place: Destination, tier: NexusRankTier, frecency: Frecency): NexusRow {
  const today = place.id === "today";
  return {
    key: `Destination:${place.id}`,
    label: place.label,
    icon: place.icon ?? getPaneRouteIcon(place.href),
    type: "Place",
    action: {
      kind: "Available",
      target: today
        ? { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "View" } }
        : { kind: "InternalHref", href: place.href, labelHint: place.label },
    },
    source: today ? undefined : "Static",
    rank: { tier, score: 0, frecency: frecency[place.href] ?? 0 },
  };
}

function commandRow(id: NexusCommandId, tier: NexusRankTier, argument: string): NexusRow {
  const command = NEXUS_COMMANDS[id];
  return {
    key: `QuickAction:${id}`,
    label: command.label,
    icon: command.icon,
    type: "Command",
    detail: argument || `${command.category} · ${command.alias.trimEnd()}`,
    action: { kind: "Available", target: command.target(argument) },
    rank: { tier, score: 0, frecency: 0 },
  };
}

function askRow(key: string, text: string, detail: string | undefined, tier: NexusRankTier): NexusRow {
  return {
    key,
    label: `Ask Nexus about “${text}”`,
    icon: MessageSquarePlus,
    type: "Chat",
    detail,
    action: { kind: "Available", target: { kind: "InternalHref", href: chatHref(text), labelHint: "New chat" } },
    rank: { tier, score: 0, frecency: 0 },
  };
}

function appendToToday(text: string): NexusAction {
  return {
    kind: "Available",
    target: { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "AppendNote", initialText: text } },
  };
}

function localRows(query: NexusQuery, panes: readonly NexusPane[], frecency: Frecency): NexusRow[] {
  const { intent, text } = query;
  const explicit: NexusRow[] = [];
  if (intent.kind === "ImportUrl") {
    explicit.push({
      key: `ImportUrl:${intent.url}`,
      label: "Import URL",
      icon: LinkIcon,
      type: "URL",
      detail: intent.url,
      action: { kind: "Available", target: NEXUS_COMMANDS["Nexus.Quick.Import"].target(intent.url) },
      rank: { tier: "Exact", score: 1, frecency: 0 },
    });
  } else if (intent.kind === "Command") {
    explicit.push(commandRow(intent.id, "ExplicitIntent", intent.argument));
  } else if (intent.kind === "Ask") {
    explicit.push(askRow("Intent:Ask", intent.argument, "Explicit intent", "ExplicitIntent"));
  } else if (intent.kind === "ChooseBrowse") {
    explicit.push({
      key: "Intent:ChooseBrowse",
      label: intent.query ? `Browse for “${intent.query}”…` : "Browse…",
      icon: Globe,
      type: "Browse",
      detail: "Choose a kind",
      action: { kind: "Available", target: { kind: "ChooseBrowse", query: intent.query } },
      rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  } else if (intent.kind === "Browse") {
    const kind = BROWSE_LABELS[intent.browseKind];
    explicit.push({
      key: `Intent:Browse.${intent.browseKind}`,
      label: intent.query ? `Browse ${kind} for “${intent.query}”…` : `Browse ${kind}…`,
      icon: Globe,
      type: "Browse",
      detail: "Explicit kind",
      action: { kind: "Available", target: nexusBrowseTarget(intent.query, intent.browseKind) },
      rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  }
  const tabs = panes.flatMap((pane) => {
    const tier = textTier(text, pane.presentation.title, { aliases: [pane.href], currentContext: true });
    return tier ? [tabRow(pane, tier, frecency)] : [];
  });
  const places = DESTINATIONS.flatMap((place) => {
    const tier = textTier(text, place.label, { aliases: place.keywords, metadata: [place.href] });
    return tier ? [placeRow(place, tier, frecency)] : [];
  });
  const commands =
    intent.kind !== "Search"
      ? []
      : (Object.keys(NEXUS_COMMANDS) as NexusCommandId[]).flatMap((id) => {
          const tier = textTier(text, NEXUS_COMMANDS[id].label, { aliases: NEXUS_COMMANDS[id].keywords });
          return tier ? [commandRow(id, tier, "")] : [];
        });
  return [...explicit, ...tabs, ...places, ...commands];
}

function openableRows(query: string, items: readonly ResourceItem[], panes: readonly NexusPane[], frecency: Frecency): NexusRow[] {
  const openRoutes = new Set(panes.map((pane) => resolveWorkspaceActivationRouteId(pane.href)));
  return items.flatMap((item) => {
    const href = item.activation.href;
    if (item.missing || item.activation.kind !== "route" || href === null || openRoutes.has(resolveWorkspaceActivationRouteId(href))) {
      return [];
    }
    return [
      {
        key: `Resource:${item.ref}`,
        label: item.label,
        icon: getPaneRouteIcon(href),
        type: resourceTypeLabel(item.scheme),
        detail: item.summary || undefined,
        action: { kind: "Available", target: { kind: "InternalHref", href, labelHint: item.label } },
        secondary: { kind: "ResourceMenu", resourceRef: assumeCanonicalResourceRef(item.ref) },
        source: "Oracle",
        rank: {
          tier: textTier(query, item.label, { metadata: [item.summary] }) ?? "MetadataOrFullText",
          score: 0,
          frecency: frecency[href] ?? 0,
        },
      },
    ];
  });
}

/** Owner rows yield to their open tab; children show only under that tab or their owner row. */
function searchRows(query: string, results: readonly SearchResultRowViewModel[], panes: readonly NexusPane[], frecency: Frecency): NexusRow[] {
  const labelOf = (result: SearchResultRowViewModel) => ("mediaSummary" in result ? result.mediaSummary.title : result.primaryText);
  const owners = new Map(
    results
      .filter((result) => result.resourceRef === result.ownerResourceRef)
      .map((result) => [result.ownerResourceRef, { key: `Resource:${result.resourceRef}`, label: labelOf(result) }]),
  );
  return results.flatMap((result): NexusRow[] => {
    const href = result.activation.href;
    if (result.activation.kind !== "route" || href === null) return [];
    const owner = result.resourceRef === result.ownerResourceRef;
    const routeId = resolveWorkspaceActivationRouteId(href);
    const pane = panes.find((candidate) => resolveWorkspaceActivationRouteId(candidate.href) === routeId);
    const paneParent =
      pane && textTier(query, pane.presentation.title, { aliases: [pane.href], currentContext: true })
        ? { key: `Pane:${pane.id}`, label: pane.presentation.title }
        : undefined;
    const parent = paneParent ?? (owner ? undefined : owners.get(result.ownerResourceRef));
    if (owner ? paneParent : !parent) return [];
    const label = labelOf(result);
    const detail = "mediaSummary" in result ? undefined : (result.sourceMeta ?? undefined);
    return [
      {
        key: `Resource:${result.resourceRef}`,
        label,
        icon: SEARCH_TYPE_ICON[result.type],
        type: "mediaSummary" in result ? result.type : result.typeLabel,
        detail,
        snippet: result.snippetSegments,
        parent,
        action: { kind: "Available", target: { kind: "InternalHref", href, labelHint: label } },
        secondary: { kind: "ResourceMenu", resourceRef: result.actionRef },
        source: "Search",
        rank: {
          tier: textTier(query, label, { metadata: detail ? [detail] : [] }) ?? "MetadataOrFullText",
          score: result.score,
          frecency: owner ? (frecency[href] ?? 0) : 0,
        },
      },
    ];
  });
}

/** Local, openable and owned rows for a typed query: deduped in that precedence, ranked, children after their parent. */
export function candidateRows(input: {
  readonly query: NexusQuery;
  readonly panes: readonly NexusPane[];
  readonly frecency: Frecency;
  readonly openables: readonly ResourceItem[];
  readonly search: readonly SearchResultRowViewModel[];
  readonly retained?: readonly NexusRow[];
}): NexusRow[] {
  const { query, panes, frecency } = input;
  if (!query.text) return [];
  const unique = new Map<string, NexusRow>();
  for (const row of [
    ...localRows(query, panes, frecency),
    ...openableRows(query.text, input.openables, panes, frecency),
    ...searchRows(query.text, input.search, panes, frecency),
    ...(input.retained ?? []),
  ]) {
    if (!unique.has(row.key)) unique.set(row.key, row);
  }
  const groups = new Map<string, NexusRow[]>();
  for (const row of [...unique.values()].sort(compareRows)) {
    const group = row.parent?.key ?? row.key;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return [...groups].flatMap(([key, rows]) => [
    ...rows.filter((row) => row.key === key),
    ...rows.filter((row) => row.key !== key),
  ]);
}

function firstInOrder(incoming: readonly NexusRow[], stable: readonly NexusRow[]): NexusRow[] {
  const byKey = new Map(incoming.map((row) => [row.key, row]));
  const kept = stable.flatMap((row) => byKey.get(row.key) ?? []);
  return [...kept, ...incoming.filter((row) => !kept.includes(row))].slice(0, RESULT_CAP);
}

/**
 * A new query identity restarts on its first row. For the same identity the active row keeps its
 * identity: a moved list keeps every row up to it in place (all rows when the active row
 * is a query action); an unmoved list re-ranks, reserving the active row (and its parent)
 * at the end when it would fall past the cap. A vanished active row keeps its index.
 */
export function mergeResults(previous: NexusList, identity: string, incoming: readonly NexusRow[]): NexusList {
  if (previous.identity !== identity || previous.active === null) {
    const rows = incoming.slice(0, RESULT_CAP);
    return { identity, rows, active: rows[0]?.key ?? null, moved: previous.identity === identity && previous.moved };
  }
  const { active, moved } = previous;
  const index = previous.rows.findIndex((row) => row.key === active);
  const kept = incoming.find((row) => row.key === active);
  if (index >= 0 && !kept) {
    const rows = firstInOrder(incoming, moved ? previous.rows.slice(0, index) : []);
    return { identity, rows, active: rows[Math.min(index, rows.length - 1)]?.key ?? null, moved };
  }
  if (moved) {
    return { identity, rows: firstInOrder(incoming, index < 0 ? previous.rows : previous.rows.slice(0, index + 1)), active, moved };
  }
  const ranked = incoming.slice(0, RESULT_CAP);
  if (!kept || ranked.includes(kept)) return { identity, rows: ranked, active, moved };
  const parent = incoming.find((row) => row.key === kept.parent?.key);
  const reserved = parent ? [parent, kept] : [kept];
  const rest = incoming.filter((row) => !reserved.includes(row)).slice(0, RESULT_CAP - reserved.length);
  return { identity, rows: [...rest, ...reserved], active, moved };
}

export function playbackRow(title: string, subtitle: string | undefined): NexusRow {
  return {
    key: "Resource:Playback:Current",
    label: title,
    icon: Play,
    type: "Media",
    detail: subtitle,
    action: { kind: "Available", target: { kind: "ResumeCurrentPlayback" } },
    rank: UNRANKED,
  };
}

export function queryActions(query: NexusQuery, desktop: boolean): NexusRow[] {
  const q = query.text;
  const row = (id: string, label: string, icon: NexusRow["icon"], type: string | undefined, detail: string | undefined, action: NexusAction): NexusRow => ({
    key: `Continuation:${id}`,
    label,
    icon,
    type,
    detail,
    action,
    rank: UNRANKED,
  });
  return [
    askRow("Continuation:Ask", q, desktop ? "Ask Nexus" : undefined, "CurrentContext"),
    row("AddToToday", `Add “${q}” to Today`, FileText, desktop ? "Today" : undefined, "Append note", appendToToday(q)),
    row("Browse", `Browse for “${q}”…`, Globe, desktop ? "Browse" : undefined, "Choose a kind", {
      kind: "Available",
      target: { kind: "ChooseBrowse", query: q },
    }),
    row("Create", `Create “${q}”…`, FilePlus2, desktop ? "Create" : undefined, "Choose a type", {
      kind: "Available",
      target: { kind: "ChooseCreate", initialDraft: q },
    }),
    {
      ...row("SeeAll", `See all results for “${q}”`, Search, "Search", desktop ? "All results" : undefined, {
        kind: "Available",
        target: { kind: "InternalHref", href: searchHref(query.searchQuery), labelHint: "Search" },
      }),
      source: "Search",
    },
  ];
}

/** Blank: Open, Continue, Recent, Quick Actions (mobile adds Places, and strips type labels). Typed: Results, Do with query. */
export function nexusGroups(input: {
  readonly desktop: boolean;
  readonly mobileMode: NexusRootMode;
  readonly query: NexusQuery;
  readonly list: NexusList;
  readonly panes: readonly NexusPane[];
  readonly playback: NexusRow | null;
  readonly recent: readonly NexusRecent[];
  readonly frecency: Frecency;
}): NexusGroup[] {
  const { desktop, query, panes, frecency } = input;
  const group = (id: NexusGroup["id"], label: string, rows: readonly NexusRow[]): NexusGroup[] =>
    rows.length === 0 ? [] : [{ id, label, rows }];
  if (query.text) {
    if (!desktop && input.mobileMode === "Overview") return mobileOverview(input);
    const actions = queryActions(query, desktop);
    return [
      ...group("Results", desktop ? "Results" : "results", desktop ? input.list.rows : input.list.rows.map(mobileRow)),
      ...group("QuickActions", desktop ? "Do with query" : "", desktop
        ? query.intent.kind === "ImportUrl" ? [] : actions
        : actions.filter((row) => row.key === "Continuation:SeeAll").map((row) => ({ ...row, label: "search all results", type: undefined, detail: undefined }))),
    ];
  }
  const plain = (row: NexusRow): NexusRow => (desktop ? row : { ...row, type: undefined });
  const open = [
    ...panes.slice(0, OPEN_CAP).map((pane) => tabRow(pane, "CurrentContext", frecency)),
    {
      key: "ManageTabs",
      label: "Manage tabs…",
      icon: PanelLeft,
      type: "Tabs",
      detail: "Close, restore, or reorder",
      action: { kind: "Available", target: { kind: "ManageTabs" } },
      rank: UNRANKED,
    } satisfies NexusRow,
  ];
  const seen = new Set(panes.map((pane) => resolveWorkspaceActivationRouteId(pane.href)));
  const recent = input.recent.flatMap((entry): NexusRow[] => {
    const routeId = resolveWorkspaceActivationRouteId(entry.target_href);
    if (seen.has(routeId)) return [];
    seen.add(routeId);
    return [
      {
        key: `Resource:Route:${entry.target_href}`,
        label: entry.label_snapshot,
        icon: getPaneRouteIcon(entry.target_href),
        type: "Recent",
        action: { kind: "Available", target: { kind: "InternalHref", href: entry.target_href, labelHint: entry.label_snapshot } },
        source: "Recent",
        rank: { ...UNRANKED, frecency: frecency[entry.target_href] ?? 0 },
      },
    ];
  });
  const command = (id: NexusCommandId) => plain(commandRow(id, "CurrentContext", ""));
  const quick = [
    command("Nexus.Quick.Note"),
    plain(placeRow(getDestination("today"), "CurrentContext", frecency)),
    command("Nexus.Quick.Chat"),
    command("Nexus.Quick.Page"),
    command("Nexus.Quick.Library"),
    command("Nexus.Quick.Import"),
  ];
  const openGroup = group("Open", "Open", open);
  const continueGroup = group("Continue", "Continue", input.playback ? [input.playback] : []);
  const recentGroup = group("Recent", "Recent", recent.slice(0, RECENT_CAP).map(plain));
  const quickGroup = group("QuickActions", "Quick Actions", quick);
  if (desktop) return [...openGroup, ...continueGroup, ...recentGroup, ...quickGroup];
  if (input.mobileMode === "Search") return recentGroup.map((group) => ({ ...group, label: "recent", rows: group.rows.map(mobileRow) }));
  return mobileOverview(input);
}

function mobileRow(row: NexusRow): NexusRow {
  if (row.key.startsWith("Pane:") || row.key.startsWith("Resource:")) return row;
  return {
    ...row,
    label: row.key.startsWith("QuickAction:") || row.key.startsWith("Destination:")
      ? row.label.toLowerCase()
      : row.label.replace(/^Ask Nexus/, "ask nexus").replace(/^Browse/, "browse").replace(/^Import URL/, "import url"),
    detail: row.key.startsWith("ImportUrl:") ? row.detail : undefined,
  };
}

function mobileOverview(input: {
  readonly panes: readonly NexusPane[];
  readonly frecency: Frecency;
  readonly playback: NexusRow | null;
}): NexusGroup[] {
  const visible = input.panes.filter((pane) => pane.visibility === "visible");
  const current = visible.findIndex((pane) => pane.current);
  const start = Math.max(0, Math.min(current - 1, visible.length - 3));
  const place = (id: DestinationId) => mobileRow(placeRow(getDestination(id), "CurrentContext", input.frecency));
  return [
    { id: "Open", label: "open tabs", rows: visible.slice(start, start + 3).map((pane) => tabRow(pane, "CurrentContext", input.frecency)) },
    { id: "Places", label: "places", rows: MOBILE_PLACES.map(place) },
    { id: "QuickActions", label: "", rows: [
      place("today"),
      { key: "QuickAction:New", label: "new…", icon: FilePlus2, action: { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } }, rank: UNRANKED },
      mobileRow(commandRow("Nexus.Quick.Import", "CurrentContext", "")),
    ] },
    ...(input.playback ? [{ id: "Continue", label: "", rows: [{ ...input.playback, label: `resume ${input.playback.label}`, type: undefined }] } satisfies NexusGroup] : []),
  ];
}

/** The rows of a choice page: what to create from a draft, or which kind to browse. */
export function choiceRows(page: NexusPage, mobile: boolean): NexusRow[] {
  const choice = (label: string, icon: NexusRow["icon"], action: NexusAction): NexusRow => ({
    key: `Choice:${label}`,
    label,
    icon,
    action,
    rank: UNRANKED,
  });
  if (page.kind === "ChooseCreate") {
    const target = (id: NexusCommandId): NexusAction => ({ kind: "Available", target: NEXUS_COMMANDS[id].target(page.draft) });
    return [
      choice(mobile ? page.draft ? "add to today" : "quick note" : "Today Note", FileText, appendToToday(page.draft)),
      choice(mobile ? "page" : "Page", FilePlus2, target("Nexus.Quick.Page")),
      choice(mobile ? "chat" : "Chat", MessageSquarePlus, target("Nexus.Quick.Chat")),
      choice(mobile ? "library" : "Library", Library, target("Nexus.Quick.Library")),
    ];
  }
  if (page.kind !== "ChooseBrowse") return [];
  return (
    [
      ["Articles", "WebArticle"],
      ["Podcasts", "Podcast"],
      ["Videos", "Video"],
      ["Books", "Epub"],
    ] as const
  ).map(([label, kind]) => choice(mobile ? label.toLowerCase() : label, Globe, { kind: "Available", target: nexusBrowseTarget(page.query, kind) }));
}

/** "type · detail · parent · state", deduped; mobile omits the parent and says "Current", not "Current tab". */
export function rowFacts(row: NexusRow, desktop: boolean): string {
  if (!desktop) {
    const type = row.type && !["Tab", "Place", "Command", "Recent", "Browse"].includes(row.type) ? row.type.toLowerCase() : undefined;
    const facts = [row.detail, type, row.state && row.state !== "Open" ? row.state.toLowerCase() : undefined];
    return facts.filter((fact, index): fact is string => Boolean(fact) && facts.indexOf(fact) === index).join(" · ");
  }
  const facts = [row.type, row.detail, desktop ? row.parent?.label : undefined, row.state && (desktop ? `${row.state} tab` : row.state)];
  return facts.filter((fact, index): fact is string => Boolean(fact) && facts.indexOf(fact) === index).join(" · ");
}
