"use client";

// Reading time for consumption activity: the pane is eligible while it is the active, visible,
// focused pane, the reader is not positioning, and genuine input inside the pane's root came
// within five minutes. While reading it reports where the reading line is (document fraction
// and word ordinal); while inspecting, time only. The observer registers with the hook, not
// with the root: a pane mounts before its document renders, so input is read at the document
// and kept when it lands inside whatever element the root holds then.
import { useEffect, useRef, type RefObject } from "react";
import { codepointLength } from "@/lib/canonicalText/codepoints";
import { registerActivityObserver } from "@/lib/consumption/capture";
import type { Reader } from "@/lib/documentReader/DocumentReader";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";

const IDLE_AFTER_MS = 300_000;
const INPUTS = ["pointerdown", "touchmove", "wheel", "keydown"] as const;

/** PostgreSQL `[[:space:]]` under the UTF-8 locale, deliberately not JS `\s`. */
const SEPARATORS = new Set(
  "\t\n\v\f\r \u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2008\u2009\u200a" +
    "\u2028\u2029\u205f\u3000",
);

/**
 * The document word ordinal at a code-point offset of one fragment: the fragment's first word
 * ordinal plus the runs of non-separator code points before the offset, the token policy of
 * the stored document metrics.
 */
function wordOrdinal(text: string, firstWord: number, offset: number): number {
  const length = codepointLength(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new TypeError(
      `Canonical word offset must be an integer in 0..${length}`,
    );
  }
  let ordinal = firstWord;
  let inWord = false;
  let index = 0;
  for (const codePoint of text) {
    if (index >= offset) break;
    if (SEPARATORS.has(codePoint)) inWord = false;
    else if (!inWord) {
      ordinal += 1;
      inWord = true;
    }
    index += 1;
  }
  return ordinal;
}

export function useReaderActivity(
  mediaId: string,
  reader: Reader,
  root: RefObject<HTMLElement | null>,
  paneActive: boolean,
  isMobile: boolean,
): void {
  const input = useRef<number | undefined>(undefined);
  useEffect(() => {
    const deviceClass = isMobile ? "Mobile" : "Desktop";
    const observer = registerActivityObserver(mediaId, "Reading", {
      deviceClass,
      eligible: false,
    });
    const starts = new WeakMap<object, number[]>();
    const update = () => {
      const state = reader.getState();
      const reading = state.navigation.mode === "Reading";
      const ready = state.document.status === "ready" ? state.document : null;
      const point = state.viewport?.primary;
      let wordPosition: number | undefined;
      if (reading && ready?.doc.kind === "text" && point?.kind === "text") {
        const { units } = ready.doc;
        let first = starts.get(units);
        if (!first) {
          let total = 0;
          first = units.map((unit) => {
            const at = total;
            total = wordOrdinal(unit.text, at, unit.length);
            return at;
          });
          starts.set(units, first);
        }
        const index = units.findIndex((unit) => unit.id === point.unit);
        if (index >= 0) {
          const unit = units[index];
          wordPosition = wordOrdinal(
            unit.text,
            first[index],
            Math.min(point.offset, unit.length),
          );
        }
      }
      const idleUntil =
        input.current === undefined ? undefined : input.current + IDLE_AFTER_MS;
      observer.observe({
        deviceClass,
        eligible:
          paneActive &&
          !state.navigation.positioning &&
          state.viewport !== null &&
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          idleUntil !== undefined &&
          performance.now() < idleUntil,
        idleUntilMono: idleUntil,
        measurement: {
          progress:
            reading && ready && point
              ? ready.structure.fraction(point)
              : undefined,
          wordPosition,
        },
      });
    };
    const noteInput = (event: Event) => {
      const element = root.current;
      const target = event.target;
      if (!event.isTrusted || !element || !(target instanceof Node)) return;
      if (!element.contains(target)) return;
      if (event.type === "pointerdown" && isInteractiveTarget(target, element))
        return;
      input.current = performance.now();
      update();
    };
    const listen = { capture: true, passive: true };
    const sight = [
      [document, "visibilitychange"],
      [window, "focus"],
      [window, "blur"],
    ] as const;
    for (const name of INPUTS)
      document.addEventListener(name, noteInput, listen);
    for (const [target, name] of sight) target.addEventListener(name, update);
    const unsubscribe = reader.subscribe(update);
    update();
    return () => {
      for (const name of INPUTS)
        document.removeEventListener(name, noteInput, listen);
      for (const [target, name] of sight)
        target.removeEventListener(name, update);
      unsubscribe();
      observer.close();
    };
  }, [isMobile, mediaId, paneActive, reader, root]);
}
