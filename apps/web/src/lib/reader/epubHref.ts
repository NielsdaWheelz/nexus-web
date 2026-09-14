const EPUB_LINK_ORIGIN = "https://epub.local";
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** Lookup spelling only; authored hrefs remain unchanged in source locators. */
export function normalizeEpubPathname(hrefPath: string | null): string | null {
  const trimmed = hrefPath?.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("?") || URI_SCHEME_RE.test(trimmed)) return null;
  try {
    return new URL(trimmed, `${EPUB_LINK_ORIGIN}/`).pathname.replace(/^\/+/, "") || null;
  } catch {
    return trimmed.replace(/^\/+/, "") || null;
  }
}

function decodeEpubHrefPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeEpubHref(
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
