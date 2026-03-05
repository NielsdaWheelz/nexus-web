"use client";

export const WORKSPACE_SCHEMA_VERSION = 2;
export const WORKSPACE_VERSION_PARAM = "wsv";
export const WORKSPACE_STATE_PARAM = "ws";
export const WORKSPACE_DEFAULT_FALLBACK_HREF = "/libraries";

export const MAX_PANE_GROUPS = 4;
export const MAX_TABS_PER_GROUP = 12;
export const MAX_TOTAL_TABS = 24;
export const MIN_GROUP_WIDTH_PX = 280;
export const MAX_GROUP_WIDTH_PX = 1400;

export interface WorkspaceTabStateV2 {
  id: string;
  href: string;
}

export interface WorkspacePaneGroupStateV2 {
  id: string;
  activeTabId: string;
  tabs: WorkspaceTabStateV2[];
  widthPx?: number;
}

export interface WorkspaceStateV2 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activeGroupId: string;
  groups: WorkspacePaneGroupStateV2[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveBaseOrigin(baseOrigin?: string): string {
  if (baseOrigin && baseOrigin.length > 0) {
    return baseOrigin;
  }
  if (
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return "http://localhost";
}

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_GROUP_WIDTH_PX;
  }
  return Math.min(MAX_GROUP_WIDTH_PX, Math.max(MIN_GROUP_WIDTH_PX, Math.round(value)));
}

export function createWorkspaceId(prefix: "group" | "tab"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

export function normalizeWorkspaceHref(
  href: string,
  options?: { baseOrigin?: string }
): string | null {
  if (typeof href !== "string" || href.trim().length === 0) {
    return null;
  }

  const baseOrigin = resolveBaseOrigin(options?.baseOrigin);
  try {
    const parsed = new URL(href, baseOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.origin !== baseOrigin) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function createDefaultWorkspaceState(primaryHref: string): WorkspaceStateV2 {
  const normalizedHref =
    normalizeWorkspaceHref(primaryHref) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
  const groupId = createWorkspaceId("group");
  const tabId = createWorkspaceId("tab");
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeGroupId: groupId,
    groups: [
      {
        id: groupId,
        activeTabId: tabId,
        tabs: [{ id: tabId, href: normalizedHref }],
      },
    ],
  };
}

function sanitizeTab(
  value: unknown,
  fallbackHref: string,
  seenTabIds: Set<string>,
  options?: { baseOrigin?: string }
): WorkspaceTabStateV2 | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawHref = typeof value.href === "string" ? value.href : fallbackHref;
  const href = normalizeWorkspaceHref(rawHref, options) ?? fallbackHref;
  let id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "";
  if (!id || seenTabIds.has(id)) {
    id = createWorkspaceId("tab");
  }
  seenTabIds.add(id);
  return { id, href };
}

function sanitizeGroup(
  value: unknown,
  fallbackHref: string,
  remainingTabCapacity: number,
  options?: { baseOrigin?: string }
): WorkspacePaneGroupStateV2 | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return null;
  }

  const seenTabIds = new Set<string>();
  const tabs: WorkspaceTabStateV2[] = [];
  for (const rawTab of value.tabs) {
    if (tabs.length >= MAX_TABS_PER_GROUP || tabs.length >= remainingTabCapacity) {
      break;
    }
    const nextTab = sanitizeTab(rawTab, fallbackHref, seenTabIds, options);
    if (nextTab) {
      tabs.push(nextTab);
    }
  }

  if (tabs.length === 0) {
    return null;
  }

  let id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "";
  if (!id) {
    id = createWorkspaceId("group");
  }

  const requestedActiveTabId =
    typeof value.activeTabId === "string" ? value.activeTabId : "";
  const activeTabId =
    tabs.find((tab) => tab.id === requestedActiveTabId)?.id ?? tabs[0]?.id ?? "";
  if (!activeTabId) {
    return null;
  }

  const widthPx =
    typeof value.widthPx === "number" && Number.isFinite(value.widthPx)
      ? clampWidth(value.widthPx)
      : undefined;

  return { id, activeTabId, tabs, widthPx };
}

export function sanitizeWorkspaceState(
  value: unknown,
  options: { fallbackHref: string; baseOrigin?: string }
): WorkspaceStateV2 {
  const fallbackHref =
    normalizeWorkspaceHref(options.fallbackHref, options) ??
    WORKSPACE_DEFAULT_FALLBACK_HREF;

  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  const groups: WorkspacePaneGroupStateV2[] = [];
  const seenGroupIds = new Set<string>();
  let totalTabs = 0;

  for (const rawGroup of rawGroups) {
    if (groups.length >= MAX_PANE_GROUPS || totalTabs >= MAX_TOTAL_TABS) {
      break;
    }

    const sanitized = sanitizeGroup(
      rawGroup,
      fallbackHref,
      MAX_TOTAL_TABS - totalTabs,
      options
    );
    if (!sanitized) {
      continue;
    }

    if (seenGroupIds.has(sanitized.id)) {
      sanitized.id = createWorkspaceId("group");
    }
    seenGroupIds.add(sanitized.id);
    groups.push(sanitized);
    totalTabs += sanitized.tabs.length;
  }

  if (groups.length === 0) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const requestedActiveGroupId =
    typeof value.activeGroupId === "string" ? value.activeGroupId : "";
  const activeGroupId =
    groups.find((group) => group.id === requestedActiveGroupId)?.id ?? groups[0]?.id ?? "";

  if (!activeGroupId) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activeGroupId,
    groups,
  };
}

export function getActivePaneGroup(
  state: WorkspaceStateV2
): WorkspacePaneGroupStateV2 | null {
  if (!state.groups.length) {
    return null;
  }
  return state.groups.find((group) => group.id === state.activeGroupId) ?? state.groups[0] ?? null;
}

export function getActivePaneTab(state: WorkspaceStateV2): WorkspaceTabStateV2 | null {
  const group = getActivePaneGroup(state);
  if (!group) {
    return null;
  }
  return group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0] ?? null;
}

export function getPrimaryHrefFromWorkspaceState(state: WorkspaceStateV2): string {
  return getActivePaneTab(state)?.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
}

/**
 * Derive a short human-readable tab title from its href.
 * Shared by WorkspaceRoot (fallback) and AuthenticatedWorkspaceHost.
 */
export function tabTitleFromHref(href: string): string {
  try {
    const parsed = new URL(href, "http://localhost");
    const path = parsed.pathname.replace(/^\/+/, "");
    if (!path) {
      return "home";
    }
    const [root, id] = path.split("/");
    if (!id) {
      return root;
    }
    return `${root} ${id.slice(0, 8)}`;
  } catch {
    return "tab";
  }
}
