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
      readonly kind: "Section";
      readonly destinationId: DestinationId;
      /**
       * Whether the destination label appears beside the pane title. Index
       * routes whose title already *is* the destination declare `None`; the
       * routes below a destination declare `Destination` so a chat, page, or
       * library reads with the section it belongs to.
       */
      readonly context: "None" | "Destination";
    }
  | {
      readonly kind: "Resource";
      readonly pendingLabel: string;
    };

interface PaneRouteModelDefinitionCommon extends PaneWidthContract {
  id: string;
  pattern: RoutePattern;
  defaultLabel: string;
  labelMode: "static" | "dynamic";
  /**
   * An opt-in query policy for URL-owned pane state. Omitted routes preserve
   * the normal route-keyed mount behavior; opted-in routes retain their body
   * while replacing their query so controls, focus, and scroll stay continuous.
   */
  queryNavigation?: "in-place";
  secondaryGroups?: readonly WorkspaceSecondaryGroupId[];
}

export type PaneRouteReturnContract =
  | {
      readonly returnMemento: { readonly kind: "ShellScroll" };
      readonly bodyMode: "standard";
    }
  | {
      readonly returnMemento: { readonly kind: "NoVerticalScroll" };
      readonly bodyMode: "document";
    }
  | {
      readonly returnMemento: {
        readonly kind: "Excluded";
        readonly owner: "Reader";
      };
      readonly bodyMode: "document";
    }
  | {
      readonly returnMemento: {
        readonly kind: "Excluded";
        readonly owner: "Chat";
      };
      readonly bodyMode: "contained";
    };

type PaneRouteModelDefinitionBase = PaneRouteModelDefinitionCommon &
  PaneRouteReturnContract &
  (
    | {
        header: Extract<PaneRouteHeaderContract, { kind: "Section" }>;
        sectionDestinationId?: never;
      }
    | {
        header: Extract<PaneRouteHeaderContract, { kind: "Resource" }>;
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
      kind: "Section",
      destinationId: "lectern",
      context: "None",
    },
    pattern: ["lectern"],
    defaultLabel: "Lectern",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "libraries",
    header: {
      kind: "Section",
      destinationId: "libraries",
      context: "None",
    },
    pattern: ["libraries"],
    defaultLabel: "Libraries",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "library",
    header: {
      kind: "Section",
      destinationId: "libraries",
      context: "Destination",
    },
    pattern: ["libraries", ":id"],
    defaultLabel: "Library",
    labelMode: "dynamic",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "browse",
    header: {
      kind: "Section",
      destinationId: "browse",
      context: "None",
    },
    pattern: ["browse"],
    defaultLabel: "Browse",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "browsePreview",
    sectionDestinationId: "browse",
    header: { kind: "Resource", pendingLabel: "Loading preview…" },
    pattern: ["browse", "preview"],
    defaultLabel: "Preview",
    labelMode: "dynamic",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "media",
    sectionDestinationId: "libraries",
    header: { kind: "Resource", pendingLabel: "Loading media…" },
    pattern: ["media", ":id"],
    defaultLabel: "Media",
    labelMode: "dynamic",
    returnMemento: { kind: "Excluded", owner: "Reader" },
    bodyMode: "document",
    secondaryGroups: ["resource-inspector"],
    ...MEDIA_READER_WIDTH_CONTRACT,
  }),
  route({
    id: "artifact",
    sectionDestinationId: "libraries",
    header: { kind: "Resource", pendingLabel: "Loading dossier…" },
    pattern: ["artifacts", ":artifactRef"],
    defaultLabel: "Dossier",
    labelMode: "dynamic",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversations",
    header: {
      kind: "Section",
      destinationId: "chats",
      context: "None",
    },
    pattern: ["conversations"],
    defaultLabel: "Chats",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversationNew",
    header: {
      kind: "Section",
      destinationId: "chats",
      context: "Destination",
    },
    pattern: ["conversations", "new"],
    defaultLabel: "New chat",
    labelMode: "static",
    returnMemento: { kind: "Excluded", owner: "Chat" },
    bodyMode: "contained",
    // No Inspector until a conversation exists (A13); the resource-inspector group
    // is published only by the resolved `conversation` route below.
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "conversation",
    header: {
      kind: "Section",
      destinationId: "chats",
      context: "Destination",
    },
    pattern: ["conversations", ":id"],
    defaultLabel: "Chat",
    labelMode: "dynamic",
    returnMemento: { kind: "Excluded", owner: "Chat" },
    bodyMode: "contained",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcasts",
    header: {
      kind: "Section",
      destinationId: "podcasts",
      context: "None",
    },
    pattern: ["podcasts"],
    defaultLabel: "Podcasts",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "podcastDetail",
    header: {
      kind: "Section",
      destinationId: "podcasts",
      context: "Destination",
    },
    pattern: ["podcasts", ":podcastId"],
    defaultLabel: "Podcast",
    labelMode: "dynamic",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "search",
    header: {
      kind: "Section",
      destinationId: "search",
      context: "None",
    },
    pattern: ["search"],
    defaultLabel: "Search",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "author",
    header: {
      kind: "Section",
      destinationId: "authors",
      context: "Destination",
    },
    pattern: ["authors", ":handle"],
    defaultLabel: "Author",
    labelMode: "dynamic",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "notes",
    header: {
      kind: "Section",
      destinationId: "notes",
      context: "None",
    },
    pattern: ["notes"],
    defaultLabel: "Notes",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "page",
    header: {
      kind: "Section",
      destinationId: "notes",
      context: "Destination",
    },
    pattern: ["pages", ":pageId"],
    defaultLabel: "Page",
    labelMode: "dynamic",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "dailyDate",
    header: {
      kind: "Section",
      destinationId: "notes",
      context: "Destination",
    },
    pattern: ["daily", ":localDate"],
    defaultLabel: "Daily Page",
    labelMode: "dynamic",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "note",
    header: {
      kind: "Section",
      destinationId: "notes",
      context: "Destination",
    },
    pattern: ["notes", ":blockId"],
    defaultLabel: "Note",
    labelMode: "dynamic",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    secondaryGroups: ["resource-inspector"],
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "stats",
    header: {
      kind: "Section",
      destinationId: "stats",
      context: "None",
    },
    pattern: ["stats"],
    defaultLabel: "Stats",
    labelMode: "static",
    queryNavigation: "in-place",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settings",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "None",
    },
    pattern: ["settings"],
    defaultLabel: "Settings",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAccount",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "account"],
    defaultLabel: "Account",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsBilling",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "billing"],
    defaultLabel: "Billing",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsReader",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "reader"],
    defaultLabel: "Reader settings",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsAppearance",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "appearance"],
    defaultLabel: "Appearance",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsLocalVault",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "local-vault"],
    defaultLabel: "Local vault",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsIdentities",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "identities"],
    defaultLabel: "Linked identities",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "settingsKeybindings",
    header: {
      kind: "Section",
      destinationId: "settings",
      context: "Destination",
    },
    pattern: ["settings", "keybindings"],
    defaultLabel: "Keyboard shortcuts",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "atlas",
    header: {
      kind: "Section",
      destinationId: "atlas",
      context: "None",
    },
    pattern: ["atlas"],
    defaultLabel: "The Atlas",
    labelMode: "static",
    returnMemento: { kind: "NoVerticalScroll" },
    bodyMode: "document",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracle",
    header: {
      kind: "Section",
      destinationId: "oracle",
      context: "None",
    },
    pattern: ["oracle"],
    defaultLabel: "Oracle",
    labelMode: "static",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
    ...STANDARD_WIDTH_CONTRACT,
  }),
  route({
    id: "oracleReading",
    header: {
      kind: "Section",
      destinationId: "oracle",
      context: "Destination",
    },
    pattern: ["oracle", ":readingId"],
    defaultLabel: "Reading",
    // The reading body publishes the exact question as the pane label.
    labelMode: "dynamic",
    returnMemento: { kind: "ShellScroll" },
    bodyMode: "standard",
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
  if (definition.header.kind === "Section") {
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
