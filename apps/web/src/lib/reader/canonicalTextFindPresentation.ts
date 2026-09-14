import { resolveCanonicalTextRanges } from "@/app/(authenticated)/media/[id]/paneTextAnchor";
import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { PaneFindResultKey } from "@/lib/panes/paneSearch";
import type { PaneFindAdapter } from "@/lib/panes/usePaneFind";
import { createPaneFindHighlightOwner } from "./paneFindHighlightRegistry";

export interface CanonicalTextFindAdapter<TError>
  extends PaneFindAdapter<TError> {
  rebuildPresentation(): void;
}

export interface CanonicalTextFindPresentationTarget {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

export interface CanonicalTextFindPresentationInput {
  readonly fragmentId: string;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
  readonly targets: readonly CanonicalTextFindPresentationTarget[];
  readonly activeKey: PaneFindResultKey | null;
}

export interface CanonicalTextFindPresentationOwner {
  publish(input: CanonicalTextFindPresentationInput): void;
  clear(): void;
}

function resolveVisibleTarget(
  input: CanonicalTextFindPresentationInput,
  target: CanonicalTextFindPresentationTarget,
): Range[] {
  const ranges = resolveCanonicalTextRanges(
    input.cursor,
    target.startCp,
    target.endCp,
  );
  if (!ranges) {
    throw new Error("Canonical Find target is not exactly renderable.");
  }
  for (const range of ranges) {
    if (
      range.collapsed ||
      !input.viewport.contains(range.startContainer) ||
      !input.viewport.contains(range.endContainer)
    ) {
      throw new Error(
        "Canonical Find target resolved outside the current viewport.",
      );
    }
  }
  return ranges;
}

export function createCanonicalTextFindPresentationOwner(): CanonicalTextFindPresentationOwner {
  const registry = createPaneFindHighlightOwner();
  return {
    publish(input) {
      const all: Range[] = [];
      let active: readonly Range[] = [];
      for (const target of input.targets) {
        if (target.fragmentId !== input.fragmentId) {
          continue;
        }
        const ranges = resolveVisibleTarget(input, target);
        all.push(...ranges);
        if (target.key === input.activeKey) {
          active = ranges;
        }
      }
      registry.publish({ all, active });
    },
    clear() {
      registry.clear();
    },
  };
}
