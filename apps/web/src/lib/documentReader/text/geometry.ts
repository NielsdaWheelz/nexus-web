// Text geometry over the mounted units: canonical cursors per unit (built
// lazily, the eight most recent kept), caret hit-testing, viewport capture
// and positioning. A unit whose rendered text differs from its canonical text
// has no cursor: it is not selectable or paintable, so a range in it is no
// place to go, and points in it fall back to its start rather than a wrong
// offset.
import {
  buildDomTextCursor,
  type DomTextCursor,
} from "@/lib/highlights/domTextCursor";
import {
  resolveDomRangeOffsets,
  resolveDomTextRanges,
} from "@/lib/highlights/domTextRanges";
import type {
  Placement,
  ReaderTarget,
  TextDocument,
  TextPoint,
  Viewport,
} from "../model";

interface Entry {
  readonly cursor: DomTextCursor;
  readonly nodes: ReadonlyMap<Text, { start: number; end: number }>;
}
export interface TextCapture {
  readonly viewport: Omit<Viewport, "identity" | "intent">;
  readonly placement: Omit<Placement, "identity">;
}
export interface TextGeometry {
  cursor(unit: string): DomTextCursor | null;
  /** The unit's dom changed (paint, hydration): drop its cursor. */
  invalidate(unit: string): void;
  capture(): TextCapture | null;
  /** One synchronous attempt; arrived() verifies it after layout. */
  scrollTo(to: ReaderTarget | Placement): boolean;
  arrived(to: ReaderTarget | Placement): boolean;
  ranges(unit: string, start: number, end: number): Range[];
  selection(selection: Selection): {
    readonly anchor: { kind: "text"; unit: string; start: number; end: number };
    readonly quote: string;
    readonly rect: DOMRect;
  } | null;
  /** An element id, looked up only inside its unit (ids repeat across spine documents). */
  anchor(unit: string, id: string): HTMLElement | null;
}

const CACHE = 8;
const TOLERANCE_PX = 2;

export function createTextGeometry(
  scrollport: HTMLElement,
  column: HTMLElement,
  doc: TextDocument,
): TextGeometry {
  const units = new Map(doc.units.map((unit) => [unit.id, unit]));
  const cache = new Map<string, Entry | null>();
  const section = (unit: string) =>
    column.querySelector<HTMLElement>(
      `[data-reader-unit="${CSS.escape(unit)}"]`,
    );

  function entry(unit: string): Entry | null {
    if (cache.has(unit)) {
      const hit = cache.get(unit)!;
      cache.delete(unit);
      cache.set(unit, hit);
      return hit;
    }
    const root = section(unit)?.querySelector("[data-reader-text]");
    const expected = units.get(unit)?.text;
    if (!root || expected === undefined) return null;
    const cursor = buildDomTextCursor(root, (el) =>
      el.hasAttribute("data-document-embed-ui"),
    );
    const built =
      cursor.emitted === expected
        ? { cursor, nodes: new Map(cursor.nodes.map((n) => [n.node, n])) }
        : null;
    cache.set(unit, built);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value!);
    return built;
  }

  /** The canonical offset of a caret in a unit's text node, or null outside it. */
  function offsetOf(found: Entry, node: Text, utf16: number): number | null {
    const range = found.nodes.get(node);
    if (!range) return null;
    for (let i = range.start; i < range.end; i += 1) {
      const span = found.cursor.provenance[i].spans.find(
        (s) => s.node === node,
      );
      if (span && span.endUtf16 > utf16) return i;
    }
    return range.end;
  }

  /** Two spellings of one api: the standard one, then Blink/WebKit's older one. */
  function caretAt(
    x: number,
    y: number,
  ): { node: Node; offset: number } | null {
    const owner = scrollport.ownerDocument;
    if (typeof owner.caretPositionFromPoint === "function") {
      const position = owner.caretPositionFromPoint(x, y);
      return position && { node: position.offsetNode, offset: position.offset };
    }
    const range = owner.caretRangeFromPoint(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }

  function pointAt(x: number, y: number): TextPoint | null {
    const caret = caretAt(x, y);
    if (!caret || !(caret.node instanceof Text)) return null;
    const unit =
      caret.node.parentElement?.closest<HTMLElement>("[data-reader-unit]");
    const id = unit?.dataset.readerUnit;
    if (!id || !caret.node.parentElement?.closest("[data-reader-text]"))
      return null;
    const found = entry(id);
    if (!found) return { unit: id, offset: 0 };
    const offset = offsetOf(found, caret.node, caret.offset);
    return offset === null ? null : { unit: id, offset };
  }

  /** The rectangle of the authored character at a point, else the nearest one before it. */
  function rectAt(point: TextPoint): DOMRect | null {
    const found = entry(point.unit);
    const rectOf = (i: number) => {
      const span = found!.cursor.provenance[i].spans[0];
      if (!span) return null;
      const range = span.node.ownerDocument.createRange();
      range.setStart(span.node, span.startUtf16);
      range.setEnd(span.node, span.endUtf16);
      return (
        [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0) ??
        null
      );
    };
    if (found) {
      const { length } = found.cursor;
      for (let i = point.offset; i < length; i += 1) {
        const rect = rectOf(i);
        if (rect) return rect;
      }
      for (let i = Math.min(point.offset, length) - 1; i >= 0; i -= 1) {
        const rect = rectOf(i);
        if (rect) return rect;
      }
    }
    return section(point.unit)?.getBoundingClientRect() ?? null;
  }

  const readingLine = () =>
    scrollport.getBoundingClientRect().top +
    (Number.parseFloat(getComputedStyle(scrollport).scrollPaddingTop) || 0);

  /** The document fraction at a y, proportionally inside the unit under it. */
  function fractionAt(x: number, y: number): number | null {
    const hit = scrollport.ownerDocument
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-reader-unit]");
    const unit = hit && units.get(hit.dataset.readerUnit!);
    if (!hit || !unit || doc.length === 0) return null;
    const rect = hit.getBoundingClientRect();
    const within = Math.min(
      1,
      Math.max(0, (y - rect.top) / Math.max(1, rect.height)),
    );
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
    const view = scrollport.getBoundingClientRect();
    if ("topPx" in to) {
      const rect = to.point.kind === "text" ? rectAt(to.point) : null;
      return rect && { top: rect.top, want: view.top + to.topPx };
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
    return (
      section(unit)?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) ??
      null
    );
  }

  return {
    cursor: (unit) => entry(unit)?.cursor ?? null,
    invalidate: (unit) => void cache.delete(unit),
    capture() {
      const view = scrollport.getBoundingClientRect();
      const first = column
        .querySelector("[data-reader-unit]")
        ?.getBoundingClientRect();
      if (view.height <= 0 || !first) return null;
      // The text column's inline start: the caret there is the line's first character.
      const x = first.left + 2;
      const line = readingLine();
      let primary: TextPoint | null = null;
      for (
        let y = line + 1;
        !primary && y < Math.min(view.bottom, line + 160);
        y += 8
      ) {
        primary = pointAt(x, y);
      }
      // No text at the reading line (an image, an empty unit): the unit's start.
      if (!primary) {
        const hit = scrollport.ownerDocument
          .elementFromPoint(x, line + 1)
          ?.closest<HTMLElement>("[data-reader-unit]");
        const id =
          hit?.dataset.readerUnit ??
          (scrollport.scrollTop <= 0 ? doc.units[0].id : null);
        if (!id) return null;
        primary = { unit: id, offset: 0 };
      }
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
          start: fractionAt(x, view.top + 1) ?? here,
          end: atEnd ? 1 : (fractionAt(x, view.bottom - 1) ?? here),
          atEnd,
        },
        placement: {
          point,
          topPx: (rect ? rect.top : line) - view.top,
          zoom: null,
        },
      };
    },
    scrollTo(to) {
      if (!("topPx" in to) && to.kind === "edge") {
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
      if (!("topPx" in to) && to.kind === "edge") {
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
      if (!id || owner(range.endContainer) !== unit) return null;
      const found = entry(id);
      const offsets = found && resolveDomRangeOffsets(found.cursor, range);
      if (!offsets || offsets.endOffset <= offsets.startOffset) return null;
      const quote = Array.from(units.get(id)!.text)
        .slice(offsets.startOffset, offsets.endOffset)
        .join("");
      return {
        anchor: {
          kind: "text",
          unit: id,
          start: offsets.startOffset,
          end: offsets.endOffset,
        },
        quote,
        rect: range.getBoundingClientRect(),
      };
    },
    anchor,
  };
}
