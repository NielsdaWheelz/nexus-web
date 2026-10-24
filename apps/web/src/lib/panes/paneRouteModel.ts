// The pane router: href -> pane kind. One table of routes, a few trait sets,
// and one resolver that derives every identity (routeKey, resource, mount key).
// Isomorphic: the server bootstrap and the client resolve alike.
import {
  BookOpen,
  ChartColumn,
  Compass,
  FileText,
  Globe,
  Keyboard,
  Library,
  Link2,
  ListMusic,
  ListTodo,
  Map,
  MessageSquare,
  Mic,
  Palette,
  Search,
  Settings,
  Sparkles,
  UserCog,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { DestinationId } from "@/lib/navigation/destinations";
import type { Schema } from "@/lib/api/wire";
import { conversationEndpoint } from "@/lib/chat/view";
import { isContributorHandle } from "@/lib/contributors/credits";
import { isLocalDate } from "@/lib/localDate";
import type { WorkspaceSecondaryGroupId } from "@/lib/panes/paneSecondaryModel";
import {
  formatResourceRef,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";
import { routeShareTarget } from "@/lib/sharing/targets";
import type { ShareTarget } from "@/lib/sharing/types";
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";

// path, default label, icon. The first match wins.
const ROUTES = {
  lectern: ["lectern", "Lectern", ListMusic],
  libraries: ["libraries", "Libraries", Library],
  library: ["libraries/:id", "Library", Library],
  browse: ["browse", "Browse", Compass],
  browsePreview: ["browse/preview", "Preview", Compass],
  media: ["media/:id", "Media", FileText],
  conversations: ["conversations", "Chats", MessageSquare],
  conversationNew: ["conversations/new", "New chat", MessageSquare],
  conversation: ["conversations/:id", "Chat", MessageSquare],
  podcasts: ["podcasts", "Podcasts", Mic],
  podcastDetail: ["podcasts/:podcastId", "Podcast", Mic],
  search: ["search", "Search", Search],
  author: ["authors/:handle", "Author", UserRound],
  notes: ["notes", "Notes", FileText],
  pageNew: ["pages/new", "New page", FileText],
  page: ["pages/:pageId", "Page", FileText],
  dailyDate: ["daily/:localDate", "Daily Page", FileText],
  note: ["notes/:blockId", "Note", FileText],
  imports: ["imports", "Imports", ListTodo],
  stats: ["stats", "Stats", ChartColumn],
  settings: ["settings", "Settings", Settings],
  settingsAccount: ["settings/account", "Account", UserCog],
  settingsReader: ["settings/reader", "Reader settings", BookOpen],
  settingsAppearance: ["settings/appearance", "Appearance", Palette],
  settingsIdentities: ["settings/identities", "Linked identities", Link2],
  settingsKeybindings: ["settings/keybindings", "Keyboard shortcuts", Keyboard],
  atlas: ["atlas", "The Atlas", Map],
  oracle: ["oracle", "Oracle", Sparkles],
  oracleReading: ["oracle/:readingId", "Reading", Sparkles],
} as const satisfies Record<string, readonly [string, string, LucideIcon]>;

export type PaneRouteId = keyof typeof ROUTES;
type Traits<T> = Partial<Record<PaneRouteId, T>>;

// The resource a route names: [scheme, path param].
const RESOURCE: Traits<[ResourceScheme | "contributor_handle", string]> = {
  library: ["library", "id"],
  media: ["media", "id"],
  conversation: ["conversation", "id"],
  podcastDetail: ["podcast", "podcastId"],
  author: ["contributor_handle", "handle"],
  page: ["page", "pageId"],
  note: ["note_block", "blockId"],
  oracleReading: ["oracle_reading", "readingId"],
};
// Query changes keep the mounted body (url-owned filters, sort, selection).
const IN_PLACE = new Set<PaneRouteId>([
  "lectern",
  "libraries",
  "library",
  "browse",
  "conversations",
  "podcasts",
  "podcastDetail",
  "search",
  "author",
  "notes",
  "imports",
  "stats",
]);
// Not shareable by pathname: private or transient routes (resource panes
// share their resource instead).
const UNSHARED = new Set<PaneRouteId>(["conversationNew", "pageNew", "search", "dailyDate"]);
// Section, where it is not the first path segment.
const SECTION: Traits<DestinationId> = {
  media: "libraries",
  conversations: "chats",
  conversationNew: "chats",
  conversation: "chats",
  pageNew: "notes",
  page: "notes",
  dailyDate: "notes",
};
// Resource support lines show this until the body publishes its metadata.
const PENDING_LABEL: Traits<string> = {
  browsePreview: "Loading preview…",
  media: "Loading media…",
};
export type PaneReturnKind = "ShellScroll" | "NoVerticalScroll" | "Reader" | "Chat";
const RETURN_KIND: Traits<PaneReturnKind> = {
  media: "Reader",
  conversationNew: "Chat",
  conversation: "Chat",
  atlas: "NoVerticalScroll",
};
const BODY_MODE = {
  ShellScroll: "standard",
  NoVerticalScroll: "document",
  Reader: "document",
  Chat: "contained",
} as const;
const STANDARD_WIDTH = { maxWidthPx: 1400, allowsIntrinsicPrimaryWidth: false };
const READER_WIDTH = { maxWidthPx: 2400, allowsIntrinsicPrimaryWidth: true };

export type PaneBodyMode = (typeof BODY_MODE)[PaneReturnKind];
/** Section context `None`: the title is the destination (index routes, unsupported). */
export type PaneRouteHeaderContract =
  | { readonly kind: "Section"; readonly context: "None" }
  | {
      readonly kind: "Section";
      readonly context: "Destination";
      readonly destinationId: DestinationId;
    }
  | { readonly kind: "Resource"; readonly pendingLabel: string };
export interface PaneWidthContract {
  maxWidthPx: number;
  allowsIntrinsicPrimaryWidth: boolean;
}
export type PaneResourceLocator =
  | { kind: "resource_ref"; ref: string }
  | { kind: "contributor_handle"; handle: string };
export type PanePresentationLocator =
  Schema<"WorkspacePresentationsRequest">["locators"][number];
export type PaneRouteShareIdentity = Extract<ShareTarget, { kind: "Route" }>;

interface PaneRouteTraits {
  defaultLabel: string;
  labelMode: "static" | "dynamic";
  icon: LucideIcon;
  section: DestinationId | null;
  header: PaneRouteHeaderContract;
  returnKind: PaneReturnKind;
  bodyMode: PaneBodyMode;
  queryNavigation: "in-place" | null;
  width: PaneWidthContract;
  groups: readonly WorkspaceSecondaryGroupId[];
  shareByRoute: boolean;
}

export interface ResolvedPaneRouteModel extends PaneRouteTraits {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: Record<string, string>;
  /** Visit/memento identity excludes hashes and a conversation's local endpoint. */
  routeKey: string;
  locator: PaneResourceLocator | null;
  /** e.g. `resource_ref:media:<id>`; null when the route names no resource. */
  resourceKey: string | null;
  /** Title reads include latent daily pages without changing Inspector identity. */
  titleLocator: PanePresentationLocator | null;
  /** Canonical locator identity, or a preview's exact sealed target. */
  titleKey: string | null;
}

const TABLE = (Object.keys(ROUTES) as PaneRouteId[]).map((id) => {
  const [path, defaultLabel, icon] = ROUTES[id];
  const pattern = path.split("/");
  const section = SECTION[id] ?? (pattern[0] as DestinationId);
  const pendingLabel = PENDING_LABEL[id];
  const returnKind = RETURN_KIND[id] ?? "ShellScroll";
  const traits: PaneRouteTraits = {
    defaultLabel,
    labelMode:
      RESOURCE[id] || id === "browsePreview" || id === "dailyDate"
        ? "dynamic"
        : "static",
    icon,
    section,
    header: pendingLabel
      ? { kind: "Resource", pendingLabel }
      : pattern.length === 1
        ? { kind: "Section", context: "None" }
        : { kind: "Section", context: "Destination", destinationId: section },
    returnKind,
    bodyMode: BODY_MODE[returnKind],
    queryNavigation: IN_PLACE.has(id) ? "in-place" : null,
    width: returnKind === "Reader" ? READER_WIDTH : STANDARD_WIDTH,
    // Resource panes (but the oracle reading) and the latent daily page offer
    // the Resource Inspector; imports offers its own.
    groups:
      id === "imports"
        ? ["imports-inspector"]
        : (RESOURCE[id] && id !== "oracleReading") || id === "dailyDate"
          ? ["resource-inspector"]
          : [],
    shareByRoute: !RESOURCE[id] && !UNSHARED.has(id) && pattern[0] !== "settings",
  };
  return { id, pattern, traits };
});

const UNSUPPORTED: PaneRouteTraits = {
  defaultLabel: "Tab",
  labelMode: "static",
  icon: Globe,
  section: null,
  // A pane on a path no route renders still has its header, so Back works.
  header: { kind: "Section", context: "None" },
  returnKind: "ShellScroll",
  bodyMode: "standard",
  queryNavigation: null,
  width: STANDARD_WIDTH,
  groups: [],
  shareByRoute: false,
};

function matchPattern(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, token] of pattern.entries()) {
    if (!token.startsWith(":")) {
      if (token !== segments[index]) return null;
      continue;
    }
    try {
      params[token.slice(1)] = decodeURIComponent(segments[index]!);
    } catch {
      return null;
    }
  }
  return params;
}

function locatorFor(
  id: PaneRouteId,
  params: Record<string, string>,
): PaneResourceLocator | null {
  const [scheme, param] = RESOURCE[id] ?? [];
  const value = param ? params[param]! : "";
  if (!scheme) return null;
  if (scheme === "contributor_handle") {
    const handle = value;
    return isContributorHandle(handle) ? { kind: "contributor_handle", handle } : null;
  }
  const ref = formatResourceRef({ scheme, id: value });
  return parseResourceRef(ref)?.scheme === scheme
    ? { kind: "resource_ref", ref }
    : null;
}

export function paneResourceLocatorKey(
  locator: PaneResourceLocator | null,
): string | null {
  if (!locator) return null;
  return locator.kind === "resource_ref"
    ? `resource_ref:${locator.ref}`
    : `contributor_handle:${locator.handle}`;
}

export function panePresentationLocatorKey(locator: PanePresentationLocator): string {
  return locator.kind === "daily_date"
    ? `daily_date:${locator.local_date}`
    : paneResourceLocatorKey(locator)!;
}

export function resolvePaneRouteModel(href: string): ResolvedPaneRouteModel {
  const url = parseWorkspaceHref(href);
  const pathname = url?.pathname ?? "/";
  const search = url?.search ?? "";
  const segments = pathname.split("/").filter(Boolean);
  for (const { id, pattern, traits } of TABLE) {
    const params = matchPattern(pattern, segments);
    if (!params) continue;
    const locator = locatorFor(id, params);
    // A reading id must be a resource ref, so retired literal paths stay
    // unsupported.
    if (id === "oracleReading" && !locator) continue;
    let viewSearch = search;
    if (id === "conversation") {
      const query = new URLSearchParams(search);
      query.delete("leaf");
      query.delete("loc");
      viewSearch = query.size ? `?${query}` : "";
    }
    const routeKey = `${id}:${pathname}${viewSearch}`;
    const resourceKey = paneResourceLocatorKey(locator);
    const titleLocator: PanePresentationLocator | null =
      id === "dailyDate" && isLocalDate(params.localDate!)
        ? { kind: "daily_date", local_date: params.localDate! }
        : locator;
    const previewTarget = id === "browsePreview" ? url?.searchParams.get("target") : null;
    const titleKey = titleLocator
      ? panePresentationLocatorKey(titleLocator)
      : previewTarget ? `preview:${previewTarget}` : null;
    const defaultLabel = id === "stats" && url?.searchParams.get("view") === "year"
      ? "Year in Reading"
      : traits.defaultLabel;
    return { ...traits, defaultLabel, id, pathname, params, routeKey, locator, resourceKey, titleLocator, titleKey };
  }
  return {
    ...UNSUPPORTED,
    id: "unsupported",
    pathname,
    params: {},
    routeKey: `unsupported:${pathname}${search}`,
    locator: null,
    resourceKey: null,
    titleLocator: null,
    titleKey: null,
  };
}

export function sectionDestinationIdForHref(
  href: string,
): DestinationId | null {
  return resolvePaneRouteModel(href).section;
}

export function getPaneRouteIcon(href: string): LucideIcon {
  return resolvePaneRouteModel(href).icon;
}

/** Arrival selectors do not make another view; material query filters still do. */
export function resolveWorkspaceActivationRouteId(href: string): string {
  const route = resolvePaneRouteModel(href);
  const query = parseWorkspaceHref(href)?.searchParams ?? new URLSearchParams();
  const arrival = route.id === "media"
    ? ["fragment", "loc", "apparatus", "apparatus_id", "x_post"]
    : route.id === "conversation" ? ["message", "loc"] : [];
  for (const key of arrival) query.delete(key);
  query.sort();
  return `${route.id}:${route.resourceKey ?? route.pathname}${query.size ? `?${query}` : ""}`;
}

/** Matching is asymmetric: a bare chat names its owner; an explicit leaf names one view. */
export function matchWorkspaceTargetHref(currentHref: string, targetHref: string): string | null {
  const target = resolvePaneRouteModel(targetHref);
  if (target.id !== "conversation")
    return resolveWorkspaceActivationRouteId(currentHref) === resolveWorkspaceActivationRouteId(targetHref) ? targetHref : null;
  const current = resolvePaneRouteModel(currentHref);
  if (target.resourceKey === null || current.resourceKey !== target.resourceKey) return null;
  const url = parseWorkspaceHref(targetHref)!;
  const endpoint = conversationEndpoint(url.searchParams);
  if (endpoint.kind === "Invalid") return null;
  if (endpoint.kind === "Endpoint") {
    const candidate = conversationEndpoint(parseWorkspaceHref(currentHref)!.searchParams);
    if (candidate.kind !== "Endpoint" || candidate.messageId !== endpoint.messageId) return null;
  }
  if (url.search || url.hash) return targetHref;
  const retained = parseWorkspaceHref(currentHref)!;
  retained.searchParams.delete("message");
  retained.searchParams.delete("loc");
  retained.hash = "";
  return `${retained.pathname}${retained.search}${retained.hash}`;
}

/**
 * The body instance a visit mounts: in-place routes keep it across query
 * changes, scroll-restoring routes remount per visit and route, readers and
 * chats keep it for their resource across pushes and hash changes.
 */
export function paneMountKey(
  route: ResolvedPaneRouteModel,
  visitId: string,
): string {
  if (route.id === "pageNew" || route.id === "page") return `${visitId}:page-authoring`;
  if (route.queryNavigation) return `${visitId}:${route.id}:${route.pathname}`;
  if (route.returnKind === "ShellScroll") return `${visitId}:${route.routeKey}`;
  return route.resourceKey ? `${route.id}:${route.resourceKey}` : route.routeKey;
}

export function resolvePaneRouteShareIdentity(
  route: ResolvedPaneRouteModel,
  label: string,
): PaneRouteShareIdentity | null {
  if (!route.shareByRoute) return null;
  const target = routeShareTarget({ href: route.pathname, label });
  return target.kind === "Route" ? target : null;
}
