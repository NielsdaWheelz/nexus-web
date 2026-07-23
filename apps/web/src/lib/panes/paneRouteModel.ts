// Pure path→pane-route resolution (segment matching, no React/DOM), so the
// server data root resolves the initial pane with the SAME resolver the client
// uses (D-5: one resolver). No "use client" — this module is isomorphic.
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";
import type { DestinationId } from "@/lib/navigation/destinations";
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

export type PaneRouteHeaderContract =
  | {
      readonly kind: "section";
      readonly destinationId: DestinationId;
      readonly defaultFolio: "none" | "pane-label";
    }
  | {
      readonly kind: "resource";
      readonly pendingLabel: string;
    };

interface PaneRouteModelDefinitionCommon extends PaneWidthContract {
  id: string;
  pattern: RoutePattern;
  defaultLabel: string;
  labelMode: "static" | "dynamic";
  bodyMode: PaneBodyMode;
  secondaryGroups?: readonly WorkspaceSecondaryGroupId[];
}

type PaneRouteModelDefinitionBase = PaneRouteModelDefinitionCommon &
  (
    | {
        header: Extract<PaneRouteHeaderContract, { kind: "section" }>;
        sectionDestinationId?: never;
      }
    | {
        header: Extract<PaneRouteHeaderContract, { kind: "resource" }>;
        sectionDestinationId: DestinationId;
      }
  );

const STANDARD_WIDTH_CONTRACT: PaneWidthContract = {
  maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
  allowsIntrinsicPrimaryWidth: false,
};

const MEDIA_READER_WIDTH_CONTRACT: PaneWidthContract = {
  maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
  allowsIntrinsicPrimaryWidth: true,
};

function route<const Definition extends PaneRouteModelDefinitionBase>(
  definition: Definition,
): Definition {
  return definition;
}

export const PANE_ROUTE_MODELS = [
  route({
    id: "lectern",
    header: {
      kind: "section",
      destinationId: "lectern",
      defaultFolio: "none",
    },
    pattern: ["lectern"],
    defaultLabel: "Lectern",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "libraries",
    header: {
      kind: "section",
      destinationId: "libraries",
      defaultFolio: "none",
    },
    pattern: ["libraries"],
    defaultLabel: "Libraries",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "library",
    header: {
      kind: "section",
      destinationId: "libraries",
      defaultFolio: "none",
    },
    pattern: ["libraries", ":id"],
    defaultLabel: "Library",
    labelMode: "dynamic",
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "media",
    sectionDestinationId: "libraries",
    header: { kind: "resource", pendingLabel: "Loading media…" },
    pattern: ["media", ":id"],
    defaultLabel: "Media",
    labelMode: "dynamic",
    bodyMode: "document",
    secondaryGroups: ["resource-inspector"],
    ...MEDIA_READER_WIDTH_CONTRACT,
  }),
  route({
    id: "conversations",
    header: {
      kind: "section",
      destinationId: "chats",
      defaultFolio: "none",
    },
    pattern: ["conversations"],
    defaultLabel: "Chats",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversationNew",
    header: {
      kind: "section",
      destinationId: "chats",
      defaultFolio: "none",
    },
    pattern: ["conversations", "new"],
    defaultLabel: "New chat",
    labelMode: "static",
    bodyMode: "contained",
    // No Inspector until a conversation exists (A13); the resource-inspector group
    // is published only by the resolved `conversation` route below.
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversation",
    header: {
      kind: "section",
      destinationId: "chats",
      defaultFolio: "none",
    },
    pattern: ["conversations", ":id"],
    defaultLabel: "Chat",
    labelMode: "dynamic",
    bodyMode: "contained",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcasts",
    header: {
      kind: "section",
      destinationId: "podcasts",
      defaultFolio: "none",
    },
    pattern: ["podcasts"],
    defaultLabel: "Podcasts",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcastDetail",
    header: {
      kind: "section",
      destinationId: "podcasts",
      defaultFolio: "pane-label",
    },
    pattern: ["podcasts", ":podcastId"],
    defaultLabel: "Podcast",
    labelMode: "dynamic",
    bodyMode: "document",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "search",
    header: {
      kind: "section",
      destinationId: "search",
      defaultFolio: "none",
    },
    pattern: ["search"],
    defaultLabel: "Search",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "author",
    header: {
      kind: "section",
      destinationId: "authors",
      defaultFolio: "none",
    },
    pattern: ["authors", ":handle"],
    defaultLabel: "Author",
    labelMode: "dynamic",
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "notes",
    header: {
      kind: "section",
      destinationId: "notes",
      defaultFolio: "none",
    },
    pattern: ["notes"],
    defaultLabel: "Notes",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "page",
    header: {
      kind: "section",
      destinationId: "notes",
      defaultFolio: "pane-label",
    },
    pattern: ["pages", ":pageId"],
    defaultLabel: "Page",
    labelMode: "dynamic",
    bodyMode: "document",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "note",
    header: {
      kind: "section",
      destinationId: "notes",
      defaultFolio: "pane-label",
    },
    pattern: ["notes", ":blockId"],
    defaultLabel: "Note",
    labelMode: "dynamic",
    bodyMode: "document",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settings",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings"],
    defaultLabel: "Settings",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAccount",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "account"],
    defaultLabel: "Account",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsBilling",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "billing"],
    defaultLabel: "Billing",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsReader",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "reader"],
    defaultLabel: "Reader settings",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAppearance",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "appearance"],
    defaultLabel: "Appearance",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsLocalVault",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "local-vault"],
    defaultLabel: "Local vault",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsIdentities",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "identities"],
    defaultLabel: "Linked identities",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsKeybindings",
    header: {
      kind: "section",
      destinationId: "settings",
      defaultFolio: "none",
    },
    pattern: ["settings", "keybindings"],
    defaultLabel: "Keyboard shortcuts",
    labelMode: "static",
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "atlas",
    header: {
      kind: "section",
      destinationId: "atlas",
      defaultFolio: "pane-label",
    },
    pattern: ["atlas"],
    defaultLabel: "The Atlas",
    labelMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracle",
    header: {
      kind: "section",
      destinationId: "oracle",
      defaultFolio: "pane-label",
    },
    pattern: ["oracle"],
    defaultLabel: "Oracle",
    labelMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracleReading",
    header: {
      kind: "section",
      destinationId: "oracle",
      defaultFolio: "pane-label",
    },
    pattern: ["oracle", ":readingId"],
    defaultLabel: "Reading",
    labelMode: "static",
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
] as const satisfies readonly PaneRouteModelDefinitionBase[];

/** Route identity is derived from the one literal registry and cannot drift. */
export type PaneRouteId = (typeof PANE_ROUTE_MODELS)[number]["id"];

export type PaneRouteModelDefinition = PaneRouteModelDefinitionBase & {
  id: PaneRouteId;
};

interface ResolvedPaneRouteModelCommon {
  pathname: string;
  params: RouteParams;
  defaultLabel: string;
  labelMode: "static" | "dynamic";
}

export type ResolvedPaneRouteModel = ResolvedPaneRouteModelCommon &
  (
    | {
        id: PaneRouteId;
        header: PaneRouteHeaderContract;
        definition: PaneRouteModelDefinition;
      }
    | {
        id: "unsupported";
        header: null;
        definition: null;
      }
  );

function sectionDestinationIdForDefinition(
  definition: PaneRouteModelDefinition,
): DestinationId {
  if (definition.header.kind === "section") {
    return definition.header.destinationId;
  }
  if (!definition.sectionDestinationId) {
    throw new Error(
      `Resource pane route ${definition.id} has no navigation destination`,
    );
  }
  return definition.sectionDestinationId;
}

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
      defaultLabel: definition.defaultLabel,
      labelMode: definition.labelMode,
      header: definition.header,
      definition,
    };
  }
  return {
    id: "unsupported",
    pathname,
    params: {},
    defaultLabel: "Tab",
    labelMode: "static",
    header: null,
    definition: null,
  };
}

export function sectionDestinationIdForHref(href: string): DestinationId | null {
  const definition = resolvePaneRouteModel(href).definition;
  return definition ? sectionDestinationIdForDefinition(definition) : null;
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
