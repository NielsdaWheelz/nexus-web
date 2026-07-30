export const CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME = "nexus-find-all";
export const CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME = "nexus-find-active";

export interface CanonicalTextFindHighlightRanges {
  readonly all: readonly Range[];
  readonly active: readonly Range[];
}

export interface CanonicalTextFindHighlightOwner {
  publish(ranges: CanonicalTextFindHighlightRanges): void;
  clear(): void;
}

const ownerRanges = new Map<symbol, CanonicalTextFindHighlightRanges>();

function requireCustomHighlightRegistry(): HighlightRegistry {
  if (
    typeof CSS === "undefined" ||
    typeof Highlight === "undefined" ||
    !CSS.highlights
  ) {
    throw new Error(
      "Canonical text Find requires the CSS Custom Highlight API.",
    );
  }
  return CSS.highlights;
}

function publishFixedHighlight(
  registry: HighlightRegistry,
  name: string,
  ranges: Range[],
): void {
  if (ranges.length === 0) {
    registry.delete(name);
    return;
  }
  const highlight = new Highlight();
  for (const range of ranges) {
    highlight.add(range);
  }
  registry.set(name, highlight);
}

function publishRegistry(registry: HighlightRegistry): void {
  const all: Range[] = [];
  const active: Range[] = [];
  for (const ranges of ownerRanges.values()) {
    all.push(...ranges.all);
    active.push(...ranges.active);
  }
  publishFixedHighlight(
    registry,
    CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME,
    all,
  );
  publishFixedHighlight(
    registry,
    CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
    active,
  );
}

export function createCanonicalTextFindHighlightOwner(): CanonicalTextFindHighlightOwner {
  const ownerId = Symbol("CanonicalTextFindHighlightOwner");
  return {
    publish(ranges) {
      const registry = requireCustomHighlightRegistry();
      if (ranges.all.length === 0 && ranges.active.length === 0) {
        ownerRanges.delete(ownerId);
      } else {
        ownerRanges.set(ownerId, {
          all: [...ranges.all],
          active: [...ranges.active],
        });
      }
      publishRegistry(registry);
    },
    clear() {
      if (!ownerRanges.has(ownerId)) {
        return;
      }
      const registry = requireCustomHighlightRegistry();
      ownerRanges.delete(ownerId);
      publishRegistry(registry);
    },
  };
}
