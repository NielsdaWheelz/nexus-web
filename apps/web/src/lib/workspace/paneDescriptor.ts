"use client";

import { resolvePaneRoute, type PaneRouteId } from "@/lib/panes/paneRouteRegistry";
import type { WorkspacePaneStateV3 } from "@/lib/workspace/schema";

export type PaneTitleSource =
  | "runtime_page"
  | "resource_cache"
  | "title_hint"
  | "route_static"
  | "safe_fallback";

export interface PaneOpenHint {
  titleHint?: string;
  resourceRef?: string | null;
}

export interface ResourceTitleCacheEntry {
  title: string;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface PaneDescriptor {
  paneId: string;
  href: string;
  routeId: PaneRouteId | "unsupported";
  resourceRef: string | null;
  staticTitle: string;
  resolvedTitle: string;
  titleSource: PaneTitleSource;
}

export interface PaneDescriptorResolverInputs {
  nowMs: number;
  runtimeTitleByPaneId: ReadonlyMap<string, string>;
  openHintByPaneId: ReadonlyMap<string, PaneOpenHint>;
  resourceTitleByRef: ReadonlyMap<string, ResourceTitleCacheEntry>;
}

interface StoredResourceTitleCache {
  version: 1;
  entries: Array<{
    resourceRef: string;
    title: string;
    updatedAtMs: number;
    expiresAtMs: number;
  }>;
}

const MAX_PANE_TITLE_LENGTH = 120;
const SAFE_FALLBACK_TITLE = "Pane";
const RESOURCE_TITLE_CACHE_STORAGE_KEY = "nexus.workspace.resource-title-cache.v1";
export const RESOURCE_TITLE_CACHE_TTL_MS = 1000 * 60 * 60 * 24;

export function normalizePaneTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const singleSpaced = raw.trim().replace(/\s+/g, " ");
  if (!singleSpaced) {
    return null;
  }
  return singleSpaced.slice(0, MAX_PANE_TITLE_LENGTH).trim();
}

function normalizeResourceRef(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createResourceTitleCacheEntry(
  title: string,
  nowMs: number,
  ttlMs: number = RESOURCE_TITLE_CACHE_TTL_MS
): ResourceTitleCacheEntry | null {
  const normalizedTitle = normalizePaneTitle(title);
  if (!normalizedTitle) {
    return null;
  }
  return {
    title: normalizedTitle,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
}

export function pruneResourceTitleCache(
  cache: ReadonlyMap<string, ResourceTitleCacheEntry>,
  nowMs: number
): Map<string, ResourceTitleCacheEntry> {
  const next = new Map<string, ResourceTitleCacheEntry>();
  for (const [resourceRef, entry] of cache) {
    const normalizedRef = normalizeResourceRef(resourceRef);
    const normalizedTitle = normalizePaneTitle(entry.title);
    if (!normalizedRef || !normalizedTitle) {
      continue;
    }
    if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= nowMs) {
      continue;
    }
    next.set(normalizedRef, {
      title: normalizedTitle,
      updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : nowMs,
      expiresAtMs: entry.expiresAtMs,
    });
  }
  return next;
}

export function loadResourceTitleCacheFromStorage(nowMs: number): Map<string, ResourceTitleCacheEntry> {
  if (typeof window === "undefined") {
    return new Map();
  }
  const raw = window.localStorage.getItem(RESOURCE_TITLE_CACHE_STORAGE_KEY);
  if (!raw) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as StoredResourceTitleCache;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return new Map();
    }
    const cache = new Map<string, ResourceTitleCacheEntry>();
    for (const entry of parsed.entries) {
      const resourceRef = normalizeResourceRef(entry.resourceRef);
      const title = normalizePaneTitle(entry.title);
      if (!resourceRef || !title) {
        continue;
      }
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= nowMs) {
        continue;
      }
      cache.set(resourceRef, {
        title,
        updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : nowMs,
        expiresAtMs: entry.expiresAtMs,
      });
    }
    return cache;
  } catch {
    return new Map();
  }
}

export function saveResourceTitleCacheToStorage(
  cache: ReadonlyMap<string, ResourceTitleCacheEntry>,
  nowMs: number
): void {
  if (typeof window === "undefined") {
    return;
  }
  const pruned = pruneResourceTitleCache(cache, nowMs);
  const payload: StoredResourceTitleCache = {
    version: 1,
    entries: Array.from(pruned.entries()).map(([resourceRef, entry]) => ({
      resourceRef,
      title: entry.title,
      updatedAtMs: entry.updatedAtMs,
      expiresAtMs: entry.expiresAtMs,
    })),
  };
  window.localStorage.setItem(RESOURCE_TITLE_CACHE_STORAGE_KEY, JSON.stringify(payload));
}

export function resolvePaneDescriptor(
  pane: WorkspacePaneStateV3,
  inputs: PaneDescriptorResolverInputs
): PaneDescriptor {
  const route = resolvePaneRoute(pane.href);
  const staticTitle = normalizePaneTitle(route.staticTitle) ?? SAFE_FALLBACK_TITLE;
  const hint = inputs.openHintByPaneId.get(pane.id);
  const routeResourceRef = normalizeResourceRef(route.resourceRef);
  const hintResourceRef = normalizeResourceRef(hint?.resourceRef);
  const resourceRef = routeResourceRef ?? hintResourceRef;

  const runtimeTitle = normalizePaneTitle(inputs.runtimeTitleByPaneId.get(pane.id));
  if (runtimeTitle) {
    return {
      paneId: pane.id,
      href: pane.href,
      routeId: route.id,
      resourceRef,
      staticTitle,
      resolvedTitle: runtimeTitle,
      titleSource: "runtime_page",
    };
  }

  if (resourceRef) {
    const cached = inputs.resourceTitleByRef.get(resourceRef);
    if (cached && cached.expiresAtMs > inputs.nowMs) {
      const cachedTitle = normalizePaneTitle(cached.title);
      if (cachedTitle) {
        return {
          paneId: pane.id,
          href: pane.href,
          routeId: route.id,
          resourceRef,
          staticTitle,
          resolvedTitle: cachedTitle,
          titleSource: "resource_cache",
        };
      }
    }
  }

  const titleHint = normalizePaneTitle(hint?.titleHint);
  if (titleHint) {
    return {
      paneId: pane.id,
      href: pane.href,
      routeId: route.id,
      resourceRef,
      staticTitle,
      resolvedTitle: titleHint,
      titleSource: "title_hint",
    };
  }

  if (staticTitle !== SAFE_FALLBACK_TITLE || route.id !== "unsupported") {
    return {
      paneId: pane.id,
      href: pane.href,
      routeId: route.id,
      resourceRef,
      staticTitle,
      resolvedTitle: staticTitle,
      titleSource: "route_static",
    };
  }

  return {
    paneId: pane.id,
    href: pane.href,
    routeId: route.id,
    resourceRef,
    staticTitle,
    resolvedTitle: SAFE_FALLBACK_TITLE,
    titleSource: "safe_fallback",
  };
}
