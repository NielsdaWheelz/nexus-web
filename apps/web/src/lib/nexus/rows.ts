// Launcher composition: local navigation, resources and evidence have separate budgets.
// Selection preserves identity; deliberate movement also pins the visible prefix.
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
import type { Schema } from "@/lib/api/wire";
import { DESTINATIONS, getDestination, type Destination, type DestinationId } from "@/lib/navigation/destinations";
import {
  getPaneRouteIcon,
  resolvePaneRouteModel,
  resolveWorkspaceActivationRouteId,
} from "@/lib/panes/paneRouteModel";
import { parseResourceRef, resourceIconForScheme, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "@/lib/resources/items";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { searchHref } from "@/lib/search/searchParams";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  NexusAction,
  NexusCommandId,
  NexusGroup,
  NexusHomeSection,
  NexusPage,
  NexusPane,
  NexusRankTier,
  NexusRecent,
  NexusRow,
  NexusRootMode,
} from "./model";
import { chatHref, NEXUS_COMMANDS, nexusBrowseTarget, type BrowseKind, type NexusQuery } from "./query";

const SECTION_CAPS = { Commands: 4, Resources: 4, Saved: 2, Inside: 2 } as const;
const SECTIONS = Object.keys(SECTION_CAPS) as NexusHomeSection[];
const SECTION_LABELS = { BestMatch: "best match", Commands: "commands & places", Resources: "resources", Saved: "saved passages", Inside: "inside sources" } as const;
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
      rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  } else if (intent.kind === "Command") {
    explicit.push(commandRow(intent.id, "ExplicitIntent", intent.argument));
  } else if (intent.kind === "Destination") {
    explicit.push(placeRow(getDestination(intent.id), "ExplicitIntent", frecency));
  } else if (intent.kind === "ChooseCreate") {
    explicit.push({
      key: "Intent:ChooseCreate", label: "New…", icon: FilePlus2, type: "Command",
      action: { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } },
      rank: { tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
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
  const tabs = panes.filter((pane) => pane.resourceRef === null && resolvePaneRouteModel(pane.href).header.kind !== "Resource").flatMap((pane) => {
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
  const unique = new Map<string, NexusRow>();
  for (const row of [...explicit, ...places, ...commands]) if (!unique.has(row.key)) unique.set(row.key, row);
  for (const row of tabs) {
    const pane = panes.find((pane) => `Pane:${pane.id}` === row.key)!;
    const place = [...unique.values()].find((candidate) => candidate.action.kind === "Available"
      && candidate.action.target.kind === "InternalHref"
      && resolveWorkspaceActivationRouteId(candidate.action.target.href) === resolveWorkspaceActivationRouteId(pane.href));
    if (place) unique.set(place.key, { ...place, state: row.state, secondary: row.secondary });
    else unique.set(row.key, row);
  }
  return [...unique.values()].sort(compareRows).map((row) => ({ ...row, placement: { home: "Commands", promoted: false } }));
}

/** Preserve the resource owner's exact activation, including honest unavailability. */
export function resourceAction(item: ResourceItem): NexusAction {
  return item.activation.kind === "none"
    ? { kind: "Unavailable", reason: item.activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable" : "source unavailable" }
    : { kind: "Available", target: { kind: "Resource", activation: item.activation, label: item.label } };
}

function resourceMenu(ref: string, panes: readonly NexusPane[]): Extract<NonNullable<NexusRow["secondary"]>, { kind: "ResourceMenu" }> {
  return {
    kind: "ResourceMenu", resourceRef: assumeCanonicalResourceRef(ref),
    closePanes: panes.map((pane, index) => ({ id: pane.id, label: pane.current ? "close current tab" : panes.length > 1 ? `close tab ${index + 1}` : "close tab" })),
  };
}

function resourceRow(item: ResourceItem, home: NexusHomeSection, panes: readonly NexusPane[]): NexusRow {
  const ref = parseResourceRef(item.ref)!;
  const matching = panes.filter((candidate) => candidate.resourceRef === item.ref);
  const pane = matching.find((pane) => pane.current) ?? matching[0];
  return {
    key: `Resource:${item.ref}`, label: item.label, item,
    icon: resourceIconForScheme(ref.scheme), type: resourceTypeLabel(ref.scheme),
    state: pane ? tabState(pane) : undefined,
    action: resourceAction(item),
    secondary: resourceMenu(item.action_ref, matching),
    source: "Search", rank: UNRANKED, placement: { home, promoted: false },
  };
}

/** Server order is authoritative inside each resource band; only local navigation ranks here. */
export function candidateRows(input: {
  readonly query: NexusQuery;
  readonly panes: readonly NexusPane[];
  readonly frecency: Frecency;
  readonly preview: Schema<"SearchPreviewResponse"> | null;
  readonly reference: ResourceItem | null;
  readonly referenceFailed: boolean;
  readonly retained: readonly NexusRow[];
}): NexusRow[] {
  const { query, panes, frecency, preview } = input;
  if (!query.text) return [];
  if (query.intent.kind === "Resource") {
    const row = input.reference ? resourceRow(input.reference, "Commands", panes) : {
      key: `Resource:${query.intent.ref}`, label: query.intent.ref,
      icon: resourceIconForScheme(parseResourceRef(query.intent.ref)!.scheme),
      action: { kind: "Unavailable", reason: input.referenceFailed ? "resource lookup failed" : "looking up resource…" },
      placement: { home: "Commands", promoted: false },
    } satisfies Partial<NexusRow>;
    return [{ ...row, rank: { tier: "ExplicitIntent", score: 0, frecency: 0 } }];
  }
  const rows = localRows(query, panes, frecency);
  for (const result of [...(preview?.resources ?? []), ...(preview?.saved ?? [])]) {
    rows.push({
      ...resourceRow(result.item, result.section === "saved" ? "Saved" : "Resources", panes),
      match: result.match, matchMethod: result.match_method, matchingPassage: result.matching_passage,
      rank: { ...UNRANKED, tier: result.name_match === "exact" ? "Exact" : "MetadataOrFullText" },
    });
  }
  const filters = query.searchQuery;
  if (filters.requestedKinds === null && filters.formats.length === 0 && filters.authors.length === 0
    && filters.roles.length === 0 && filters.scope === "all") {
    for (const pane of panes) {
      if (pane.resourceRef === null || pane.presentation.status === "Unavailable"
        || rows.some((row) => row.key === `Resource:${pane.resourceRef}`)
        || textTier(filters.text, pane.presentation.title, { currentContext: true }) === null) continue;
      const matching = panes.filter((candidate) => candidate.resourceRef === pane.resourceRef);
      rows.push({
        ...tabRow(pane, "CurrentContext", frecency), key: `Resource:${pane.resourceRef}`,
        state: tabState(matching.find((pane) => pane.current) ?? pane),
        action: { kind: "Available", target: { kind: "InternalHref", href: resolvePaneRouteModel(pane.href).pathname, labelHint: pane.presentation.title } },
        secondary: resourceMenu(pane.resourceRef, matching),
        placement: { home: "Resources", promoted: false },
      });
    }
  }
  for (const passage of preview?.passages ?? []) rows.push({
    ...resourceRow(passage.item, "Inside", panes), match: passage.match, matchMethod: passage.match_method,
  });
  // A bounded preview's omission is not a deletion. Retain prior server evidence only
  // as a candidate; caps and the selected prefix still decide whether it is displayed.
  for (const previous of input.retained) {
    if (!previous.item || rows.some((row) => row.key === previous.key)) continue;
    const current = resourceRow(previous.item, previous.placement!.home, panes);
    rows.push({ ...previous, state: current.state, secondary: current.secondary });
  }
  return rows;
}

/** A moved prefix keeps both its displayed section and primary target. */
export function mergeResults(previous: NexusList, identity: string, candidates: readonly NexusRow[]): NexusList {
  const same = previous.identity === identity;
  let active = same ? previous.active : null;
  let moved = same && previous.moved;
  const selected = same ? previous.rows.find((row) => row.key === active) : null;
  const incoming = candidates.map((row) => row.key === selected?.key
    ? { ...row, action: selected.action } : row);
  const byKey = new Map(incoming.map((row) => [row.key, row]));
  const activeIndex = previous.rows.findIndex((row) => row.key === active);
  const footer = active?.startsWith("Continuation:") ?? false;
  if (active !== null && !byKey.has(active) && !footer) {
    active = null;
    moved = true; // A removed target must not silently select its neighbour.
  }
  const stable: NexusRow[] = same && previous.moved
    ? previous.rows.slice(0, footer ? undefined : activeIndex + 1).flatMap((old) => {
      const next = byKey.get(old.key);
      return next ? [{
        ...next, placement: old.placement,
        match: next.match ?? old.match, matchingPassage: next.matchingPassage ?? old.matchingPassage,
        action: old.action,
      }] : [];
    }) : [];
  const held = new Set(stable.map((row) => row.key));
  const last = stable[stable.length - 1]?.placement;
  const floor = last && !last.promoted ? SECTIONS.indexOf(last.home) : -1;
  const rows = [...stable];
  for (const home of SECTIONS) {
    if (SECTIONS.indexOf(home) < floor) continue;
    const room = SECTION_CAPS[home] - stable.filter((row) => row.placement?.home === home).length;
    const pool = incoming.filter((row) => row.placement?.home === home && !held.has(row.key));
    const selected = pool.slice(0, room);
    const current = !moved ? pool.find((row) => row.key === active) : null;
    if (current && room > 0 && !selected.includes(current)) selected.splice(room - 1, 1, current);
    rows.push(...selected.map((row) => ({ ...row, placement: { home, promoted: false } })));
  }
  if (stable.length === 0) {
    const promoted = rows.find((row) => row.rank.tier === "ExplicitIntent")
      ?? rows.find((row) => row.placement?.home === "Commands" && row.rank.tier === "Exact"
        && (row.key.startsWith("Destination:") || row.key.startsWith("QuickAction:")))
      ?? rows.find((row) => row.placement?.home === "Resources" && row.rank.tier === "Exact");
    if (promoted) {
      rows.splice(rows.indexOf(promoted), 1);
      rows.unshift({ ...promoted, placement: { home: promoted.placement!.home, promoted: true } });
    }
  }
  // Resolve duplicates against the final visible resources, including pinned rows.
  const sources = new Map(rows.filter((row) => row.placement?.home === "Resources").map((row) => [row.key, row]));
  const suppressed = new Set<string>();
  for (const row of rows) {
    const owner = row.placement?.home === "Inside" ? row.item?.preview.source?.ref : null;
    const source = owner ? sources.get(`Resource:${owner}`) : null;
    if (!source || !row.item || !row.matchMethod) continue;
    if (row.key === active) {
      suppressed.add(source.key);
      continue;
    }
    const index = rows.indexOf(source);
    rows[index] = { ...source, matchingPassage: source.matchingPassage ?? {
      item: row.item, match: row.match ?? null, match_method: row.matchMethod,
    } };
    suppressed.add(row.key);
  }
  const visible = rows.filter((row) => !suppressed.has(row.key));
  if (active === null && !moved) active = visible[0]?.key ?? null;
  return { identity, rows: visible, active, moved };
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

/** Blank workspace groups keep their existing shape; typed queries show intent/resource bands. */
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
      ...(["BestMatch", ...SECTIONS] as const).flatMap((id) => group(id, SECTION_LABELS[id],
        input.list.rows.filter((row) => (row.placement?.promoted ? "BestMatch" : row.placement?.home) === id)
          .map((row) => desktop ? row : mobileRow(row)))),
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
  if (row.item) return [resourceMetadataText(row.item, row.matchMethod), row.state?.toLowerCase()].filter(Boolean).join(" · ");
  if (!desktop) {
    const type = row.type && !["Tab", "Place", "Command", "Recent", "Browse"].includes(row.type) ? row.type.toLowerCase() : undefined;
    const facts = [row.detail, type, row.state && row.state !== "Open" ? row.state.toLowerCase() : undefined];
    return facts.filter((fact, index): fact is string => Boolean(fact) && facts.indexOf(fact) === index).join(" · ");
  }
  const facts = [row.type, row.detail, desktop ? row.parent?.label : undefined, row.state && (desktop ? `${row.state} tab` : row.state)];
  return facts.filter((fact, index): fact is string => Boolean(fact) && facts.indexOf(fact) === index).join(" · ");
}
