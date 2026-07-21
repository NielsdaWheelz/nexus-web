// Pure path→pane-route resolution (segment matching, no React/DOM), so the
// server data root resolves the initial pane with the SAME resolver the client
// uses (D-5: one resolver). No "use client" — this module is isomorphic.
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";
import {
  getSecondaryGroupForSurface,
  type WorkspaceSecondaryGroupId,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS } from "@/lib/contributors/handle";

export const MAX_STANDARD_PANE_WIDTH_PX = 1400;
export const MAX_MEDIA_PANE_WIDTH_PX = 2400;

export interface PaneWidthContract {
  maxWidthPx: number;
  allowsIntrinsicPrimaryWidth: boolean;
}

export type PaneBodyMode = "standard" | "document" | "contained";
export type RouteParams = Record<string, string>;
export type RoutePattern = readonly string[];

export interface PaneRouteContext {
  href: string;
  params: RouteParams;
  androidShell?: boolean;
}

export type PaneRouteId =
  | "lectern"
  | "libraries"
  | "library"
  | "media"
  | "conversations"
  | "conversationNew"
  | "conversation"
  | "podcasts"
  | "podcastDetail"
  | "search"
  | "author"
  | "notes"
  | "page"
  | "note"
  | "settings"
  | "settingsAccount"
  | "settingsBilling"
  | "settingsReader"
  | "settingsAppearance"
  | "settingsLocalVault"
  | "settingsIdentities"
  | "settingsKeybindings"
  | "atlas"
  | "oracle"
  | "oracleReading";

export interface PaneRouteModelDefinition extends PaneWidthContract {
  id: PaneRouteId;
  pattern: RoutePattern;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  bodyMode: PaneBodyMode;
  secondaryGroups?: readonly WorkspaceSecondaryGroupId[];
}

export interface ResolvedPaneRouteModel {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: RouteParams;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  definition: PaneRouteModelDefinition | null;
}

const STANDARD_WIDTH_CONTRACT: PaneWidthContract = {
  maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
  allowsIntrinsicPrimaryWidth: false,
};

const MEDIA_READER_WIDTH_CONTRACT: PaneWidthContract = {
  maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
  allowsIntrinsicPrimaryWidth: true,
};

function route(
  definition: Omit<PaneRouteModelDefinition, keyof PaneWidthContract> &
    PaneWidthContract
): PaneRouteModelDefinition {
  return definition;
}

export const PANE_ROUTE_MODELS: readonly PaneRouteModelDefinition[] = [
  route({
    id: "lectern",
    pattern: ["lectern"],
    staticTitle: "Lectern",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "libraries",
    pattern: ["libraries"],
    staticTitle: "Libraries",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "library",
    pattern: ["libraries", ":id"],
    staticTitle: "Library",
    titleMode: "dynamic",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "media",
    pattern: ["media", ":id"],
    staticTitle: "Media",
    titleMode: "dynamic",
    bodyMode: "document",
    secondaryGroups: ["reader-tools"],
    ...MEDIA_READER_WIDTH_CONTRACT,
  }),
  route({
    id: "conversations",
    pattern: ["conversations"],
    staticTitle: "Chats",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversationNew",
    pattern: ["conversations", "new"],
    staticTitle: "New chat",
    titleMode: "static",
    bodyMode: "contained",
    secondaryGroups: ["conversation-context"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversation",
    pattern: ["conversations", ":id"],
    staticTitle: "Chat",
    titleMode: "dynamic",
    bodyMode: "contained",
    secondaryGroups: ["conversation-context"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcasts",
    pattern: ["podcasts"],
    staticTitle: "Podcasts",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcastDetail",
    pattern: ["podcasts", ":podcastId"],
    staticTitle: "Podcast",
    titleMode: "dynamic",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "search",
    pattern: ["search"],
    staticTitle: "Search",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "author",
    pattern: ["authors", ":handle"],
    staticTitle: "Author",
    titleMode: "dynamic",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "notes",
    pattern: ["notes"],
    staticTitle: "Notes",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "page",
    pattern: ["pages", ":pageId"],
    staticTitle: "Page",
    titleMode: "dynamic",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "note",
    pattern: ["notes", ":blockId"],
    staticTitle: "Note",
    titleMode: "dynamic",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settings",
    pattern: ["settings"],
    staticTitle: "Settings",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAccount",
    pattern: ["settings", "account"],
    staticTitle: "Account",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsBilling",
    pattern: ["settings", "billing"],
    staticTitle: "Billing",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsReader",
    pattern: ["settings", "reader"],
    staticTitle: "Reader settings",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAppearance",
    pattern: ["settings", "appearance"],
    staticTitle: "Appearance",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsLocalVault",
    pattern: ["settings", "local-vault"],
    staticTitle: "Local vault",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsIdentities",
    pattern: ["settings", "identities"],
    staticTitle: "Linked identities",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsKeybindings",
    pattern: ["settings", "keybindings"],
    staticTitle: "Keyboard shortcuts",
    titleMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "atlas",
    pattern: ["atlas"],
    staticTitle: "The Atlas",
    titleMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracle",
    pattern: ["oracle"],
    staticTitle: "Oracle",
    titleMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracleReading",
    pattern: ["oracle", ":readingId"],
    staticTitle: "Reading",
    titleMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
];

function toPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function matchPattern(pathname: string, pattern: RoutePattern): RouteParams | null {
  const segments = toPathSegments(pathname);
  if (segments.length !== pattern.length) {
    return null;
  }
  const params: RouteParams = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = segments[index] ?? "";
    const token = pattern[index] ?? "";
    if (token.startsWith(":")) {
      const paramName = token.slice(1);
      if (!paramName || !segment) {
        return null;
      }
      try {
        params[paramName] = decodeURIComponent(segment);
      } catch {
        return null;
      }
      continue;
    }
    if (token !== segment) {
      return null;
    }
  }
  return params;
}

function parseHrefPathname(href: string): string {
  return parseWorkspaceHref(href)?.pathname ?? "/";
}

export function resolvePaneRouteModel(href: string): ResolvedPaneRouteModel {
  const pathname = parseHrefPathname(href);
  for (const definition of PANE_ROUTE_MODELS) {
    const params = matchPattern(pathname, definition.pattern);
    if (!params) {
      continue;
    }
    // The `/authors/{handle}` space shadows the reserved collection segments the
    // deleted directory/reconciliation surfaces used; they are not author panes
    // (author-dedup §7 / D-26) — fall through to the unsupported placeholder.
    if (
      definition.id === "author" &&
      RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has(params.handle ?? "")
    ) {
      continue;
    }
    return {
      id: definition.id,
      pathname,
      params,
      staticTitle: definition.staticTitle,
      titleMode: definition.titleMode,
      definition,
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    staticTitle: "Tab",
    titleMode: "static",
    definition: null,
  };
}

export function resolvePaneRouteWidthContract(href: string): PaneWidthContract {
  const definition = resolvePaneRouteModel(href).definition;
  if (!definition) {
    return STANDARD_WIDTH_CONTRACT;
  }
  return {
    maxWidthPx: definition.maxWidthPx,
    allowsIntrinsicPrimaryWidth: definition.allowsIntrinsicPrimaryWidth,
  };
}

export function paneRouteAllowsSecondaryGroup(
  href: string,
  groupId: WorkspaceSecondaryGroupId,
): boolean {
  return resolvePaneRouteModel(href).definition?.secondaryGroups?.includes(groupId) ?? false;
}

export function paneRouteAllowsSecondarySurface(
  href: string,
  surfaceId: WorkspaceSecondarySurfaceId,
): boolean {
  return paneRouteAllowsSecondaryGroup(href, getSecondaryGroupForSurface(surfaceId));
}
