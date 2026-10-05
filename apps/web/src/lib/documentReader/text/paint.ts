// Paint with css custom highlights: the document dom is never rewritten.
// Each unit within one viewport of the visible band registers StaticRanges in
// shared highlight names. Marks (topmost first) split into disjoint segments;
// a segment paints in its topmost mark's colour and keeps every covering id,
// topmost first, for hit-testing. A unit repaints when the decorations change,
// when its dom (re)mounts and when it enters or leaves the window; layout
// changes need nothing (static ranges follow the text through every reflow).
import type { Schema } from "@/lib/api/wire";
import type { Decorations } from "../DocumentReader";
import type { TextPoint } from "../model";
import type { TextGeometry } from "./geometry";

type Piece = { start: number; end: number; ids: readonly string[] };
type FocusMode = Schema<"ReaderProfileOut">["focus_mode"];

// Strict order; colour-setting highlights sit above background-only ones (webkit).
const PRIORITY: Record<string, number> = {
  "hl-hover": -3,
  "hl-focus": -2,
  "hl-evidence": -2,
  "reader-pulse": -2,
  "reader-focus": -1,
};
const shares = new Map<string, Map<string, readonly StaticRange[]>>();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const BLOCK = "p,li,dd,dt,pre,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6";
let instances = 0;

/** One owner's ranges in a highlight name; every reader instance shares the names. */
function share(owner: string, name: string, ranges: readonly StaticRange[]) {
  const owners = shares.get(name) ?? new Map<string, readonly StaticRange[]>();
  shares.set(name, owners);
  if (ranges.length) owners.set(owner, ranges);
  else if (!owners.delete(owner)) return;
  const all = [...owners.values()].flat();
  if (!all.length) return void CSS.highlights.delete(name);
  const highlight = new Highlight(...all);
  highlight.priority = PRIORITY[name] ?? -4;
  const added = !CSS.highlights.has(name);
  CSS.highlights.set(name, highlight);
  // WebKit (26) crashes painting a highlight registered after one of higher
  // priority: a new name re-sorts the registry, foreign names (find) included.
  if (added) {
    const ordered = [...CSS.highlights]
      .map(([key, value]) => [key, value.priority, [...value]] as const)
      .sort((a, b) => a[1] - b[1]);
    CSS.highlights.clear();
    // Fresh objects: WebKit empties a Highlight that leaves the registry.
    for (const [key, priority, ranges] of ordered)
      CSS.highlights.set(key, Object.assign(new Highlight(...ranges), { priority }));
  }
}

function span(from: [Node, number], to: [Node, number]) {
  const [startContainer, startOffset] = from;
  const [endContainer, endOffset] = to;
  return new StaticRange({
    startContainer,
    startOffset,
    endContainer,
    endOffset,
  });
}

/** The dom position `utf16` code units into an element's text. */
function textPosition(root: Element, utf16: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    if (utf16 <= length) return [node, utf16];
    utf16 -= length;
  }
  return [root, root.childNodes.length];
}

export interface Painter {
  paint(decorations: Decorations | undefined): void;
  focus(mode: FocusMode, at: TextPoint | null, suspended: boolean): void;
  /** The marks under a client point, topmost first. */
  hit(x: number, y: number): readonly string[];
  /** Units within the paint window; `onNear` hears it change. */
  readonly near: ReadonlySet<string>;
  onNear(listener: () => void): void;
  dispose(): void;
}

export function createPainter(
  scrollport: HTMLElement,
  geometry: TextGeometry,
  identity: string,
): Painter {
  const id = `reader${(instances += 1)}`;
  const near = new Set<string>();
  const painted = new Map<string, readonly string[]>();
  const index = new Map<string, Map<Node, Piece[]>>();
  let decorations: Decorations | null = null;
  let focus = { mode: "off" as FocusMode, at: null as TextPoint | null };
  let suspended = false;
  let pulseTimer = 0;
  let notify = () => {};
  const probe = new Range(); // reused: each live range taxes every dom mutation
  const pieces = (unit: string, start: number, end: number) =>
    geometry.ranges(unit, start, end);

  function paintUnit(unit: string) {
    const names = new Map<string, StaticRange[]>();
    const add = (name: string, ranges: StaticRange[]) =>
      names.set(name, [...(names.get(name) ?? []), ...ranges]);
    const nodes = new Map<Node, Piece[]>();
    const marks = near.has(unit)
      ? (decorations?.marks ?? []).flatMap((mark) =>
          mark.anchor.kind === "text" && mark.anchor.unit === unit
            ? [{ ...mark.anchor, id: mark.id, color: mark.color }]
            : [],
        )
      : [];
    const bounds = [...new Set(marks.flatMap((m) => [m.start, m.end]))].sort(
      (a, b) => a - b,
    );
    // A sweep over the boundaries; `active` holds mark indexes, topmost first.
    const byStart = marks
      .map((_, i) => i)
      .sort((a, b) => marks[a].start - marks[b].start);
    let active: number[] = [];
    let next = 0;
    for (const [i, start] of bounds.slice(0, -1).entries()) {
      active = active.filter((m) => marks[m].end > start);
      while (next < byStart.length && marks[byStart[next]].start <= start)
        active.push(byStart[next++]);
      if (!active.length) continue;
      active.sort((a, b) => a - b);
      const end = bounds[i + 1];
      const over = active.map((m) => marks[m]);
      const ids = over.map((m) => m.id);
      const ranges = pieces(unit, start, end);
      add(`hl-${over[0].color}`, ranges);
      if (ids.includes(decorations?.hovered ?? "")) add("hl-hover", ranges);
      if (ids.includes(decorations?.focused ?? "")) add("hl-focus", ranges);
      for (const r of ranges) {
        const list = nodes.get(r.startContainer) ?? [];
        nodes.set(r.startContainer, list);
        list.push({ start: r.startOffset, end: r.endOffset, ids });
      }
    }
    const evidence = decorations?.evidence;
    if (near.has(unit) && evidence?.unit === unit)
      add("hl-evidence", pieces(unit, evidence.start, evidence.end));
    for (const ref of near.has(unit) ? (decorations?.noteRefs ?? []) : []) {
      if (ref.unit !== unit) continue;
      const [range] = geometry.ranges(unit, ref.start, ref.end);
      const link = range?.startContainer.parentElement?.closest("a");
      link?.setAttribute("data-reader-apparatus-item-id", ref.key);
    }
    index.set(unit, nodes);
    for (const name of new Set([...(painted.get(unit) ?? []), ...names.keys()]))
      share(`${id}:${unit}`, name, names.get(name) ?? []);
    painted.set(unit, [...names.keys()]);
    paintFocus(unit);
  }

  /** Focus mode dims everything near but the paragraph (or sentence) at the reading line. */
  function paintFocus(unit: string) {
    const text = geometry.text(unit);
    const { mode, at } = focus;
    const on = (mode === "paragraph" || mode === "sentence") && !suspended;
    let dim: StaticRange[] = [];
    if (text && near.has(unit) && on) {
      const whole = span([text, 0], [text, text.childNodes.length]);
      const [caret] =
        at?.unit === unit
          ? geometry.ranges(unit, at.offset, at.offset + 1)
          : [];
      const block = caret?.startContainer.parentElement?.closest(BLOCK);
      dim = [whole];
      if (caret && block && text.contains(block)) {
        let from: [Node, number] = [block, 0];
        let to: [Node, number] = [block, block.childNodes.length];
        if (mode === "sentence") {
          const before = new Range();
          before.setStart(block, 0);
          before.setEnd(caret.startContainer, caret.startOffset);
          const position = before.toString().length;
          const sentences = new Intl.Segmenter(undefined, {
            granularity: "sentence",
          }).segment(block.textContent ?? "");
          const sentence = sentences.containing(position);
          if (sentence) {
            from = textPosition(block, sentence.index);
            to = textPosition(block, sentence.index + sentence.segment.length);
          }
        }
        dim = [span([text, 0], from), span(to, [text, text.childNodes.length])];
      }
    }
    share(`${id}:${unit}:focus`, "reader-focus", dim);
  }

  /** The grapheme under a point: at the caret, beside it, or (bidi) anywhere under it. */
  function charAt(x: number, y: number): { node: Node; at: number } | null {
    const owner = scrollport.ownerDocument;
    const shadow = scrollport.getRootNode();
    const shadowRoots = shadow instanceof ShadowRoot ? [shadow] : [];
    const caret: { node: Node; offset: number } | null =
      typeof owner.caretPositionFromPoint === "function"
        ? ((p) => p && { node: p.offsetNode, offset: p.offset })(
            owner.caretPositionFromPoint(x, y, { shadowRoots }),
          )
        : ((r) => r && { node: r.startContainer, offset: r.startOffset })(
            owner.caretRangeFromPoint(x, y),
          );
    const scan = (node: Node | null, from = 0, to = Infinity) => {
      if (!(node instanceof Text)) return null;
      for (const g of graphemes.segment(node.data)) {
        if (g.index + g.segment.length <= from || g.index > to) continue;
        probe.setStart(node, g.index);
        probe.setEnd(node, g.index + g.segment.length);
        for (const r of probe.getClientRects())
          if (x >= r.left && x < r.right && y >= r.top && y < r.bottom)
            return { node, at: g.index };
      }
      return null;
    };
    const walker = owner.createTreeWalker(scrollport, NodeFilter.SHOW_TEXT);
    const beside = (step: "previousNode" | "nextNode") => {
      walker.currentNode = caret!.node;
      return walker[step]();
    };
    const element = (
      shadow instanceof ShadowRoot ? shadow : owner
    ).elementFromPoint(x, y);
    const { node, offset } = caret ?? { node: null, offset: 0 };
    return (
      (node instanceof Text
        ? (scan(node, offset - 1, offset) ??
          (offset === 0 ? scan(beside("previousNode")) : null) ??
          (offset === node.length ? scan(beside("nextNode")) : null) ??
          scan(node))
        : null) ??
      [...(element?.childNodes ?? [])].reduce<ReturnType<typeof scan>>(
        (hit, child) => hit ?? scan(child),
        null,
      )
    );
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const unit = (entry.target as HTMLElement).dataset.readerUnit!;
        if (entry.isIntersecting) near.add(unit);
        else near.delete(unit);
        paintUnit(unit);
      }
      notify();
    },
    { root: scrollport, rootMargin: "100% 0px" },
  );
  for (const unit of scrollport.querySelectorAll("[data-reader-unit]"))
    observer.observe(unit);

  return {
    near,
    onNear: (listener) => void (notify = listener),
    paint(next) {
      const current = next?.identity === identity ? next : null;
      const pulse = current?.pulse;
      if (pulse && pulse !== decorations?.pulse) {
        window.clearTimeout(pulseTimer);
        const ranges = pieces(pulse.unit, pulse.start, pulse.end);
        share(`${id}:pulse`, "reader-pulse", ranges);
        pulseTimer = window.setTimeout(
          () => share(`${id}:pulse`, "reader-pulse", []),
          1_200,
        );
      }
      decorations = current;
      for (const unit of new Set([...painted.keys(), ...near])) paintUnit(unit);
    },
    focus(mode, at, off) {
      const moved =
        focus.mode !== mode ||
        suspended !== off ||
        focus.at?.unit !== at?.unit ||
        focus.at?.offset !== at?.offset;
      focus = { mode, at };
      suspended = off;
      if (moved) for (const unit of near) paintFocus(unit);
    },
    hit(x, y) {
      const char = charAt(x, y);
      const unit =
        char?.node.parentElement?.closest<HTMLElement>("[data-reader-unit]")
          ?.dataset.readerUnit ?? "";
      const list = (char && index.get(unit)?.get(char.node)) || [];
      const piece = list.find((p) => p.start <= char!.at && char!.at < p.end);
      return piece?.ids ?? [];
    },
    dispose() {
      observer.disconnect();
      window.clearTimeout(pulseTimer);
      decorations = null;
      near.clear();
      share(`${id}:pulse`, "reader-pulse", []);
      for (const unit of painted.keys()) paintUnit(unit);
    },
  };
}
