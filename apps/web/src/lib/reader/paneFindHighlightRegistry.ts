export const CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME = "nexus-find-all";
export const CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME = "nexus-find-active";

const PASSIVE_HIGHLIGHT_PRIORITY = 0;
const ACTIVE_HIGHLIGHT_PRIORITY = 1;

export interface PaneFindHighlightRanges {
  readonly all: readonly Range[];
  readonly active: readonly Range[];
}

export interface PaneFindHighlightOwner {
  publish(ranges: PaneFindHighlightRanges): void;
  clear(): void;
}

const ownerRanges = new Map<symbol, PaneFindHighlightRanges>();

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
  priority: number,
  ranges: Range[],
): void {
  if (ranges.length === 0) {
    registry.delete(name);
    return;
  }
  const highlight = new Highlight();
  highlight.priority = priority;
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
    PASSIVE_HIGHLIGHT_PRIORITY,
    all,
  );
  publishFixedHighlight(
    registry,
    CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
    ACTIVE_HIGHLIGHT_PRIORITY,
    active,
  );
}

export function createPaneFindHighlightOwner(): PaneFindHighlightOwner {
  const ownerId = Symbol("PaneFindHighlightOwner");
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
