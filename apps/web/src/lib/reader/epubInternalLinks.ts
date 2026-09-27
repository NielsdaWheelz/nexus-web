import { absent, present, type Presence } from "@/lib/api/presence";
export interface EpubRestoreRequest {
  fragmentId: string;
  target: { kind: "Offset"; offset: number } | { kind: "Anchor"; anchorId: string };
}

// The server resolves source-relative hrefs within this publication. The reader
// consumes that exact fragment identity; it never derives a section from a URL.
export function resolveEpubInternalLinkTarget(link: HTMLAnchorElement): Presence<EpubRestoreRequest> {
  const fragmentId = link.getAttribute("data-nexus-fragment-id");
  if (fragmentId === null) return absent();
  const anchorId = link.getAttribute("data-nexus-anchor-id");
  return present({
    fragmentId,
    target: anchorId === null ? { kind: "Offset", offset: 0 } : { kind: "Anchor", anchorId },
  });
}

export function resolveReaderInternalLinkTarget(
  link: HTMLAnchorElement,
  webArticleFragmentId: string | null,
): Presence<EpubRestoreRequest> {
  const epubTarget = resolveEpubInternalLinkTarget(link);
  if (epubTarget.kind === "Present" || webArticleFragmentId === null) return epubTarget;
  const href = link.getAttribute("href");
  if (!href?.startsWith("#")) return absent();
  const rawAnchor = href.slice(1);
  let anchorId = rawAnchor;
  try { anchorId = decodeURIComponent(rawAnchor); } catch { /* An authored percent sign is literal. */ }
  return present({
    fragmentId: webArticleFragmentId,
    target: anchorId ? { kind: "Anchor", anchorId } : { kind: "Offset", offset: 0 },
  });
}

export function findSourceAnchor(root: HTMLElement, anchorId: string): HTMLElement | null {
  const matches = Array.from(root.querySelectorAll<HTMLElement>("[id], [name]"))
    .filter((element) => element.id === anchorId || element.getAttribute("name") === anchorId);
  return matches.length === 1 ? matches[0]! : null;
}

/** An id identifies a link only when it belongs to that link alone. */
export function findUniqueSourceLinkOwner(root: HTMLElement, link: HTMLAnchorElement): HTMLElement | null {
  if (!root.contains(link)) return null;
  const owner = link.closest<HTMLElement>("[id]");
  if (!owner?.id || findSourceAnchor(root, owner.id) !== owner) return null;
  if (owner === link) return owner;
  const links = owner.querySelectorAll("a[href]");
  return links.length === 1 && links[0] === link ? owner : null;
}
