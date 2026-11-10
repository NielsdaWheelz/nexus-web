// Candidate rows per stream: the synchronous set at a keystroke, the arrivals after it, the blank
// list, the continuations and the places chips. Ordering is rank.ts's; bands are list.ts's.
import { recentTargetKey, type RecentEntry } from "@/lib/recent/model";
import type { PanePresentation } from "@/lib/workspace/presentations";
import { authoredItem } from "@/lib/notes/presentation";
import { linkPointer } from "@/lib/imports/lineView";
import { ADMIT_LIMIT } from "@/lib/imports/intake";
import * as Icon from "@/lib/ui/icons";
import type { Schema } from "@/lib/api/wire";
import { creditName } from "@/lib/contributors/credits";
import { DESTINATIONS, getDestination, type Destination, type DestinationId } from "@/lib/navigation/destinations";
import { getPaneRouteIcon, resolvePaneRouteModel, resolveWorkspaceActivationRouteId } from "@/lib/panes/paneRouteModel";
import { parseResourceRef, resourceIconForScheme } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "@/lib/resources/items";
import { itemMediaKind, paneGlyph, resourceType, resourceTypeGlyph } from "@/lib/resources/type";
import type { LocalMatch } from "@/lib/search/localSearch";
import { resourceMetadata } from "@/lib/resources/metadata";
import { emptySearchQuery } from "@/lib/search/query";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { NexusAction, NexusCommandId, NexusGroup, NexusPage, NexusPane, NexusRow, NexusStream, NexusTarget, RankTier, UsageMap } from "./model";
import { rowPrimaryText } from "./rowText";
import { RESULT_CAP } from "./policy";
import { NEXUS_COMMANDS, nexusBrowseAction, nexusSearchAction, type BrowseKind, type NexusQuery } from "./query";
import { canonicalHref, compareRank, frecency, nameTier } from "./rank";

/** Other panes shown in the blank list before `expand tabs`. */
export const OPEN_CAP = 5;
const RECENT_CAP = 8;
const COMMAND_IDS = Object.keys(NEXUS_COMMANDS) as NexusCommandId[];
/** The sheet's places chips, rail order. */
const PLACES: readonly DestinationId[] = ["today", "lectern", "libraries", "browse", "podcasts", "feeds", "chats", "notes", "atlas", "oracle"];
const BROWSE_LABELS: Record<BrowseKind, string> = { WebArticle: "articles", Podcast: "podcasts", Video: "videos", Epub: "books" };
const NO_USAGE: UsageMap = {};
const UNSCORED = { href: null, evidence: false, frecency: 0, recency: 0 } as const;

export type RecentItem = { entry: RecentEntry; presentation: PanePresentation; resourceRef: string | null };

const rank = (stream: NexusStream, tier: RankTier) => ({ stream, tier });

function paneState(pane: NexusPane): "Current" | "Minimized" | undefined {
  return pane.current ? "Current" : pane.visibility === "minimized" ? "Minimized" : undefined;
}

function paneRow(pane: NexusPane, tier: RankTier, usage: UsageMap, recency: number): NexusRow {
  const { presentation } = pane;
  return {
    key: `Pane:${pane.id}`, localMatch: null, label: presentation.title, icon: paneGlyph(pane.href, presentation.mediaKind),
    detail: presentation.detail ?? undefined, keywords: presentation.status === "Ready" && presentation.detail ? [presentation.detail] : [],
    state: paneState(pane),
    action: { kind: "Available", target: { kind: "PaneOpen", paneId: pane.id } },
    secondary: { kind: "ClosePane", paneId: pane.id },
    learns_selection: true,
    href: pane.href, evidence: false, frecency: frecency(pane.href, usage), recency, rank: rank("Navigation", tier),
  };
}

function placeActionLabel(place: Destination): string {
  return place.id === "authors" ? "search people" : `open ${place.label.toLowerCase()}`;
}

/**
 * The identity a selection is learned under (law 10): the href its dispatch lands on. A day's page is
 * learned date-free as `/daily`, so `quick note` is one target across days; `remember` posts the same.
 */
export function learnedHref(target: NexusTarget): string | null {
  if (target.kind === "InternalHref") return target.href;
  if (target.kind === "OpenDailyPage") return getDestination("today").href;
  return null;
}

/** The Today place learns under no identity: `/daily` is `quick note`'s, and one identity names one row. */
const placeHref = (place: Destination): string | null => place.id === "today" ? null : place.href;

function placeRow(place: Destination, tier: RankTier, usage: UsageMap): NexusRow {
  const href = placeHref(place);
  return {
    key: `Destination:${place.id}`, localMatch: null,
    label: placeActionLabel(place),
    icon: place.icon ?? getPaneRouteIcon(place.href),
    detail: place.id === "authors" ? "authors and contributors" : undefined,
    action: {
      kind: "Available",
      target: href === null
        ? { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "View" } }
        : { kind: "InternalHref", href, labelHint: place.label },
    },
    learns_selection: href !== null,
    href, evidence: false, frecency: href === null ? 0 : frecency(href, usage), recency: 0, rank: rank("Navigation", tier),
  };
}

function commandRow(id: NexusCommandId, tier: RankTier, argument: string, usage: UsageMap, recency = 0): NexusRow {
  const command = NEXUS_COMMANDS[id];
  const action = command.action(argument);
  const href = action.kind === "Available" ? learnedHref(action.target) : null;
  return {
    key: `QuickAction:${id}`, localMatch: null,
    label: id === "Nexus.Quick.Note" && argument ? "save note to today" : command.label,
    icon: command.icon,
    detail: argument || undefined,
    action,
    learns_selection: href !== null,
    href, evidence: false, frecency: href === null ? 0 : frecency(href, usage), recency,
    rank: rank("Navigation", tier),
  };
}

/** Preserve the resource owner's exact activation, including honest unavailability. */
export function resourceAction(item: ResourceItem): NexusAction {
  return item.activation.kind === "none"
    ? { kind: "Unavailable", reason: item.activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable" : "source unavailable" }
    : { kind: "Available", target: { kind: "Resource", activation: item.activation, label: item.label } };
}

function targetMenu(ref: string | null, panes: readonly NexusPane[]): Extract<NonNullable<NexusRow["secondary"]>, { kind: "TargetMenu" }> {
  return {
    kind: "TargetMenu", resourceRef: ref === null ? null : assumeCanonicalResourceRef(ref),
    closePanes: panes.map(pane => ({ id: pane.id, label: pane.current ? "close current pane" : panes.length > 1 ? `close pane ${pane.position}` : "close pane" })),
  };
}

/** Contributor names a query may match as Substring. */
function itemKeywords(item: ResourceItem): string[] {
  return resourceMetadata({ item }).bibliography.flatMap(part => part.kind === "credits" ? part.credits.flatMap(credit => creditName(credit)?.label ?? []) : []);
}

function resourceRow(item: ResourceItem, panes: readonly NexusPane[], stream: NexusStream, tier: RankTier, usage: UsageMap): NexusRow {
  const ref = parseResourceRef(item.ref)!;
  const matching = panes.filter((candidate) => candidate.resourceRef === item.ref);
  const pane = matching.find((pane) => pane.current) ?? matching[0];
  const href = item.activation.kind === "route" ? item.activation.href : null;
  return {
    key: `Resource:${item.ref}`, localMatch: null, label: item.label, item,
    icon: resourceTypeGlyph(resourceType(ref.scheme, itemMediaKind(item))), keywords: itemKeywords(item),
    state: pane ? paneState(pane) : undefined,
    action: resourceAction(item),
    secondary: targetMenu(item.action_ref, matching),
    learns_selection: true,
    href, evidence: tier === "Lexical" || tier === "Semantic", frecency: href === null ? 0 : frecency(href, usage), recency: 0, rank: rank(stream, tier),
  };
}

/** A local authored match: the canonical label, the matched window as evidence, its exact target. */
function localRow(match: LocalMatch, panes: readonly NexusPane[], tier: RankTier, usage: UsageMap): NexusRow {
  const ref = match.resource.ref;
  const excerpt = match.excerpt;
  const matching = panes.filter((candidate) => candidate.resourceRef === ref);
  const pane = matching.find((pane) => pane.current) ?? matching[0];
  return {
    key: `Resource:${ref}`, localMatch: match, label: match.label,
    item: authoredItem(match.resource, match.readingRef, match.href),
    match: excerpt === null ? null : { excerpt: { text: excerpt.text, truncated_before: excerpt.before, truncated_after: excerpt.after }, ranges: excerpt.marks.map(([start, end]) => ({ start: Array.from(excerpt.text.slice(0, start)).length, end: Array.from(excerpt.text.slice(0, end)).length })) },
    icon: resourceIconForScheme(parseResourceRef(ref)!.scheme),
    state: pane ? paneState(pane) : undefined,
    action: match.href === null ? { kind: "Unavailable", reason: "source unavailable" }
      : { kind: "Available", target: { kind: "InternalHref", href: match.href, labelHint: match.label } },
    secondary: targetMenu(ref, matching),
    learns_selection: true,
    href: match.href, evidence: tier === "Lexical", frecency: match.href === null ? 0 : frecency(match.href, usage), recency: 0, rank: rank("Local", tier),
  };
}

function recentRow(item: RecentItem, panes: readonly NexusPane[], tier: RankTier, usage: UsageMap, blank: boolean): NexusRow {
  const { entry, presentation, resourceRef } = item;
  const matching = panes.filter(pane => resourceRef !== null ? pane.resourceRef === resourceRef : pane.href === entry.href);
  const pane = matching.find(candidate => candidate.current) ?? matching[0];
  return {
    key: !blank && resourceRef ? `Resource:${resourceRef}` : `Recent:${recentTargetKey(entry.target)}`,
    localMatch: null, recentEntry: entry, label: presentation.title, icon: paneGlyph(entry.href, presentation.mediaKind),
    detail: presentation.detail ?? undefined, keywords: presentation.status === "Ready" && presentation.detail ? [presentation.detail] : [],
    state: pane ? paneState(pane) : undefined,
    action: { kind: "Available", target: { kind: "InternalHref", href: entry.href, labelHint: presentation.title } },
    ...(resourceRef ? { secondary: targetMenu(resourceRef, matching) } : {}),
    learns_selection: true,
    href: entry.href, evidence: false, frecency: frecency(entry.href, usage), recency: Number(entry.used_revision), rank: rank("Recent", tier),
  };
}

type Reference = {
  readonly reference: ResourceItem | null;
  readonly referenceFailed: boolean;
  readonly localReference: LocalMatch | null;
  readonly localReferenceMissing: boolean;
};

/** The one row of an exact ref: its present state, keyed by the typed ref so each state updates in place. */
function referenceRow(ref: string, input: Reference, panes: readonly NexusPane[], usage: UsageMap): NexusRow {
  const row = input.localReference ? localRow(input.localReference, panes, "ExplicitIntent", usage)
    : input.reference ? resourceRow(input.reference, panes, "Resources", "ExplicitIntent", usage) : {
      key: "", localMatch: null, label: ref, icon: resourceIconForScheme(parseResourceRef(ref)!.scheme),
      action: { kind: "Unavailable" as const, reason: input.localReferenceMissing ? "not on this device" : input.referenceFailed ? "couldn’t look up this item" : "looking up resource…" },
      ...UNSCORED, rank: rank("Navigation", "ExplicitIntent"),
    };
  return { ...row, key: `Resource:${ref}`, evidence: false };
}

/** The query carries only text: panes and recents may join by name. */
function plainSearch(query: NexusQuery): boolean {
  const filters = query.searchQuery;
  return filters.requestedKinds === null && filters.formats.length + filters.authors.length + filters.roles.length === 0 && filters.scope === "all";
}

/**
 * The candidates nameable at the keystroke: intents, panes, places, commands and recent picks that match
 * the text by name, plus the latched target whatever its name; ranked once and capped.
 */
export function syncRows(input: Reference & {
  readonly query: NexusQuery;
  readonly panes: readonly NexusPane[];
  /** Pane ids, most recently active first. */
  readonly mru: readonly string[];
  readonly recent: readonly RecentItem[];
  readonly usage: UsageMap;
  /** The canonical href law 5 owns for this text, or null. */
  readonly latched: string | null;
}): NexusRow[] {
  const { query, panes, usage, latched } = input;
  const { intent, text } = query;
  switch (intent.kind) {
    case "Resource": return [referenceRow(intent.ref, input, panes, usage)];
    case "ImportLinks": return [{
      key: `Import:${JSON.stringify(intent.links)}`, localMatch: null, icon: Icon.Upload,
      ...(intent.links.length === 1 ? { label: "import", detail: linkPointer(intent.links[0]!), name: `import ${linkPointer(intent.links[0]!)}` } : { label: `import ${intent.links.length} links` }),
      action: intent.links.length > ADMIT_LIMIT
        ? { kind: "Unavailable", reason: `100 at a time. this has ${intent.links.length}.` }
        : { kind: "Available", target: { kind: "ImportLinks", links: intent.links } },
      ...UNSCORED, rank: rank("Navigation", "ExplicitIntent"),
    }];
    case "Command": return [commandRow(intent.id, "ExplicitIntent", intent.argument, usage)];
    // Registry order through recency: nothing else distinguishes the six, so no usage.
    case "CommandLookup": return COMMAND_IDS.map((id, index) => commandRow(id, "ExplicitIntent", "", NO_USAGE, COMMAND_IDS.length - index));
    case "Destination": return [placeRow(getDestination(intent.id), "ExplicitIntent", usage)];
    case "ChooseCreate": return [{
      key: "Intent:ChooseCreate", localMatch: null, label: "new…", icon: Icon.Add,
      action: { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } }, ...UNSCORED, rank: rank("Navigation", "ExplicitIntent"),
    }];
    case "Browse": return [{
      key: `Intent:Browse.${intent.browseKind}`, localMatch: null,
      label: intent.query ? `browse ${BROWSE_LABELS[intent.browseKind]} for “${intent.query}”…` : `browse ${BROWSE_LABELS[intent.browseKind]}…`,
      icon: Icon.Browse, detail: "explicit kind", action: nexusBrowseAction(intent.query, intent.browseKind), ...UNSCORED, rank: rank("Navigation", "ExplicitIntent"),
    }];
    case "Search": break;
  }
  const tierOf = (href: string | null, label: string, keywords: readonly string[]): RankTier | null =>
    href !== null && latched !== null && canonicalHref(href) === latched ? "Latched" : nameTier(text, label, keywords);
  const plain = plainSearch(query);
  const rows: NexusRow[] = [];
  const places: NexusRow[] = DESTINATIONS.flatMap(place => {
    const tier = tierOf(placeHref(place), placeActionLabel(place), [place.label, ...place.keywords]);
    return tier ? [placeRow(place, tier, usage)] : [];
  });
  for (const pane of panes) {
    const presentation = pane.presentation;
    const href = pane.resourceRef !== null && resolvePaneRouteModel(pane.href).header.kind === "Resource"
      ? resolvePaneRouteModel(pane.href).pathname : pane.href;
    const tier = tierOf(href, presentation.title, presentation.status === "Ready" && presentation.detail ? [presentation.detail] : []);
    if (tier === null) continue;
    const recency = panes.length - input.mru.indexOf(pane.id);
    const row = paneRow(pane, tier, usage, recency);
    if (pane.resourceRef === null) {
      // A place that is already open keeps its row and gains the pane's closure.
      const routeId = resolveWorkspaceActivationRouteId(pane.href);
      const at = places.findIndex(place => place.action.kind === "Available" && place.action.target.kind === "InternalHref" && resolveWorkspaceActivationRouteId(place.action.target.href) === routeId);
      if (at >= 0) places[at] = { ...places[at]!, state: row.state, secondary: targetMenu(null, [pane]) };
      else rows.push(row);
    } else if (plain && presentation.status !== "Unavailable") rows.push({
      ...row, key: `Resource:${pane.resourceRef}`, href, frecency: frecency(href, usage),
      action: { kind: "Available", target: { kind: "InternalHref", href, labelHint: presentation.title } },
      secondary: targetMenu(pane.resourceRef, panes.filter(candidate => candidate.resourceRef === pane.resourceRef)),
    });
  }
  rows.push(...places);
  for (const id of COMMAND_IDS) {
    const command = NEXUS_COMMANDS[id];
    const action = command.action("");
    const tier = tierOf(action.kind === "Available" ? learnedHref(action.target) : null, command.label, command.keywords);
    if (tier) rows.push(commandRow(id, tier, "", usage));
  }
  if (plain) for (const item of input.recent) {
    const tier = tierOf(item.entry.href, item.presentation.title, item.presentation.status === "Ready" && item.presentation.detail ? [item.presentation.detail] : []);
    if (tier) rows.push(recentRow(item, panes, tier, usage, false));
  }
  const unique = new Map<string, NexusRow>();
  for (const row of rows) if (!unique.has(row.key)) unique.set(row.key, row);
  return [...unique.values()].sort(compareRank).slice(0, RESULT_CAP);
}

/**
 * What the local worker and the remote phases add to a shown list: rows already shown return updated
 * (list.ts keeps their place); new rows come ranked among themselves, as many as the cap leaves room for.
 */
export function arrivalRows(input: Reference & {
  readonly query: NexusQuery;
  readonly panes: readonly NexusPane[];
  readonly usage: UsageMap;
  readonly latched: string | null;
  readonly preview: Schema<"SearchPreviewResponse"> | null;
  readonly local: readonly LocalMatch[];
  readonly missingLocal: ReadonlySet<string>;
  readonly shown: readonly NexusRow[];
}): NexusRow[] {
  const { query, panes, usage, latched, preview } = input;
  if (query.intent.kind === "Resource") return [referenceRow(query.intent.ref, input, panes, usage)];
  if (query.intent.kind !== "Search") return [];
  const text = query.text;
  const ranked = (row: NexusRow): NexusRow => {
    const named = nameTier(text, rowPrimaryText(row), row.keywords ?? []);
    const tier = row.href !== null && latched !== null && canonicalHref(row.href) === latched ? "Latched" : named ?? row.rank.tier;
    return { ...row, evidence: named === null, rank: { ...row.rank, tier } };
  };
  const content = (method: "lexical" | "semantic" | null): RankTier => method === "semantic" ? "Semantic" : "Lexical";
  const local = input.local.filter(match => !input.missingLocal.has(match.resource.ref))
    .map(match => ranked(localRow(match, panes, "Lexical", usage)));
  const remote = (results: readonly Schema<"SearchResourceOut">[], stream: NexusStream): NexusRow[] => results.map(result => ranked({
    ...resourceRow(result.item, panes, stream, content(result.match_method), usage),
    match: result.match, matchMethod: result.match_method, matchingPassage: result.matching_passage,
  }));
  const passages = (preview?.passages ?? []).map(passage => ranked({
    ...resourceRow(passage.item, panes, "Passages", content(passage.match_method), usage), match: passage.match, matchMethod: passage.match_method,
  }));
  // Local authored rows own their refs; otherwise the earlier stream does.
  const owners = new Map<string, NexusRow>();
  for (const row of [...local, ...remote(preview?.resources ?? [], "Resources"), ...remote(preview?.saved ?? [], "Saved"), ...passages]) {
    const previous = owners.get(row.key);
    if (!previous || row.localMatch?.resource.authored_by_viewer && !previous.localMatch) owners.set(row.key, row);
  }
  const shown = new Map(input.shown.map(row => [row.key, row] as const));
  // An arriving source absorbs its passage; a shown one keeps its lines, so the passage stays its own row.
  for (const passage of passages) {
    const ref = passage.item?.preview.source?.ref;
    const owner = ref ? owners.get(`Resource:${ref}`) : undefined;
    if (!owner || owner.localMatch || shown.has(owner.key) || owner.matchingPassage || !passage.item || !passage.matchMethod || owners.get(passage.key) !== passage) continue;
    if (passage.rank.tier === "Latched" && owner.rank.tier !== "Latched") continue;
    owners.set(owner.key, { ...owner, matchingPassage: { item: passage.item, match: passage.match ?? null, match_method: passage.matchMethod, matched_field: passage.item.activation.field === "annotation" ? "annotation" : null } });
    owners.delete(passage.key);
  }
  const rows = [...owners.values()];
  const fresh = rows.filter(row => !shown.has(row.key)).sort(compareRank)
    .filter((row, index) => row.rank.tier === "Latched" || index < RESULT_CAP - shown.size);
  return [...rows.flatMap(row => { const before = shown.get(row.key); return before ? [refreshed(before, row)] : []; }), ...fresh];
}

/**
 * A shown row keeps its lines for the life of the query (law 1 holds by reflow too): a row painted from a
 * pane or a recent pick stays as it is, and an arrived row refreshes a window it already shows but never
 * gains or loses one.
 */
function refreshed(shown: NexusRow, update: NexusRow): NexusRow {
  if (!shown.item) return shown;
  const window = Boolean(shown.match && update.match);
  return {
    ...update,
    match: window ? update.match : shown.match,
    matchMethod: window ? update.matchMethod : shown.matchMethod,
    matchingPassage: shown.matchingPassage && update.matchingPassage ? update.matchingPassage : shown.matchingPassage,
  };
}

export function playbackRow(title: string, subtitle: string | undefined): NexusRow {
  return {
    key: "Resource:Playback:Current", localMatch: null,
    label: title, icon: Icon.Play, detail: subtitle,
    action: { kind: "Available", target: { kind: "ResumeCurrentPlayback" } },
    ...UNSCORED, rank: rank("Navigation", "PrefixOrToken"),
  };
}

/** `search all results` and `use this text…`; lookup keeps only its literal search. */
export function continuations(query: NexusQuery): NexusRow[] {
  if (!query.text || query.intent.kind !== "Search" && query.intent.kind !== "CommandLookup") return [];
  const literal = query.intent.kind === "CommandLookup";
  const searchQuery = literal ? { ...emptySearchQuery(), text: query.text } : query.searchQuery;
  const search: NexusRow = {
    key: "Continuation:SeeAll", localMatch: null, label: literal ? `search for “${query.text}”` : "search all results",
    detail: null,
    icon: Icon.Search, action: nexusSearchAction(searchQuery), learns_selection: true, ...UNSCORED, rank: rank("Navigation", "Substring"),
  };
  if (literal) return [search];
  return [search, textRow(query.text)];
}

function textRow(text: string, detail?: string): NexusRow {
  return { key: "Continuation:UseText", localMatch: null, label: "use this text…", icon: Icon.Add, detail,
    action: { kind: "Available", target: { kind: "UseText", text } }, ...UNSCORED, rank: rank("Navigation", "Substring") };
}

/**
 * The blank list, in rank order: a pre-armed `use this text…`, `here`, the other tabs most recent first
 * (layout order with the current pane while a reorder runs), recent picks without the current resource,
 * then the actions. Nothing here is matched, so every row is PrefixOrToken, as the empty prefix is.
 */
export function blankRows(input: {
  readonly panes: readonly NexusPane[];
  readonly mru: readonly string[];
  readonly recent: readonly RecentItem[];
  readonly playback: NexusRow | null;
  readonly useText: string | null;
  readonly layoutOrder: boolean;
  readonly panesExpanded: boolean;
}): NexusRow[] {
  const { panes } = input;
  const current = panes.find(pane => pane.current);
  const recency = (pane: NexusPane) => panes.length - input.mru.indexOf(pane.id);
  const tabs = input.layoutOrder ? panes : input.mru.flatMap(id => panes.filter(pane => pane.id === id && !pane.current));
  const shownTabs = input.layoutOrder || input.panesExpanded ? tabs : tabs.slice(0, OPEN_CAP);
  const recents = input.recent.filter(item => !current || (item.resourceRef !== null ? item.resourceRef !== current.resourceRef : item.entry.href !== current.href));
  const actions = (["Nexus.Quick.Note", "Nexus.Quick.Chat", "Nexus.Quick.Import"] as const).map(id => commandRow(id, "PrefixOrToken", "", NO_USAGE));
  if (input.playback) actions.push({ ...input.playback, label: `resume ${input.playback.label}` });
  return [
    ...(input.useText ? [textRow(input.useText, input.useText)] : []),
    ...(current && !input.layoutOrder ? [{ ...paneRow(current, "PrefixOrToken", NO_USAGE, recency(current)), secondary: targetMenu(current.resourceRef, [current]) }] : []),
    ...shownTabs.map(pane => paneRow(pane, "PrefixOrToken", NO_USAGE, recency(pane))),
    ...recents.slice(0, RECENT_CAP).map(item => recentRow(item, panes, "PrefixOrToken", NO_USAGE, true)),
    ...actions,
  ];
}

/** The sheet's places: each destination's label as written, `Today` first. */
export function placeChipRows(): NexusRow[] {
  return PLACES.map(id => { const place = getDestination(id); return { ...placeRow(place, "PrefixOrToken", NO_USAGE), label: place.label }; });
}

/** Blank rows fall into their sections by key; typed rows share one unlabelled list before the continuations. */
export function nexusGroups(input: {
  readonly blank: boolean;
  readonly rows: readonly NexusRow[];
  readonly hereKey: string | null;
  readonly paneCount: number;
  readonly continuations: readonly NexusRow[];
}): NexusGroup[] {
  const group = (id: NexusGroup["id"], label: string, rows: readonly NexusRow[]): NexusGroup[] => rows.length ? [{ id, label, rows }] : [];
  if (!input.blank) return [...group("Results", "", input.rows), ...group("Continuations", "", input.continuations)];
  const where = (test: (row: NexusRow) => boolean) => input.rows.filter(test);
  return [
    ...group("Continuations", "", where(row => row.key === "Continuation:UseText")),
    ...group("Here", "", where(row => row.key === input.hereKey)),
    ...group("Open", `tabs · ${input.paneCount}`, where(row => row.key.startsWith("Pane:") && row.key !== input.hereKey)),
    ...group("Recent", "recent picks", where(row => row.key.startsWith("Recent:"))),
    ...group("QuickActions", "actions", where(row => row.key.startsWith("QuickAction:") || row.key === "Resource:Playback:Current")),
  ];
}

/** The rows of a choice page: what to create from a draft, or which kind to browse. */
export function choiceRows(page: NexusPage): NexusRow[] {
  const choice = (label: string, icon: NexusRow["icon"], action: NexusAction): NexusRow => ({
    key: `Choice:${label}`, localMatch: null, label, icon, action, ...UNSCORED, rank: rank("Navigation", "ExplicitIntent"),
  });
  if (page.kind === "UseText") return [
    choice("ask nexus", Icon.NewChat, NEXUS_COMMANDS["Nexus.Quick.Chat"].action(page.text)),
    choice("add to today", Icon.Today, NEXUS_COMMANDS["Nexus.Quick.Note"].action(page.text)),
    choice("browse…", Icon.Browse, NEXUS_COMMANDS["Nexus.Quick.Browse"].action(page.text)),
    choice("create…", Icon.Add, { kind: "Available", target: { kind: "ChooseCreate", initialDraft: page.text } }),
  ];
  if (page.kind === "ChooseCreate") {
    const target = (id: NexusCommandId): NexusAction => NEXUS_COMMANDS[id].action(page.draft);
    return [
      choice(page.draft ? "save note to today" : "quick note", Icon.Today, target("Nexus.Quick.Note")),
      choice("page", Icon.Page, target("Nexus.Quick.Page")),
      choice("chat", Icon.NewChat, target("Nexus.Quick.Chat")),
      choice("library", Icon.Library, target("Nexus.Quick.Library")),
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
  ).map(([label, kind]) => choice(label.toLowerCase(), Icon.Browse, nexusBrowseAction(page.query, kind)));
}

/** A row's spoken name: its parts as sentences, adding no period after a part that already ends one. */
export function rowName(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part))
    .map((part, index, kept) => index === kept.length - 1 || /[….?!]$/.test(part) ? part : `${part}.`).join(" ");
}

/** Only facts already in the supplied projection distinguish a target; `minimized` is the one state word. */
export function rowFacts(row: NexusRow): string {
  const state = row.state === "Minimized" ? "minimized" : null;
  if (!row.item) return [row.detail, state].filter(Boolean).join(" · ");
  const metadata = resourceMetadata({ item: row.item, matchMethod: row.matchMethod });
  const sourceIsTitle = row.item.preview.body.kind === "passage" && parseResourceRef(row.item.ref)?.scheme !== "highlight";
  const parts = [...metadata.bibliography, ...metadata.parts.filter(part => part.key !== "source" || !sourceIsTitle)];
  const facts = parts.map(part => part.kind === "credits"
    ? part.credits.flatMap(credit => creditName(credit)?.label ?? []).slice(0, 2).join(", ") : part.text);
  return [...facts, state].filter(Boolean).join(" · ");
}
