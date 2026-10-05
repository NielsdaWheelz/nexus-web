// Decoration paint for text: each mark's canonical range is wrapped in
// <mark data-reader-mark> elements (overlaps nest), note references stamp
// their link. A unit is repainted only when its marks change. The mechanism
// stays behind Decorations; the css-highlight probe decides pr2's.
import type { Decorations } from "../DocumentReader";
import type { TextGeometry } from "./geometry";
import styles from "../documentReader.module.css";

const MARK = "data-reader-mark";
const NOTE = "data-reader-apparatus-item-id";

export interface Painter {
  paint(decorations: Decorations | undefined): void;
  /** The ids of the marks under an event target, innermost first. */
  hit(target: EventTarget | null): string[];
}

export function createPainter(
  column: HTMLElement,
  geometry: TextGeometry,
  identity: string,
): Painter {
  const painted = new Map<string, string>();
  let focused: string | null = null;
  const textOf = (unit: string) =>
    column.querySelector(
      `[data-reader-unit="${CSS.escape(unit)}"] [data-reader-text]`,
    );

  return {
    paint(decorations) {
      const current = decorations?.identity === identity ? decorations : null;
      const byUnit = new Map<string, Decorations["marks"][number][]>();
      for (const mark of current?.marks ?? []) {
        if (mark.anchor.kind !== "text") continue;
        byUnit.set(mark.anchor.unit, [
          ...(byUnit.get(mark.anchor.unit) ?? []),
          mark,
        ]);
      }
      for (const unit of new Set([...painted.keys(), ...byUnit.keys()])) {
        const marks = byUnit.get(unit) ?? [];
        const signature = JSON.stringify(marks);
        const root = textOf(unit);
        if (!root || painted.get(unit) === signature) continue;
        for (const old of root.querySelectorAll(`mark[${MARK}]`))
          old.replaceWith(...old.childNodes);
        root.normalize();
        geometry.invalidate(unit);
        for (const mark of marks) {
          if (mark.anchor.kind !== "text") continue;
          // Last first: wrapping splits text nodes after the earlier ranges.
          for (const range of geometry
            .ranges(unit, mark.anchor.start, mark.anchor.end)
            .reverse()) {
            const element = document.createElement("mark");
            element.className = `${styles.mark} hl-${mark.color}`;
            element.setAttribute(MARK, mark.id);
            range.surroundContents(element);
          }
          geometry.invalidate(unit);
        }
        painted.set(unit, signature);
      }
      for (const ref of current?.noteRefs ?? []) {
        const [range] = geometry.ranges(ref.unit, ref.start, ref.end);
        const link = range?.startContainer.parentElement?.closest("a");
        if (link && !link.hasAttribute(NOTE)) link.setAttribute(NOTE, ref.key);
      }
      const next = current?.focused ?? null;
      for (const element of column.querySelectorAll<HTMLElement>(
        `mark[${MARK}]`,
      )) {
        const id = element.getAttribute(MARK);
        element.classList.toggle("hl-focused", id === next);
        element.toggleAttribute(
          "data-hovered",
          id === (current?.hovered ?? null),
        );
        if (id === next) element.tabIndex = -1;
        else element.removeAttribute("tabindex");
      }
      if (next !== null && next !== focused) {
        column
          .querySelector<HTMLElement>(`mark[${MARK}="${CSS.escape(next)}"]`)
          ?.focus({
            preventScroll: true,
          });
      }
      focused = next;
    },
    hit(target) {
      const ids: string[] = [];
      let element =
        target instanceof Element ? target.closest(`mark[${MARK}]`) : null;
      while (element) {
        ids.push(element.getAttribute(MARK)!);
        element = element.parentElement?.closest(`mark[${MARK}]`) ?? null;
      }
      return ids;
    },
  };
}
