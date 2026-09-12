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

export function findSourceAnchor(root: HTMLElement, anchorId: string): HTMLElement | null {
  const matches = Array.from(root.querySelectorAll<HTMLElement>("[id], [name]"))
    .filter((element) => element.id === anchorId || element.getAttribute("name") === anchorId);
  return matches.length === 1 ? matches[0]! : null;
}
