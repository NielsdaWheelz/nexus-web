"use client";

export const WORKSPACE_SCHEMA_VERSION = 3;
export const WORKSPACE_VERSION_PARAM = "wsv";
export const WORKSPACE_STATE_PARAM = "ws";
export const WORKSPACE_DEFAULT_FALLBACK_HREF = "/libraries";

export const MAX_PANES = 12;
export const MIN_PANE_WIDTH_PX = 320;
export const MAX_STANDARD_PANE_WIDTH_PX = 1400;
const MAX_PANE_TITLE_LENGTH = 120;

export interface WorkspacePaneStateV3 {
  id: string;
  href: string;
  widthPx: number;
}

export interface WorkspaceStateV3 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activePaneId: string;
  panes: WorkspacePaneStateV3[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createPaneId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `pane-${crypto.randomUUID()}`;
  }
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export function parseWorkspaceHref(
  href: string,
  options?: { baseOrigin?: string }
): URL | null {
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
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeWorkspaceHref(
  href: string,
  options?: { baseOrigin?: string }
): string | null {
  const parsed = parseWorkspaceHref(href, options);
  if (!parsed) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function normalizePaneTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_PANE_TITLE_LENGTH).trim();
}

export function clampPaneWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_PANE_WIDTH_PX;
  }
  return Math.min(MAX_STANDARD_PANE_WIDTH_PX, Math.max(MIN_PANE_WIDTH_PX, Math.round(value)));
}

export function createDefaultWorkspaceState(
  primaryHref: string,
  widthPx?: number
): WorkspaceStateV3 {
  const href = normalizeWorkspaceHref(primaryHref) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
  const id = createPaneId();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: id,
    panes: [{ id, href, widthPx: widthPx != null ? clampPaneWidth(widthPx) : 480 }],
  };
}

function sanitizePane(
  value: unknown,
  fallbackHref: string,
  seenIds: Set<string>,
  options?: { baseOrigin?: string }
): WorkspacePaneStateV3 | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawHref = typeof value.href === "string" ? value.href : fallbackHref;
  const href = normalizeWorkspaceHref(rawHref, options) ?? fallbackHref;

  let id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "";
  if (!id || seenIds.has(id)) {
    id = createPaneId();
  }
  seenIds.add(id);

  const widthPx =
    typeof value.widthPx === "number" ? clampPaneWidth(value.widthPx) : 480;

  return { id, href, widthPx };
}

export function sanitizeWorkspaceState(
  value: unknown,
  options: { fallbackHref: string; baseOrigin?: string }
): WorkspaceStateV3 {
  const fallbackHref =
    normalizeWorkspaceHref(options.fallbackHref, options) ??
    WORKSPACE_DEFAULT_FALLBACK_HREF;

  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const rawPanes = Array.isArray(value.panes) ? value.panes : [];
  const seenIds = new Set<string>();
  const panes: WorkspacePaneStateV3[] = [];

  for (const rawPane of rawPanes) {
    if (panes.length >= MAX_PANES) {
      break;
    }
    const pane = sanitizePane(rawPane, fallbackHref, seenIds, options);
    if (pane) {
      panes.push(pane);
    }
  }

  if (panes.length === 0) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const requestedActiveId =
    typeof value.activePaneId === "string" ? value.activePaneId : "";
  const activePaneId =
    panes.find((p) => p.id === requestedActiveId)?.id ?? panes[0]?.id ?? "";

  if (!activePaneId) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, activePaneId, panes };
}
