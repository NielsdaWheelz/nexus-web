"use client";

import type {
  EpubNavigationSection,
} from "@/lib/media/epubReader";

export interface NavigationTocNodeLike {
  section_id: string | null;
  href: string | null;
  children: NavigationTocNodeLike[];
}

export interface EpubInternalLinkTarget {
  sectionId: string;
  anchorId: string | null;
}

export function parseAnchorIdFromHref(href: string | null): string | null {
  if (!href || !href.includes("#")) {
    return null;
  }
  const fragment = href.split("#", 2)[1];
  if (!fragment) {
    return null;
  }
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function resolveSectionAnchorId(
  sectionId: string,
  sectionAnchorId: string | null,
  tocNodes: NavigationTocNodeLike[] | null
): string | null {
  if (sectionAnchorId) {
    return sectionAnchorId;
  }
  if (!tocNodes || tocNodes.length === 0) {
    return null;
  }

  const stack = [...tocNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.section_id === sectionId) {
      const anchor = parseAnchorIdFromHref(node.href);
      if (anchor) {
        return anchor;
      }
    }
    if (node.children.length > 0) {
      stack.push(...node.children);
    }
  }

  return null;
}

export function buildEpubLocationHref(
  mediaId: string,
  sectionId: string,
  options?: {
    fragmentId?: string | null;
    highlightId?: string | null;
  }
): string {
  const params = new URLSearchParams();
  params.set("loc", sectionId);
  if (options?.fragmentId) {
    params.set("fragment", options.fragmentId);
  }
  if (options?.highlightId) {
    params.set("highlight", options.highlightId);
  }
  return `/media/${mediaId}?${params.toString()}`;
}

const EPUB_LINK_ORIGIN = "https://epub.local";
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function decodeEpubHrefPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeEpubHref(
  href: string,
  baseHref: string | null
): { path: string | null; anchorId: string | null } | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("#")) {
    return {
      path: null,
      anchorId: decodeEpubHrefPart(trimmed.slice(1)) || null,
    };
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("?") || URI_SCHEME_RE.test(trimmed)) {
    return null;
  }

  if (!baseHref) {
    return null;
  }

  try {
    const baseUrl = new URL(baseHref, `${EPUB_LINK_ORIGIN}/`);
    const resolved = new URL(trimmed, baseUrl);
    return {
      path: resolved.pathname.replace(/^\/+/, "") || null,
      anchorId: resolved.hash ? decodeEpubHrefPart(resolved.hash.slice(1)) || null : null,
    };
  } catch {
    return null;
  }
}

function normalizeTocLinkPath(href: string | null): string | null {
  if (!href) {
    return null;
  }
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  if (trimmed.startsWith("?") || URI_SCHEME_RE.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, `${EPUB_LINK_ORIGIN}/`);
    return parsed.pathname.replace(/^\/+/, "") || null;
  } catch {
    return trimmed.replace(/^\/+/, "") || null;
  }
}

export function resolveEpubInternalLinkTarget(
  href: string | null,
  currentSectionId: string | null,
  sections: EpubNavigationSection[] | null
): EpubInternalLinkTarget | null {
  if (!href || !sections || sections.length === 0) {
    return null;
  }

  const normalizedHref = normalizeEpubHref(href, currentSectionId);
  if (!normalizedHref) {
    return null;
  }

  const targetPath = normalizedHref.path;
  if (!targetPath) {
    if (normalizedHref.anchorId) {
      return {
        sectionId: currentSectionId ?? sections[0].section_id,
        anchorId: normalizedHref.anchorId,
      };
    }
    return null;
  }

  const targetSection = sections.find((section) => {
    const sectionPath = normalizeTocLinkPath(section.href_path);
    return sectionPath === targetPath || section.section_id === targetPath;
  });
  if (!targetSection) {
    return null;
  }

  return {
    sectionId: targetSection.section_id,
    anchorId: normalizedHref.anchorId,
  };
}
