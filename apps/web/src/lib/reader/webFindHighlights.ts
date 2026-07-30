export const WEB_FIND_ALL_HIGHLIGHT_NAME = "nexus-find-all";
export const WEB_FIND_ACTIVE_HIGHLIGHT_NAME = "nexus-find-active";

export interface WebFindHighlightRanges {
  readonly all: readonly Range[];
  readonly active: readonly Range[];
}

export interface WebFindHighlightOwner {
  publish(ranges: WebFindHighlightRanges): void;
  clear(): void;
}

const ownerRanges = new Map<symbol, WebFindHighlightRanges>();

function requireCustomHighlightRegistry(): HighlightRegistry {
  if (
    typeof CSS === "undefined" ||
    typeof Highlight === "undefined" ||
    !CSS.highlights
  ) {
    throw new Error("Web Find requires the CSS Custom Highlight API.");
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
  publishFixedHighlight(registry, WEB_FIND_ALL_HIGHLIGHT_NAME, all);
  publishFixedHighlight(registry, WEB_FIND_ACTIVE_HIGHLIGHT_NAME, active);
}

export function createWebFindHighlightOwner(): WebFindHighlightOwner {
  const ownerId = Symbol("WebFindHighlightOwner");
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
