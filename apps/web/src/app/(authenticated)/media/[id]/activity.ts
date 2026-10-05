"use client";

// Reading time for consumption activity: the pane is eligible while it is the
// active, visible, focused pane, the reader is not positioning, and genuine
// input came within five minutes. While reading it reports where the reading
// line is (document fraction and word ordinal); while inspecting, time only.
import { useEffect, useId, useRef, type RefObject } from "react";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { documentWordBoundaryOrdinal } from "@/lib/consumption/canonicalWordPosition";
import type { Reader } from "@/lib/documentReader/DocumentReader";
import { isInteractiveTarget } from "@/lib/ui/interactiveTarget";

const IDLE_AFTER_MS = 300_000;

export function useReaderActivity(
  mediaId: string,
  reader: Reader,
  root: RefObject<HTMLElement | null>,
  paneActive: boolean,
  isMobile: boolean,
): void {
  const input = useRef<number | undefined>(undefined);
  const instance = useId();
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const key = `reader:${mediaId}:${instance}`;
    const lane = {
      mediaRef: parseMediaRef(`media:${mediaId}`),
      modality: "Reading" as const,
      deviceClass: isMobile ? ("Mobile" as const) : ("Desktop" as const),
    };
    const recorder = activityRecorder();
    const unregister = recorder.registerObserver(key, { ...lane, eligible: false });
    const starts = new WeakMap<object, number[]>();
    const update = () => {
      const state = reader.getState();
      const now = performance.now();
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
            total = documentWordBoundaryOrdinal({ canonicalText: unit.text, documentWordStart: at, offset: unit.length });
            return at;
          });
          starts.set(units, first);
        }
        const index = units.findIndex((unit) => unit.id === point.unit);
        if (index >= 0)
          wordPosition = documentWordBoundaryOrdinal({
            canonicalText: units[index].text,
            documentWordStart: first[index],
            offset: Math.min(point.offset, units[index].length),
          });
      }
      recorder.observe(key, {
        ...lane,
        eligible:
          paneActive &&
          !state.navigation.positioning &&
          state.viewport !== null &&
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          input.current !== undefined &&
          now < input.current + IDLE_AFTER_MS,
        idleUntilMono: input.current === undefined ? undefined : input.current + IDLE_AFTER_MS,
        measurement: {
          progress: reading && ready && point ? ready.structure.fraction(point) : undefined,
          wordPosition,
        },
      });
    };
    const noteInput = (event: Event) => {
      if (!event.isTrusted || ((event.type === "pointerdown") && isInteractiveTarget(event.target, element))) return;
      input.current = performance.now();
      update();
    };
    const events = ["pointerdown", "touchmove", "wheel", "keydown"] as const;
    for (const name of events) element.addEventListener(name, noteInput, { passive: true });
    for (const [target, name] of [[document, "visibilitychange"], [window, "focus"], [window, "blur"]] as const)
      target.addEventListener(name, update);
    const unsubscribe = reader.subscribe(update);
    update();
    return () => {
      for (const name of events) element.removeEventListener(name, noteInput);
      for (const [target, name] of [[document, "visibilitychange"], [window, "focus"], [window, "blur"]] as const)
        target.removeEventListener(name, update);
      unsubscribe();
      unregister();
    };
  }, [instance, isMobile, mediaId, paneActive, reader, root]);
}
