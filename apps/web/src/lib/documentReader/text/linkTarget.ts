import type { ReaderTarget } from "../model";

/** A publication-bound link to another unit, or a same-unit authored anchor. */
export function readerLinkTarget(link: HTMLAnchorElement): ReaderTarget | null {
  const { nexusFragmentId: unit, nexusAnchorId: id } = link.dataset;
  if (unit) {
    return id
      ? { kind: "anchor", unit, id }
      : { kind: "point", point: { kind: "text", unit, offset: 0 } };
  }
  const href = link.getAttribute("href") ?? "";
  const owner = link.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
  return href.length > 1 && href.startsWith("#") && owner
    ? { kind: "anchor", unit: owner, id: decodeURIComponent(href.slice(1)) }
    : null;
}
