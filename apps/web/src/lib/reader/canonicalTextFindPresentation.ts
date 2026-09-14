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

export interface CanonicalTextFindWindowInput {
  readonly parts: readonly {
    readonly fragmentId: string;
    readonly startCp: number;
    readonly endCp: number;
    readonly renderStartCp: number;
    readonly cursor: CanonicalCursorResult;
  }[];
  readonly viewport: HTMLElement;
  readonly targets: readonly CanonicalTextFindPresentationTarget[];
  readonly activeKey: PaneFindResultKey | null;
}

export interface CanonicalTextFindPresentationOwner {
  publish(input: CanonicalTextFindPresentationInput): void;
  publishWindow(input: CanonicalTextFindWindowInput): { readonly activeComplete: boolean };
  clear(): void;
}

function resolveVisibleTarget(
  input: Pick<CanonicalTextFindPresentationInput, "cursor" | "viewport">,
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
    publishWindow(input) {
      const all: Range[] = [];
      const active: Range[] = [];
      const activeTarget = input.targets.find((target) => target.key === input.activeKey);
      let covered = activeTarget?.startCp ?? 0;
      for (const part of input.parts) {
        if (activeTarget?.fragmentId === part.fragmentId && part.startCp <= covered) {
          covered = Math.max(covered, Math.min(part.endCp, activeTarget.endCp));
        }
        for (const target of input.targets) {
          if (target.fragmentId !== part.fragmentId) continue;
          const start = Math.max(target.startCp, part.renderStartCp);
          const end = Math.min(target.endCp, part.renderStartCp + part.cursor.length);
          if (end <= start) continue;
          const ranges = resolveVisibleTarget({ cursor: part.cursor, viewport: input.viewport }, {
            ...target, startCp: start - part.renderStartCp, endCp: end - part.renderStartCp,
          });
          all.push(...ranges);
          if (target.key === input.activeKey) active.push(...ranges);
        }
      }
      registry.publish({ all, active });
      return { activeComplete: activeTarget !== undefined && covered === activeTarget.endCp };
    },
    clear() {
      registry.clear();
    },
  };
}
