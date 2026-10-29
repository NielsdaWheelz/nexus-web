import { recentTargetKey, type RecentEntry } from "@/lib/recent/model";
import type { PanePresentation } from "@/lib/workspace/presentations";
import { authoredItem } from "@/lib/notes/presentation";
import type { SearchActive } from "@/lib/ui/searchOptions";
// One relevance order precedes the visible cap. Interaction holds complete displayed snapshots.
import {
  FilePlus2,
  FileText,
  Globe,
  Library,
  Link as LinkIcon,
  MessageSquarePlus,
  Play,
  Search,
} from "lucide-react";
import type { Schema } from "@/lib/api/wire";
import { DESTINATIONS, getDestination, type Destination, type DestinationId } from "@/lib/navigation/destinations";
import {
  getPaneRouteIcon,
  recentValueForHref,
  resolvePaneRouteModel,
  resolveWorkspaceActivationRouteId,
} from "@/lib/panes/paneRouteModel";
import { parseResourceRef, resourceIconForScheme, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "@/lib/resources/items";
import type { LocalMatch } from "@/lib/search/localSearch";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { emptySearchQuery } from "@/lib/search/query";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  NexusAction,
  NexusCommandId,
  NexusGroup,
  NexusPage,
  NexusPane,
  NexusRankTier,
  NexusRow,
  NexusRootMode,
  NexusTarget,
} from "./model";
import { NEXUS_COMMANDS, nexusBrowseAction, nexusSearchAction, type BrowseKind, type NexusQuery } from "./query";

const RESULT_CAP = 8;
const OPEN_CAP = 5;
const RECENT_CAP = 8;
const TIERS: readonly NexusRankTier[] = [
  "ExplicitIntent",
  "Exact",
  "PrefixOrToken",
  "Substring",
  "Lexical",
  "FuzzyOrSynonym",
  "Semantic",
];
const KEY_KINDS = ["Pane", "Destination", "Resource", "QuickAction", "ImportUrl", "Intent", "Continuation"];
const UNRANKED = { stream: "Navigation", tier: "FuzzyOrSynonym", score: 0, frecency: 0 } as const;
const MOBILE_PLACES: readonly DestinationId[] = ["lectern", "libraries", "browse", "podcasts", "chats", "notes"];
const BROWSE_LABELS: Record<BrowseKind, string> = { WebArticle: "articles", Podcast: "podcasts", Video: "videos", Epub: "books" };

type Frecency = Readonly<Record<string, number>>;

/** The ranked result rows of one query identity and the row the keyboard acts on. */
export interface NexusList {
  readonly identity: string | null;
  readonly groups: readonly NexusGroup[];
  readonly active: SearchActive;
  readonly moved: boolean;
  readonly pending: boolean;
}

export const EMPTY_LIST: NexusList = { identity: null, groups: [], active: null, moved: false, pending: false };

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
  input: { aliases?: readonly string[]; metadata?: readonly string[]; },
): NexusRankTier | null {
  const query = rawQuery.trim().toLowerCase();
  const label = rawLabel.trim().toLowerCase();

  if (label === query) return "Exact";
  if (prefixOrToken(query, label)) return "PrefixOrToken";
  if (label.includes(query)) return "Substring";
  const aliases = (input.aliases ?? []).map((alias) => alias.trim().toLowerCase());
  if (aliases.some((alias) => prefixOrToken(query, alias) || fuzzy(query, alias)) || fuzzy(query, label)) return "FuzzyOrSynonym";
  return (input.metadata ?? []).some((value) => fuzzy(query, value.trim().toLowerCase())) ? "FuzzyOrSynonym" : null;
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

function paneState(pane: NexusPane): "Current" | "Minimized" | undefined {
  return pane.current ? "Current" : pane.visibility === "minimized" ? "Minimized" : undefined;
}

function paneRow(pane: NexusPane, tier: NexusRankTier, frecency: Frecency): NexusRow {
  return {
    key: `Pane:${pane.id}`, localMatch: null,
    label: pane.presentation.title,
    icon: getPaneRouteIcon(pane.href),
    type: "pane",
    detail: pane.presentation.detail ?? undefined,
    state: paneState(pane),
    action: { kind: "Available", target: { kind: "PaneOpen", paneId: pane.id } },
    secondary: { kind: "ClosePane", paneId: pane.id },
    learns_selection: true,
    rank: { stream: "Navigation", tier, score: pane.current ? 1 : 0, frecency: frecency[pane.href] ?? 0 },
  };
}

function placeActionLabel(place: Destination): string {
  return place.id === "authors" ? "search people" : `open ${place.label.toLowerCase()}`;
}

function placeRow(place: Destination, tier: NexusRankTier, frecency: Frecency): NexusRow {
  const today = place.id === "today";
  return {
    key: `Destination:${place.id}`, localMatch: null,
    label: placeActionLabel(place),
    icon: place.icon ?? getPaneRouteIcon(place.href),
    detail: place.id === "authors" ? "authors and contributors" : undefined,
    action: {
      kind: "Available",
      target: today
        ? { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "View" } }
        : { kind: "InternalHref", href: place.href, labelHint: place.label },
    },
    learns_selection: !today,
    rank: { stream: "Navigation", tier, score: 0, frecency: frecency[place.href] ?? 0 },
  };
}

function commandRow(id: NexusCommandId, tier: NexusRankTier, argument: string): NexusRow {
  const command = NEXUS_COMMANDS[id];
  return {
    key: `QuickAction:${id}`, localMatch: null,
    label: id === "Nexus.Quick.Note" && argument ? "save note to today" : command.label,
    icon: command.icon,
    detail: argument || undefined,
    action: command.action(argument),
    rank: { stream: "Navigation", tier, score: 0, frecency: 0 },
  };
}

function localRows(query: NexusQuery, panes: readonly NexusPane[], frecency: Frecency, picker: boolean): NexusRow[] {
  const { intent, text } = query;
  const explicit: NexusRow[] = [];
  if (intent.kind === "ImportUrl") {
    explicit.push({
      key: `ImportUrl:${intent.url}`, localMatch: null,
      label: "import",
      icon: LinkIcon,
      type: "URL",
      detail: intent.url,
      action: NEXUS_COMMANDS["Nexus.Quick.Import"].action(intent.url),
      rank: { stream: "Navigation", tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  } else if (intent.kind === "Command") {
    explicit.push(commandRow(intent.id, "ExplicitIntent", intent.argument));
  } else if (intent.kind === "CommandLookup") {
    explicit.push(...(Object.keys(NEXUS_COMMANDS) as NexusCommandId[]).map((id) => commandRow(id, "FuzzyOrSynonym", "")));
  } else if (intent.kind === "Destination") {
    explicit.push(placeRow(getDestination(intent.id), "ExplicitIntent", frecency));
  } else if (intent.kind === "ChooseCreate") {
    explicit.push({
      key: "Intent:ChooseCreate", localMatch: null, label: "new…", icon: FilePlus2,
      action: { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } },
      rank: { stream: "Navigation", tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  } else if (intent.kind === "Browse") {
    const kind = BROWSE_LABELS[intent.browseKind];
    explicit.push({
      key: `Intent:Browse.${intent.browseKind}`, localMatch: null,
      label: intent.query ? `browse ${kind} for “${intent.query}”…` : `browse ${kind}…`,
      icon: Globe,
      type: "Browse",
      detail: "explicit kind",
      action: nexusBrowseAction(intent.query, intent.browseKind),
      rank: { stream: "Navigation", tier: "ExplicitIntent", score: 0, frecency: 0 },
    });
  }
  if (intent.kind !== "Search") {
    return explicit;
  }
  const paneRows = panes.filter((pane) => pane.resourceRef === null && resolvePaneRouteModel(pane.href).header.kind !== "Resource").flatMap((pane) => {
    const tier = textTier(text, pane.presentation.title, { aliases: [pane.href] });
    return tier ? [paneRow(pane, tier, frecency)] : [];
  });
  const places = DESTINATIONS.flatMap((place) => {
    const tier = textTier(text, placeActionLabel(place), { aliases: [place.label, ...place.keywords], metadata: [place.href] });
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
  for (const row of paneRows) {
    const pane = panes.find((pane) => `Pane:${pane.id}` === row.key)!;
    const place = [...unique.values()].find((candidate) => candidate.action.kind === "Available"
      && candidate.action.target.kind === "InternalHref"
      && resolveWorkspaceActivationRouteId(candidate.action.target.href) === resolveWorkspaceActivationRouteId(pane.href));
    if (place && !picker) {
      const prior = place.secondary?.kind === "TargetMenu" ? place.secondary.closePanes : [];
      const ids = new Set([...prior.map((item) => item.id), pane.id]);
      const matching = panes.filter((candidate) => ids.has(candidate.id));
      unique.set(place.key, { ...place, state: place.state === "Current" ? place.state : row.state, secondary: targetMenu(null, matching) });
    } else unique.set(row.key, row);
  }
  return [...unique.values()].sort(compareRows);
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
    closePanes: panes.map((pane, index) => ({ id: pane.id, label: pane.current ? "close current pane" : panes.length > 1 ? `close pane ${index + 1}` : "close pane" })),
  };
}

function resourceRow(item: ResourceItem, panes: readonly NexusPane[]): NexusRow {
  const ref = parseResourceRef(item.ref)!;
  const matching = panes.filter((candidate) => candidate.resourceRef === item.ref);
  const pane = matching.find((pane) => pane.current) ?? matching[0];
  return {
    key: `Resource:${item.ref}`, localMatch: null, label: item.label, item,
    icon: resourceIconForScheme(ref.scheme), type: resourceTypeLabel(ref.scheme),
    state: pane ? paneState(pane) : undefined,
    action: resourceAction(item),
    secondary: targetMenu(item.action_ref, matching),
    learns_selection: true, rank: UNRANKED,
  };
}

/** A local authored match: canonical label, literal excerpt and its exact target. */
function localRow(match: LocalMatch, panes: readonly NexusPane[]): NexusRow {
  const ref = match.resource.ref;
  const excerpt = match.excerpt;
  const matching = panes.filter((candidate) => candidate.resourceRef === ref);
  const pane = matching.find((pane) => pane.current) ?? matching[0];
  const evidence = excerpt === null ? null : { excerpt: { text: excerpt.text, truncated_before: excerpt.before, truncated_after: excerpt.after }, ranges: excerpt.marks.map(([start, end]) => ({ start: Array.from(excerpt.text.slice(0, start)).length, end: Array.from(excerpt.text.slice(0, end)).length })) };
  const item = authoredItem(match.resource, match.readingRef);
  const body = item.preview.body;
  return {
    key: `Resource:${ref}`, localMatch: match, label: match.label,
    // A matched note paints its matched literal window as the primary prose, so its ranges are inline.
    item: match.resource.kind === "note" && body.kind === "prose" && evidence !== null
      ? { ...item, preview: { ...item.preview, body: { ...body, excerpt: evidence.excerpt } } } : item,
    match: evidence,
    icon: resourceIconForScheme(parseResourceRef(ref)!.scheme), type: resourceTypeLabel(parseResourceRef(ref)!.scheme),
    state: pane ? paneState(pane) : undefined,
    action: match.href === null ? { kind: "Unavailable", reason: "source unavailable" }
      : { kind: "Available", target: { kind: "InternalHref", href: match.href, labelHint: match.label } },
    secondary: targetMenu(ref, matching),
    learns_selection: true, rank: { ...UNRANKED, stream: "Local", tier: nameTier(match.nameMatch) },
  };
}

export type RecentItem = { entry: RecentEntry; presentation: PanePresentation; resourceRef: string | null };
export function recentRow(item: RecentItem, panes: readonly NexusPane[], blank: boolean): NexusRow {
  const { entry, presentation, resourceRef } = item;
  const matching = panes.filter(pane => resourceRef !== null ? pane.resourceRef === resourceRef : pane.href === entry.href);
  const pane = matching.find(candidate => candidate.current) ?? matching[0];
  return {
    key: blank ? `Recent:${entry.used_revision}` : resourceRef ? `Resource:${resourceRef}` : `Recent:${recentTargetKey(entry.target)}`,
    localMatch: null, recentEntry: entry, label: presentation.title, icon: getPaneRouteIcon(entry.href),
    detail: presentation.detail ?? undefined, state: pane ? paneState(pane) : undefined,
    action: { kind: "Available", target: { kind: "InternalHref", href: entry.href, labelHint: presentation.title } },
    ...(resourceRef ? { secondary: targetMenu(resourceRef, matching) } : {}),
    learns_selection: true, rank: UNRANKED,
  };
}

function nameTier(name: LocalMatch["nameMatch"]): NexusRankTier {
  return name === "exact" ? "Exact" : name === "prefix" ? "PrefixOrToken" : name === "substring" ? "Substring" : "Lexical";
}

/** Authority chooses duplicate ownership before relevance chooses the eight visible rows. */
export function candidateRows(input: {
  readonly query: NexusQuery;
  readonly panes: readonly NexusPane[];
  readonly frecency: Frecency;
  readonly picker: boolean;
  readonly preview: Schema<"SearchPreviewResponse"> | null;
  readonly reference: ResourceItem | null;
  readonly referenceFailed: boolean;
  readonly local: readonly LocalMatch[];
  readonly localReference: LocalMatch | null;
  readonly localReferenceMissing: boolean;
  readonly retained: readonly NexusRow[];
  readonly missingLocal: ReadonlySet<string>;
  readonly recent: readonly RecentItem[];
}): { readonly rows: readonly NexusRow[]; readonly updates: readonly NexusRow[] } {
  const { query, panes, preview } = input;
  const admit = (rows: NexusRow[]): NexusRow[] => input.picker ? pickerRows(rows, panes, query) : rows;
  if (!query.text) return { rows: [], updates: [] };
  if (query.intent.kind === "Resource") {
    const row = input.localReference ? localRow(input.localReference, panes)
      : input.reference ? resourceRow(input.reference, panes) : {
        key: `Resource:${query.intent.ref}`, localMatch: null, label: query.intent.ref,
        icon: resourceIconForScheme(parseResourceRef(query.intent.ref)!.scheme),
        action: { kind: "Unavailable", reason: input.localReferenceMissing ? "not on this device"
          : input.referenceFailed ? "resource lookup failed" : "looking up resource…" },
        rank: UNRANKED,
      } satisfies NexusRow;
    const rows = admit([{ ...row, rank: { ...UNRANKED, tier: "ExplicitIntent" as const } }]);
    return { rows, updates: rows };
  }
  const navigation = admit(localRows(query, panes, input.frecency, input.picker));
  if (query.intent.kind !== "Search") return { rows: navigation.slice(0, RESULT_CAP), updates: navigation };
  const local = admit(input.local.filter(match => !input.missingLocal.has(match.resource.ref)).map(match => localRow(match, panes)));
  const remote = (results: readonly Schema<"SearchResourceOut">[]): NexusRow[] => results.map(result => ({
    ...resourceRow(result.item, panes), match: result.match, matchMethod: result.match_method,
    matchingPassage: result.matching_passage,
    rank: { ...UNRANKED, stream: result.section === "saved" ? "Saved" as const : "Resources" as const, tier: result.name_match !== null ? nameTier(result.name_match)
      : result.match_method === "semantic" ? "Semantic" as const : "Lexical" as const },
  }));
  const resources = admit(remote(preview?.resources ?? []));
  const saved = admit(remote(preview?.saved ?? []));
  const passages = admit((preview?.passages ?? []).map(passage => ({
    ...resourceRow(passage.item, panes), match: passage.match, matchMethod: passage.match_method,
    rank: { ...UNRANKED, stream: "Passages" as const, tier: passage.match_method === "semantic" ? "Semantic" as const : "Lexical" as const },
  })));
  // Bounded omission does not revoke a previously admitted canonical target.
  for (const previous of input.retained) {
    if (previous.localMatch) {
      if (input.missingLocal.has(previous.localMatch.resource.ref) || local.some(row => row.key === previous.key)) continue;
      const current = localRow(previous.localMatch, panes);
      local.push(...admit([{ ...previous, state: current.state, secondary: current.secondary }]));
    } else if (previous.item && ![...resources, ...saved, ...passages].some(row => row.key === previous.key)) {
      const current = resourceRow(previous.item, panes);
      const retained = admit([{ ...previous, state: current.state, secondary: current.secondary }]);
      if (previous.rank.stream === "Saved") saved.push(...retained);
      else if (previous.rank.stream === "Passages") passages.push(...retained);
      else resources.push(...retained);
    }
  }
  const filters = query.searchQuery;
  if (filters.requestedKinds === null && filters.formats.length + filters.authors.length + filters.roles.length === 0 && filters.scope === "all") {
    for (const pane of panes) {
      if (pane.resourceRef === null || pane.presentation.status === "Unavailable"
        || [...local, ...resources, ...saved, ...passages].some(row => row.key === `Resource:${pane.resourceRef}`)) continue;
      const tier = textTier(filters.text, pane.presentation.title, {});
      if (tier === null) continue;
      const matching = panes.filter(candidate => candidate.resourceRef === pane.resourceRef);
      navigation.push(...admit([{ ...paneRow(pane, tier, input.frecency), key: `Resource:${pane.resourceRef}`,
        action: { kind: "Available", target: { kind: "InternalHref", href: input.picker ? pane.href : resolvePaneRouteModel(pane.href).pathname, labelHint: pane.presentation.title } },
        secondary: targetMenu(pane.resourceRef, matching),
      }]));
    }
  }
  const recent = filters.requestedKinds === null && filters.formats.length + filters.authors.length + filters.roles.length === 0 && filters.scope === "all"
    ? admit(input.recent.flatMap(item => {
      const row = recentRow(item, panes, false);
      const tier = textTier(filters.text, row.label, {});
      return tier ? [{ ...row, rank: { ...row.rank, tier } }] : [];
    })) : [];
  const streams = [navigation, local, recent, resources, saved, passages];
  const owners = new Map<string, NexusRow>();
  for (const stream of streams) for (const row of stream) {
    const previous = owners.get(row.key);
    if (!previous || row.localMatch?.resource.authored_by_viewer
      || row.item && !previous.localMatch?.resource.authored_by_viewer) owners.set(row.key, row);
  }
  const ranked = streams.flatMap((stream, source) => {
    const ordinals = new Map<NexusRankTier, number>();
    return stream.flatMap(row => {
      if (owners.get(row.key) !== row) return [];
      const titleTier = row.key.startsWith("Resource:") || row.key.startsWith("Recent:") ? textTier(filters.text, row.label, {}) : null;
      const chosen = titleTier === "Exact" || titleTier === "PrefixOrToken" ? { ...row, rank: { ...row.rank, tier: titleTier } } : row;
      const ordinal = ordinals.get(chosen.rank.tier) ?? 0;
      ordinals.set(chosen.rank.tier, ordinal + 1);
      return [{ row: chosen, source, ordinal }];
    });
  }).sort((a, b) => TIERS.indexOf(a.row.rank.tier) - TIERS.indexOf(b.row.rank.tier)
    || a.ordinal - b.ordinal || a.source - b.source || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  const paneTargets = new Set(ranked.flatMap(({ row }) => {
    const pane = panes.find(candidate => row.key === `Pane:${candidate.id}`);
    const value = pane ? recentValueForHref(pane.href) : null;
    return value ? [recentTargetKey(value.target)] : [];
  }));
  const targets = new Set<string>();
  const updates = ranked.flatMap(({ row }) => {
    if (row.recentEntry && paneTargets.has(recentTargetKey(row.recentEntry.target))) return [];
    const target = row.recentEntry && row.key.startsWith("Recent:")
      ? row.key : row.action.kind === "Available" && row.action.target.kind === "InternalHref"
        ? resolveWorkspaceActivationRouteId(row.action.target.href) : row.key;
    if (targets.has(target)) return [];
    targets.add(target);
    return [row];
  });
  const composed = [...updates];
  const suppressed = new Set<string>();
  // Only a source that survives the cap can absorb its matching passage.
  for (;;) {
    const visible = composed.filter(row => !suppressed.has(row.key)).slice(0, RESULT_CAP);
    let changed = false;
    for (const row of passages) {
      const ref = row.item?.preview.source?.ref;
      const owner = ref ? visible.find(candidate => candidate.key === `Resource:${ref}` && candidate.item && !candidate.localMatch) : null;
      if (!owner || !row.item || !row.matchMethod || suppressed.has(row.key)) continue;
      const at = composed.indexOf(owner);
      composed[at] = { ...owner, matchingPassage: owner.matchingPassage ?? { item: row.item, match: row.match ?? null, match_method: row.matchMethod, matched_field: row.item.activation.field === "annotation" ? "annotation" : null } };
      suppressed.add(row.key);
      changed = true;
    }
    if (!changed) break;
  }
  return { rows: composed.filter(row => !suppressed.has(row.key)).slice(0, RESULT_CAP), updates };
}

/** Picker admission and pane projection share the same target contract as activation. */
export function pickerTarget(target: NexusTarget, panes: readonly NexusPane[]): NexusTarget | null {
  switch (target.kind) {
    case "PaneOpen": {
      const pane = panes.find((candidate) => candidate.id === target.paneId);
      return pane ? { kind: "InternalHref", href: pane.href, labelHint: pane.presentation.title } : null;
    }
    case "Resource": return target.activation.kind === "route" ? target : null;
    case "InternalHref": case "OpenDailyPage": case "CreatePage": case "CreateLibrary": case "ChooseCreate": case "ChooseBrowse": case "UseText": return target;
    case "OpenAcceptedSource": case "OpenAdd": case "ResumeCurrentPlayback": return null;
  }
}

/** The new-pane picker projects eligible destinations before composition caps. */
function pickerRows(rows: readonly NexusRow[], panes: readonly NexusPane[], query: NexusQuery): NexusRow[] {
  if (query.intent.kind === "Command") {
    const command = NEXUS_COMMANDS[query.intent.id].action("");
    if (command.kind === "Available" && pickerTarget(command.target, panes) === null) return [];
  }
  return rows.flatMap((row) => {
    const passage = row.matchingPassage ? resourceAction(row.matchingPassage.item) : null;
    const projected = { ...row, state: undefined, secondary: undefined,
      matchingPassage: passage?.kind === "Available" && pickerTarget(passage.target, panes) === null ? null : row.matchingPassage };
    if (row.action.kind === "Unavailable") return [projected];
    const target = pickerTarget(row.action.target, panes);
    if (!target) return [];
    return [{ ...projected, action: { kind: "Available" as const, target } }];
  });
}

/** Freeze order, body and activation after interaction; actual loss remains immediate. */
export function mergeResults(previous: NexusList, identity: string, incoming: readonly NexusGroup[], updates: readonly NexusRow[], removed: ReadonlySet<string>): NexusList {
  if (previous.identity !== identity || !previous.moved) return { identity, groups: incoming, active: previous.identity === identity ? previous.active : null, moved: false, pending: false };
  const next = new Map([...incoming.flatMap(group => group.rows), ...updates].map(row => [row.key, row]));
  const groups = previous.groups.flatMap(group => {
    const current = incoming.find(candidate => candidate.id === group.id);
    // Explicit expansion, reordering and pane closure remain owned by the pane list.
    if (group.id === "Open" && current && group.rows.map(row => row.key).join("\0") !== current.rows.map(row => row.key).join("\0")) return [current];
    const rows = group.rows.flatMap(old => {
      const row = next.get(old.key);
      if (removed.has(old.key)) return [];
      if (!row) return [old];
      return [{ ...old, ...(old.recentEntry ? { label: row.label, detail: row.detail, icon: row.icon } : {}), state: row.state, secondary: row.secondary,
        action: row.action.kind === "Unavailable" ? row.action : old.action }];
    });
    return rows.length ? [{ ...group, rows }] : [];
  });
  const pending = JSON.stringify(groups) !== JSON.stringify(incoming);
  return { identity, groups, active: previous.active, moved: true, pending };
}

export function playbackRow(title: string, subtitle: string | undefined): NexusRow {
  return {
    key: "Resource:Playback:Current", localMatch: null,
    label: title,
    icon: Play,
    type: "Media",
    detail: subtitle,
    action: { kind: "Available", target: { kind: "ResumeCurrentPlayback" } },
    rank: UNRANKED,
  };
}

export function queryActions(query: NexusQuery): NexusRow[] {
  if (!query.text || query.intent.kind !== "Search" && query.intent.kind !== "CommandLookup") return [];
  const literal = query.intent.kind === "CommandLookup";
  const searchQuery = literal ? { ...emptySearchQuery(), text: query.text } : query.searchQuery;
  const search: NexusRow = {
    key: "Continuation:SeeAll", localMatch: null, label: literal ? `search for “${query.text}”` : "search all results",
    icon: Search, action: nexusSearchAction(searchQuery), learns_selection: true, rank: UNRANKED,
  };
  if (literal) return [search];
  return [search, { key: "Continuation:UseText", localMatch: null, label: "use this text…", icon: FileText,
    action: { kind: "Available", target: { kind: "UseText", text: query.text } }, rank: UNRANKED }];
}

/** Blank groups preserve workspace projection; typed rows share one unlabelled list. */
export function nexusGroups(input: {
  readonly desktop: boolean;
  readonly rootMode: NexusRootMode;
  readonly query: NexusQuery;
  readonly results: readonly NexusRow[];
  readonly panes: readonly NexusPane[];
  readonly panesExpanded: boolean;
  readonly playback: NexusRow | null;
  readonly recent: readonly RecentItem[];
  readonly frecency: Frecency;
}): NexusGroup[] {
  const { desktop, query, panes, frecency } = input;
  const group = (id: NexusGroup["id"], label: string, rows: readonly NexusRow[]): NexusGroup[] => rows.length ? [{ id, label, rows }] : [];
  if (!desktop && input.rootMode === "Overview") return [...mobileOverview(input), ...group("Recent", "recent picks", input.recent.slice(0, RECENT_CAP).map(item => mobileRow(recentRow(item, panes, true))))];
  if (query.text) return [...group("Results", "", desktop ? input.results : input.results.map(mobileRow)), ...group("Continuations", "", queryActions(query))];
  const open = (input.panesExpanded ? panes : nexusPanePreview(panes, false)).map(pane => paneRow(pane, "FuzzyOrSynonym", frecency));
  const recent = input.recent.slice(0, RECENT_CAP).map(item => recentRow(item, panes, true));
  if (input.rootMode === "NewPane") return [
    ...group("Recent", "recent picks", recent.map(mobileRow)),
    ...group("Places", "places", MOBILE_PLACES.map(id => mobileRow(placeRow(getDestination(id), "FuzzyOrSynonym", frecency)))),
    ...group("QuickActions", "create and open", (["Nexus.Quick.Note", "Nexus.Quick.Page", "Nexus.Quick.Chat", "Nexus.Quick.Library"] as const).map(id => commandRow(id, "FuzzyOrSynonym", ""))),
  ];
  if (!desktop) return group("Recent", "recent picks", recent.map(mobileRow));
  const actions = (["Nexus.Quick.Note", "Nexus.Quick.Chat", "Nexus.Quick.Import"] as const).map(id => commandRow(id, "FuzzyOrSynonym", ""));
  if (input.playback) actions.push({ ...input.playback, label: `resume ${input.playback.label}` });
  return [...group("Open", `tabs · ${panes.length}`, open), ...group("Recent", "recent picks", recent), ...group("QuickActions", "actions", actions)];
}

export function nexusPanePreview<T extends Pick<NexusPane, "visibility" | "current">>(panes: readonly T[], mobile: boolean): readonly T[] {
  if (!mobile) return panes.slice(0, OPEN_CAP);
  const visible = panes.filter((pane) => pane.visibility === "visible");
  const current = visible.findIndex((pane) => pane.current);
  const start = Math.max(0, Math.min(current - 1, visible.length - 3));
  return visible.slice(start, start + 3);
}

/** Mobile destination rows offer their explicit new-pane action through a sibling menu. */
function mobileRow(row: NexusRow): NexusRow {
  const target = row.action.kind === "Available" ? row.action.target : null;
  const direct = !row.key.startsWith("QuickAction:") && (target?.kind === "InternalHref" || target?.kind === "OpenDailyPage" || (target?.kind === "Resource" && target.activation.kind === "route"));
  return row.secondary || !direct ? row : { ...row, secondary: { kind: "TargetMenu", resourceRef: null, closePanes: [] } };
}

function mobileOverview(input: {
  readonly panes: readonly NexusPane[];
  readonly panesExpanded: boolean;
  readonly frecency: Frecency;
  readonly playback: NexusRow | null;
}): NexusGroup[] {
  const place = (id: DestinationId) => mobileRow(placeRow(getDestination(id), "FuzzyOrSynonym", input.frecency));
  return [
    { id: "Open", label: `tabs · ${input.panes.length}`, rows: (input.panesExpanded ? input.panes : nexusPanePreview(input.panes, true)).map((pane) => paneRow(pane, "FuzzyOrSynonym", input.frecency)) },
    { id: "Places", label: "places", rows: MOBILE_PLACES.map(place) },
    { id: "QuickActions", label: "", rows: [
      place("today"),
      { key: "QuickAction:New", localMatch: null, label: "create…", icon: FilePlus2, action: { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } }, rank: UNRANKED },
      commandRow("Nexus.Quick.Import", "FuzzyOrSynonym", ""),
    ] },
    ...(input.playback ? [{ id: "Continue", label: "", rows: [{ ...input.playback, label: `resume ${input.playback.label}`, type: undefined }] } satisfies NexusGroup] : []),
  ];
}

/** The rows of a choice page: what to create from a draft, or which kind to browse. */
export function choiceRows(page: NexusPage): NexusRow[] {
  const choice = (label: string, icon: NexusRow["icon"], action: NexusAction): NexusRow => ({
    key: `Choice:${label}`, localMatch: null,
    label,
    icon,
    action,
    rank: UNRANKED,
  });
  if (page.kind === "UseText") return [
    choice("ask nexus", MessageSquarePlus, NEXUS_COMMANDS["Nexus.Quick.Chat"].action(page.text)),
    choice("add to today", FileText, NEXUS_COMMANDS["Nexus.Quick.Note"].action(page.text)),
    choice("browse…", Globe, NEXUS_COMMANDS["Nexus.Quick.Browse"].action(page.text)),
    choice("create…", FilePlus2, { kind: "Available", target: { kind: "ChooseCreate", initialDraft: page.text } }),
  ];
  if (page.kind === "ChooseCreate") {
    const target = (id: NexusCommandId): NexusAction => NEXUS_COMMANDS[id].action(page.draft);
    return [
      choice(page.draft ? "save note to today" : "quick note", FileText, target("Nexus.Quick.Note")),
      choice("page", FilePlus2, target("Nexus.Quick.Page")),
      choice("chat", MessageSquarePlus, target("Nexus.Quick.Chat")),
      choice("library", Library, target("Nexus.Quick.Library")),
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
  ).map(([label, kind]) => choice(label.toLowerCase(), Globe, nexusBrowseAction(page.query, kind)));
}

/** A row's spoken name: its parts as sentences, adding no period after a part that already ends one. */
export function rowName(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part))
    .map((part, index, kept) => index === kept.length - 1 || /[….?!]$/.test(part) ? part : `${part}.`).join(" ");
}

/** Only facts already in the supplied projection distinguish a target. */
export function rowFacts(row: NexusRow): string {
  const state = row.state?.toLowerCase();
  if (row.item) return [resourceMetadataText(row.item, row.matchMethod), state].filter(Boolean).join(" · ");
  const type = row.type && !["pane", "Place", "Command", "Recent", "Browse"].includes(row.type) ? row.type.toLowerCase() : null;
  const facts = [row.detail, type, state];
  return facts.filter((fact, index): fact is string => Boolean(fact) && facts.indexOf(fact) === index).join(" · ");
}
