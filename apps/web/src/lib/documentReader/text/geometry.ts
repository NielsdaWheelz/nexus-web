// Text geometry over the mounted units: canonical cursors per unit (built
// lazily, the eight most recent kept), viewport capture and positioning.
// Positioning realizes its destination unit before measuring: skipped content
// can retain descendant rectangles that no longer belong to its unit's layout.
// Capture measures boxes, never hit-tests, so a sheet or menu over the text
// cannot hide the reading position. A unit whose rendered text differs from its canonical text
// has no cursor: it is not selectable or paintable, so a range in it is no
// place to go, and points in it fall back to its start rather than a wrong
// offset.
import {
  buildDomTextCursor,
  isCanonicalTextSkipped,
  type DomTextCursor,
} from "@/lib/canonicalText/domTextCursor";
import {
  resolveDomRangeOffsets,
  resolveDomTextRanges,
} from "@/lib/canonicalText/domTextRanges";
import type { PassageGeometry, TextRange } from "../DocumentReader";
import { measureScrollport } from "../scrollport";
import type {
  Placement,
  ReaderTarget,
  TextDocument,
  TextPoint,
  Viewport,
} from "../model";

interface Entry {
  readonly cursor: DomTextCursor;
}
export interface TextCapture {
  readonly viewport: Omit<Viewport, "identity" | "intent">;
  readonly placement: Omit<Placement, "identity">;
}
export interface TextGeometry {
  /** The unit's rendered text root. */
  text(unit: string): Element | null;
  capture(): TextCapture | null;
  /** Keep one destination laid out; a new position releases the previous one. */
  realize(to: ReaderTarget | Placement): () => void;
  /** One synchronous attempt; arrived() verifies it after layout. */
  scrollTo(to: ReaderTarget | Placement): boolean;
  arrived(to: ReaderTarget | Placement): boolean;
  ranges(unit: string, start: number, end: number): StaticRange[];
  measurePassage(anchor: TextRange): PassageGeometry | null;
  selection(selection: Selection): {
    readonly kind: "Captured";
    readonly anchor: { kind: "text"; unit: string; start: number; end: number };
    readonly quote: string;
  } | { readonly kind: "Rejected"; readonly reason: "CrossUnit" } | null;
  /** A unique canonical id/name alias, scoped to its published source unit. */
  anchor(unit: string, id: string): HTMLElement | null;
}

const CACHE = 8;
const TOLERANCE_PX = 2;

export function createTextGeometry(
  scrollport: HTMLElement,
  column: HTMLElement,
  doc: Pick<TextDocument, "units" | "length">,
): TextGeometry {
  const units = new Map(doc.units.map((unit) => [unit.id, unit]));
  const cache = new Map<string, Entry | null>();
  let releaseRealized: (() => void) | null = null;
  // One live range, reused for measuring: each live range taxes every dom mutation.
  const probe = scrollport.ownerDocument.createRange();
  const section = (unit: string) =>
    column.querySelector<HTMLElement>(
      `[data-reader-unit="${CSS.escape(unit)}"]`,
    );
  const text = (unit: string) =>
    section(unit)?.querySelector("[data-reader-text]") ?? null;

  function entry(unit: string): Entry | null {
    if (cache.has(unit)) {
      const hit = cache.get(unit)!;
      cache.delete(unit);
      cache.set(unit, hit);
      return hit;
    }
    const root = text(unit);
    const expected = units.get(unit)?.text;
    if (!root || expected === undefined) return null;
    const cursor = buildDomTextCursor(root, (el) =>
      el.hasAttribute("data-document-embed-ui"),
    );
    const built = cursor.emitted === expected ? { cursor } : null;
    cache.set(unit, built);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value!);
    return built;
  }

  /**
   * The rectangle of the authored character at a point, else the nearest
   * rendered one after it (before: before it), else on the other side.
   */
  function rectAt(point: TextPoint, before = false): DOMRect | null {
    const found = entry(point.unit);
    const rectOf = (i: number) => {
      const span = found!.cursor.provenance[i].spans[0];
      if (!span) return null;
      probe.setStart(span.node, span.startUtf16);
      probe.setEnd(span.node, span.endUtf16);
      return (
        [...probe.getClientRects()].find((r) => r.width > 0 || r.height > 0) ??
        null
      );
    };
    if (found) {
      const { length } = found.cursor;
      const after = (from: number) => {
        for (let i = from; i < length; i += 1) {
          const rect = rectOf(i);
          if (rect) return rect;
        }
        return null;
      };
      const behind = (from: number) => {
        for (let i = Math.min(from, length - 1); i >= 0; i -= 1) {
          const rect = rectOf(i);
          if (rect) return rect;
        }
        return null;
      };
      const rect = before
        ? (behind(point.offset) ?? after(point.offset))
        : (after(point.offset) ?? behind(point.offset - 1));
      if (rect) return rect;
    }
    return section(point.unit)?.getBoundingClientRect() ?? null;
  }

  const readingLine = () =>
    scrollport.getBoundingClientRect().top +
    (Number.parseFloat(getComputedStyle(scrollport).scrollPaddingTop) || 0);

  /** The first unit whose box reaches below y (units stack in order). */
  function unitBelow(y: number): (typeof doc.units)[number] | null {
    let [lo, hi] = [0, doc.units.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const box = section(doc.units[mid].id)?.getBoundingClientRect();
      if (box && box.bottom > y) hi = mid;
      else lo = mid + 1;
    }
    return doc.units[lo] ?? null;
  }

  /** The document fraction at a y, proportionally inside the unit there. */
  function fractionAt(y: number): number | null {
    const unit = unitBelow(y);
    const box = unit && section(unit.id)?.getBoundingClientRect();
    if (!unit || !box || doc.length === 0) return null;
    const within = Math.min(1, Math.max(0, (y - box.top) / Math.max(1, box.height)));
    return (unit.start + unit.length * within) / doc.length;
  }

  function targetPoint(to: ReaderTarget): TextPoint | null {
    if (to.kind === "point") return to.point.kind === "text" ? to.point : null;
    if (to.kind === "range") return { unit: to.unit, offset: to.start };
    if (to.kind === "time") {
      const unit =
        doc.units.findLast((u) => u.time !== null && u.time.startMs <= to.ms) ??
        doc.units[0];
      return unit ? { unit: unit.id, offset: 0 } : null;
    }
    return null;
  }

  /** The current top of a target, and where it belongs. */
  function aim(
    to: ReaderTarget | Placement,
  ): { top: number; want: number } | null {
    if ("offsetPx" in to) {
      const rect = to.point.kind === "text" ? rectAt(to.point) : null;
      return rect && { top: rect.top, want: readingLine() + to.offsetPx };
    }
    if (to.kind === "anchor") {
      const element = anchor(to.unit, to.id);
      return (
        element && {
          top: element.getBoundingClientRect().top,
          want: readingLine(),
        }
      );
    }
    if (to.kind === "range" && !entry(to.unit)) return null;
    const point = targetPoint(to);
    const rect = point && units.has(point.unit) ? rectAt(point) : null;
    return rect && { top: rect.top, want: readingLine() };
  }

  function anchor(unit: string, id: string): HTMLElement | null {
    const root = text(unit);
    if (!root || !id) return null;
    const escaped = CSS.escape(id);
    const matches = Array.from(
      root.querySelectorAll<HTMLElement>(`[id="${escaped}"], [name="${escaped}"]`),
    ).filter((element) => {
      for (
        let current: Element | null = element;
        current && current !== root.parentElement;
        current = current.parentElement
      ) {
        if (isCanonicalTextSkipped(current) || current.hasAttribute("data-document-embed-ui")) return false;
      }
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  return {
    text,
    realize(to) {
      releaseRealized?.();
      let unit: string | undefined;
      if ("offsetPx" in to) {
        if (to.point.kind === "text") unit = to.point.unit;
      } else if (to.kind === "anchor") unit = to.unit;
      else if (to.kind === "edge") {
        unit = (to.edge === "start" ? doc.units[0] : doc.units.at(-1))?.id;
      } else unit = targetPoint(to)?.unit;
      const element = unit ? section(unit) : null;
      if (!element) return () => {};
      const previous = element.style.contentVisibility;
      element.style.contentVisibility = "visible";
      const release = () => {
        if (releaseRealized !== release) return;
        releaseRealized = null;
        element.style.contentVisibility = previous;
      };
      releaseRealized = release;
      return release;
    },
    capture() {
      const view = scrollport.getBoundingClientRect();
      const line = readingLine();
      const at = unitBelow(line);
      if (view.height <= 0 || !at) return null;
      // The first character whose line reaches below the reading line (the
      // unit's end past its text); a unit without a cursor reads from its start.
      // An unrendered offset (a block separator) belongs to the line before it.
      let [lo, hi] = [0, entry(at.id)?.cursor.length ?? 0];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const box = rectAt({ unit: at.id, offset: mid }, true);
        if (box && box.bottom > line) hi = mid;
        else lo = mid + 1;
      }
      const primary: TextPoint = { unit: at.id, offset: lo };
      const rect = rectAt(primary);
      const atEnd =
        scrollport.scrollHeight -
          scrollport.clientHeight -
          scrollport.scrollTop <=
        TOLERANCE_PX;
      const unit = units.get(primary.unit)!;
      const here =
        doc.length > 0 ? (unit.start + primary.offset) / doc.length : 0;
      const point = { kind: "text" as const, ...primary };
      return {
        viewport: {
          primary: point,
          start: fractionAt(view.top + 1) ?? here,
          end: atEnd ? 1 : (fractionAt(view.bottom - 1) ?? here),
          atEnd,
        },
        placement: {
          point,
          offsetPx: (rect ? rect.top : line) - line,
          zoom: null,
        },
      };
    },
    scrollTo(to) {
      if (!("offsetPx" in to) && to.kind === "edge") {
        scrollport.scrollTop =
          to.edge === "start" ? 0 : scrollport.scrollHeight;
        return true;
      }
      const target = aim(to);
      if (!target) return false;
      scrollport.scrollTop += target.top - target.want;
      return true;
    },
    arrived(to) {
      const max = scrollport.scrollHeight - scrollport.clientHeight;
      if (!("offsetPx" in to) && to.kind === "edge") {
        return to.edge === "start"
          ? scrollport.scrollTop <= 0
          : scrollport.scrollTop >= max - 1;
      }
      const target = aim(to);
      if (!target) return false;
      const clamped =
        (target.top > target.want && scrollport.scrollTop >= max - 1) ||
        (target.top < target.want && scrollport.scrollTop <= 0);
      return clamped || Math.abs(target.top - target.want) <= TOLERANCE_PX;
    },
    ranges(unit, start, end) {
      const found = entry(unit);
      return (found && resolveDomTextRanges(found.cursor, start, end)) ?? [];
    },
    measurePassage({ unit, start, end }) {
      const bounds = measureScrollport(scrollport);
      if (!bounds || !column.isConnected) return null;
      const found = entry(unit);
      if (!found) return null;
      const ranges = resolveDomTextRanges(found.cursor, start, end);
      if (!ranges) return null;
      const lines = ranges.flatMap((range) => {
        probe.setStart(range.startContainer, range.startOffset);
        probe.setEnd(range.endContainer, range.endOffset);
        return [...probe.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      });
      if (!lines.length) return null;
      const left = Math.min(...lines.map((rect) => rect.left));
      const top = Math.min(...lines.map((rect) => rect.top));
      const right = Math.max(...lines.map((rect) => rect.right));
      const bottom = Math.max(...lines.map((rect) => rect.bottom));
      return {
        rect: new DOMRect(left, top, right - left, bottom - top),
        lines,
        bounds,
      };
    },
    selection(selection) {
      if (selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const owner = (node: Node) =>
        (node instanceof Element
          ? node
          : node.parentElement
        )?.closest<HTMLElement>("[data-reader-unit]");
      const unit = owner(range.startContainer);
      const id = unit?.dataset.readerUnit;
      const end = owner(range.endContainer);
      if (!unit || !id || !end || !column.contains(unit) || !column.contains(end)) return null;
      if (end !== unit) return { kind: "Rejected", reason: "CrossUnit" };
      const found = entry(id);
      const offsets = found && resolveDomRangeOffsets(found.cursor, range);
      if (!offsets || offsets.endOffset <= offsets.startOffset) return null;
      const quote = Array.from(units.get(id)!.text)
        .slice(offsets.startOffset, offsets.endOffset)
        .join("");
      return {
        kind: "Captured",
        anchor: {
          kind: "text",
          unit: id,
          start: offsets.startOffset,
          end: offsets.endOffset,
        },
        quote,
      };
    },
    anchor,
  };
}
