"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { buildDomTextCursor, type DomTextCursor } from "@/lib/canonicalText/domTextCursor";
import { resolveDomTextRanges } from "@/lib/canonicalText/domTextRanges";
import type { SourceArrivalContext } from "@/lib/reader/sourceArrival";
import type { MarkdownPassage } from "@/lib/chat/markdownPassages";
import { flushSync } from "react-dom";
import { observeScrollMotion, writeScrollPosition, type ScrollMotion } from "@/lib/collections/scrollMotion";
import type { TurnKey } from "@/lib/chat/wire";
import styles from "./messageInspection.module.css";

// The one transcript scroll owner. A new question pins to the top inset
// ("top") until its answer overflows the fold, then follows the newest text
// ("bottom"); a user gesture releases it. A spacer under the newest question
// lets a short turn reach the top inset. Growth is read from a ResizeObserver,
// so live text and markdown reflow hold the pin without any plumbing.

type PinMode = "top" | "bottom" | "released";
export interface ChatReadingPosition {
  readonly scrollTop: number;
  readonly pinMode: PinMode;
  readonly point: {
    runId: string;
    slotOffsetPx: number;
    line: { messageId: string; offset: number; prefix: string; offsetPx: number; messageOffsetPx: number } | null;
  } | null;
}
export interface ChatScrollHandle {
  inspectMessage(id: string, move: boolean, passage: MarkdownPassage | null): HTMLElement | null;
  /** Hold the inspected control's eye-line while content above it changes. */
  inspectDisclosure(trigger: HTMLElement): void;
  captureReadingPosition(): ChatReadingPosition | null;
  restoreReadingPosition(position: ChatReadingPosition): void;
  getTranscriptElement(): HTMLDivElement | null;
  subscribeGeometry(listener: () => void): () => void;
  releaseFollowing(): void;
  inspectReference(messageId: string, citationId: string | null, marker: number | null): HTMLElement | null;
  revealControl(target: HTMLElement): void;
}

type WindowGeometry = {
  readonly shown: readonly TurnKey[];
  readonly motion: ScrollMotion;
  offset(id: string): number | null;
  readViewport(): void;
  setMotion(motion: ScrollMotion): void;
};

function createScrollOwner(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  spacerElement: RefObject<HTMLDivElement | null>,
  setSpacer: (px: number) => void,
  setLatestBelow: (below: boolean) => void,
  onAttention: () => void,
  geometry: () => WindowGeometry,
) {
  let mode: PinMode = "released";
  let anchorId: string | null = null;
  let spacer = 0;
  let previousSend: string | null = null;
  let previousOrder: readonly TurnKey[] = [];
  let deferredSend: string | null = null;
  let motion: ScrollMotion = "still";
  let nativeStart = 0;
  let lastStillTop = 0;
  let moved = false;
  let latestScope = false;
  let inspection: { trigger: HTMLElement; offset: number; top: number; focus: HTMLElement | null } | null = null;
  let laidOut = false;
  let readingPoint: ChatReadingPosition["point"] = null;
  const geometryListeners = new Set<() => void>();
  let notificationPending = false;
  const notifyGeometry = () => {
    if (notificationPending || geometryListeners.size === 0) return;
    notificationPending = true;
    // Source corrections finish before consumers measure. A microtask runs after
    // React's commit and before paint, including resize and native scroll delivery.
    queueMicrotask(() => { notificationPending = false; for (const listener of geometryListeners) listener(); });
  };
  const cursorOf = (body: HTMLElement) => buildDomTextCursor(body, element => element.matches(".sr-only, [data-pane-find-exclude], button, [role='button']"));
  const rectAt = (cursor: DomTextCursor, offset: number): DOMRect | null => {
    const spans = resolveDomTextRanges(cursor, offset, offset + 1);
    if (!spans) return null;
    const range = document.createRange();
    for (const span of spans) {
      range.setStart(span.startContainer, span.startOffset); range.setEnd(span.endContainer, span.endOffset);
      const rect = range.getClientRects()[0];
      if (rect) return rect;
    }
    return null;
  };
  const capturePoint = () => {
    const port = scrollport.current;
    if (!port) return;
    const top = port.getBoundingClientRect().top;
    const eye = top + inset();
    const slot = [...transcript.current?.querySelectorAll<HTMLElement>("[data-chat-run]") ?? []]
      .find(row => row.getBoundingClientRect().bottom > eye);
    readingPoint = slot ? { runId: slot.dataset.chatRun!, slotOffsetPx: slot.getBoundingClientRect().top - top, line: null } : null;
    if (!readingPoint) return;
    const bottom = Math.min(slot?.getBoundingClientRect().bottom ?? eye, port.getBoundingClientRect().bottom);
    for (const root of slot?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []) {
      const body = root.querySelector<HTMLElement>("[data-message-content]");
      if (!body || body.getBoundingClientRect().bottom <= eye) continue;
      const cursor = cursorOf(body);
      // Table cells are not vertically ordered in canonical DOM order. Find
      // the visible text run first; only offsets within that run share its line flow.
      const probe = document.createRange();
      let run: (typeof cursor.nodes)[number] | null = null;
      let distance = Infinity;
      for (const candidate of cursor.nodes) {
        probe.selectNodeContents(candidate.node);
        for (const box of probe.getClientRects()) {
          if (box.bottom <= eye || box.top >= bottom || box.right <= port.getBoundingClientRect().left || box.left >= port.getBoundingClientRect().right) continue;
          const next = Math.max(0, box.top - eye);
          if (next < distance) { run = candidate; distance = next; }
        }
        if (distance === 0) break;
      }
      if (!run) continue;
      let lo = run.start, hi = run.end;
      while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        let at = middle, rect = rectAt(cursor, at);
        while (!rect && ++at < run.end) rect = rectAt(cursor, at);
        if (rect && rect.bottom > eye) hi = middle; else lo = middle + 1;
      }
      let rect = rectAt(cursor, lo);
      while (!rect && ++lo < run.end) rect = rectAt(cursor, lo);
      if (!rect) continue;
      readingPoint.line = { messageId: root.dataset.messageId!, offset: lo,
        prefix: Array.from(cursor.emitted).slice(0, lo + 1).join(""), offsetPx: rect.top - top,
        messageOffsetPx: root.getBoundingClientRect().top - top };
      return;
    }
  };
  const holdReadingPoint = () => {
    const port = scrollport.current, point = readingPoint;
    if (!port || !point) return;
    const view = geometry();
    let runId = point.runId;
    let offset = view.offset(runId);
    if (offset === null) {
      const rank = previousOrder.findIndex(key => key.run_id === runId);
      if (rank < 0) return;
      const neighbor = [...previousOrder.slice(rank + 1), ...previousOrder.slice(0, rank).reverse()]
        .find(key => view.offset(key.run_id) !== null);
      if (!neighbor) return;
      runId = neighbor.run_id;
      offset = view.offset(runId);
    }
    const root = point.line && runId === point.runId ? message(point.line.messageId) : null;
    const body = root?.querySelector<HTMLElement>("[data-message-content]");
    if (root && body && point.line) {
      const cursor = cursorOf(body);
      const rect = Array.from(cursor.emitted).slice(0, point.line.offset + 1).join("") === point.line.prefix
        ? rectAt(cursor, point.line.offset) : null;
      const drift = (rect ? rect.top - point.line.offsetPx : root.getBoundingClientRect().top - point.line.messageOffsetPx)
        - port.getBoundingClientRect().top;
      if (Math.abs(drift) > .5) jump(port.scrollTop + drift);
      return;
    }
    const slot = transcript.current?.querySelector<HTMLElement>(`[data-chat-run="${CSS.escape(runId)}"]`);
    if (slot) jump(port.scrollTop + slot.getBoundingClientRect().top - port.getBoundingClientRect().top - point.slotOffsetPx);
    else if (offset !== null) jump(offset - point.slotOffsetPx);
  };

  const message = (id: string | null) =>
    id
      ? (scrollport.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(id)}"]`,
        ) ?? null)
      : null;
  const inset = () =>
    transcript.current
      ? parseFloat(getComputedStyle(transcript.current).paddingTop) || 0
      : 0;
  const clamp = (port: HTMLElement, top: number) =>
    Math.min(
      Math.max(0, top),
      Math.max(0, port.scrollHeight - port.clientHeight),
    );
  const paintedSpacer = () => spacerElement.current?.getBoundingClientRect().height ?? 0;
  /** Would the newest content end below the fold with the transcript scrolled to `top`? */
  const overflows = (top: number) => {
    const port = scrollport.current, content = transcript.current;
    return !!port && !!content && content.getBoundingClientRect().height - paintedSpacer() > top + port.clientHeight + 1;
  };
  const jump = (top: number) => {
    const port = scrollport.current;
    if (!port || motion !== "still") return;
    const target = clamp(port, top);
    if (Math.abs(port.scrollTop - target) < 0.5) return;
    writeScrollPosition(port, target);
    lastStillTop = port.scrollTop;
    geometry().readViewport();
  };
  const measure = () => {
    const port = scrollport.current, content = transcript.current, anchor = message(anchorId);
    if (!port || !content || motion !== "still") return;
    const below = anchor ? content.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top - paintedSpacer() : 0;
    const next = anchor ? Math.max(0, Math.round(port.clientHeight - inset() - below)) : 0;
    if (next !== spacer) setSpacer((spacer = next));
  };
  /** Latest shows once the pin has had its say: never for growth the pin is about to follow. */
  const report = () => {
    const port = scrollport.current;
    if (port) setLatestBelow(overflows(port.scrollTop));
  };
  const hold = () => {
    const port = scrollport.current;
    const anchor = message(anchorId);
    if (!port || motion !== "still") return;
    if (holdInspection()) return;
    if (mode === "released") { holdReadingPoint(); return; }
    if (mode === "top" && anchor) {
      const top = clamp(port, anchor.offsetTop - inset());
      if (!overflows(top)) {
        if (Math.abs(port.scrollTop - top) > 1) jump(top);
        return;
      }
      mode = "bottom";
    }
    if (
      mode === "bottom" &&
      Math.abs(port.scrollTop - clamp(port, port.scrollHeight)) > 1
    )
      jump(port.scrollHeight);
  };
  const holdInspection = () => {
    const port = scrollport.current;
    if (!port) return false;
    consumeFocusScroll(port);
    if (!inspection) return false;
    const { trigger, offset } = inspection;
    if (!port.contains(trigger) || !trigger.getClientRects().length) {
      inspection = null;
      return false;
    }
    const drift = trigger.getBoundingClientRect().top - port.getBoundingClientRect().top - offset;
    if (Math.abs(drift) > 1) jump(port.scrollTop + drift);
    inspection.top = port.scrollTop;
    return true;
  };
  const releaseInspection = () => {
    inspection = null;
    mode = "released";
  };
  const noteMovement = (port: HTMLElement) => {
    if (motion === "still" || moved || Math.abs(port.scrollTop - nativeStart) < .5) return;
    moved = true;
    deferredSend = null;
    onAttention();
    releaseInspection();
  };
  const consumeFocusScroll = (port: HTMLElement) => {
    if (!inspection?.focus) return;
    const target = inspection.focus;
    if (document.activeElement !== target || !port.contains(target)) {
      inspection.focus = null;
      return;
    }
    const box = port.getBoundingClientRect();
    if (port.scrollTop !== clamp(port, inspection.top)) {
      // Browsers scroll focused controls either before or after the focus event.
      inspection.offset = inspection.trigger.getBoundingClientRect().top - box.top;
      inspection.top = port.scrollTop;
      inspection.focus = null;
      return;
    }
    const bounds = target.getBoundingClientRect();
    if (bounds.top >= box.top && bounds.bottom <= box.bottom)
      inspection.focus = null;
  };
  const pinTop = (id: string) => {
    mode = "top";
    const anchor = message(id);
    if (anchor) jump(anchor.offsetTop - inset());
  };

  const handle: ChatScrollHandle = {
    inspectMessage(id, move, passage) {
      const root = message(id);
      const target = passage ? root?.querySelector<HTMLElement>("[data-message-passage]") ?? null : root;
      if (!target) return null;
      if (passage && !(Number(target.dataset.messageSourceStart) <= passage.start && Number(target.dataset.messageSourceEnd) >= passage.end)) return null;
      releaseInspection();
      const port = scrollport.current;
      if (move && port) jump(port.scrollTop + target.getBoundingClientRect().top - port.getBoundingClientRect().top - inset());
      capturePoint(); notifyGeometry();
      return target;
    },
    inspectDisclosure(trigger) {
      const port = scrollport.current;
      if (!port || !port.contains(trigger)) return;
      releaseInspection();
      inspection = { trigger, offset: trigger.getBoundingClientRect().top - port.getBoundingClientRect().top, top: port.scrollTop, focus: null };
    },
    captureReadingPosition: () => {
      const port = scrollport.current;
      return port && { scrollTop: port.scrollTop, pinMode: mode, point: readingPoint };
    },
    restoreReadingPosition(position) {
      releaseInspection();
      mode = position.pinMode;
      readingPoint = position.point;
      jump(position.scrollTop);
      if (mode === "released" && readingPoint) holdReadingPoint(); else hold();
      capturePoint(); notifyGeometry();
    },
    getTranscriptElement: () => transcript.current,
    subscribeGeometry(listener) { geometryListeners.add(listener); return () => { geometryListeners.delete(listener); }; },
    releaseFollowing() { onAttention(); releaseInspection(); capturePoint(); },
    revealControl(target) {
      const port = scrollport.current;
      if (!port) return;
      releaseInspection();
      const bounds = target.getBoundingClientRect(), viewport = port.getBoundingClientRect();
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
        jump(port.scrollTop + bounds.top - viewport.top - inset());
      capturePoint(); report(); notifyGeometry();
    },
    inspectReference(id, citationId, marker) {
      const root = message(id);
      const suffix = marker === null ? "" : `[data-citation-marker-start="${marker}"]`;
      const target = citationId === null ? root?.querySelector<HTMLElement>("[data-message-content]")
        : root?.querySelector<HTMLElement>(`[data-citation-id="${CSS.escape(citationId)}"]${suffix}`);
      const port = scrollport.current;
      if (!target || !port) return null;
      onAttention(); releaseInspection();
      jump(port.scrollTop + target.getBoundingClientRect().top - port.getBoundingClientRect().top - inset());
      capturePoint(); notifyGeometry();
      return citationId === null ? target : target.querySelector<HTMLElement>("a[href]") ?? target;
    },

  };

  return {
    handle,
    turn(userId: string | null, initialId: string | null, latest: boolean, sent: string | null) {
      const port = scrollport.current;
      if (!port) return;
      latestScope = latest;
      anchorId = userId;
      const explicitSend = sent !== null && sent !== previousSend;
      previousSend = sent;
      if (motion !== "still") {
        if (explicitSend) deferredSend = userId;
        return;
      }
      measure();
      if (explicitSend && userId !== null) { laidOut = true; pinTop(userId); }
      else if (!laidOut && geometry().shown.length > 0) {
        laidOut = true;
        if (latest) { mode = "bottom"; jump(port.scrollHeight); }
        else if (initialId !== null) jump(geometry().offset(initialId) ?? 0);
      } else hold();
      previousOrder = geometry().shown;
      capturePoint(); report(); notifyGeometry();
    },
    // A terminal replacement can move the footer without changing total height.
    afterLayout() {
      if (motion === "still") { measure(); hold(); capturePoint(); }
      report(); notifyGeometry();
    },
    observe() {
      const port = scrollport.current;
      const observer = new ResizeObserver(() => {
        if (motion === "still") { measure(); hold(); capturePoint(); }
        geometry().readViewport();
        report(); notifyGeometry();
      });
      if (port) observer.observe(port);
      if (transcript.current) observer.observe(transcript.current);
      const unobserve = port && observeScrollMotion(port, next => {
        if (motion === "still") {
          nativeStart = lastStillTop;
          moved = false;
          if (next === "seek") onAttention();
        }
        if (next === "still") {
          noteMovement(port);
          capturePoint();
          if (moved && latestScope && !overflows(port.scrollTop)) mode = "bottom";
          lastStillTop = port.scrollTop;
        }
        motion = next;
        if (next !== "still") noteMovement(port);
        flushSync(() => geometry().setMotion(next));
        if (next === "still" && deferredSend !== null) {
          pinTop(deferredSend);
          deferredSend = null;
        }
      });
      return () => { unobserve?.(); observer.disconnect(); };
    },
    toLatest() {
      releaseInspection();
      const port = scrollport.current;
      const anchor = message(anchorId);
      if (!port) return;
      if (anchor && !overflows(anchor.offsetTop - inset())) pinTop(anchorId ?? "");
      else { mode = "bottom"; jump(port.scrollHeight); }
      capturePoint(); report(); notifyGeometry();
    },
    onScroll() {
      const port = scrollport.current;
      if (!port) return;
      noteMovement(port);
      consumeFocusScroll(port);
      geometry().readViewport();
      capturePoint(); setLatestBelow(overflows(port.scrollTop)); notifyGeometry();
    },
    onFocus(event: FocusEvent<HTMLElement>) {
      const port = scrollport.current;
      if (!port || !inspection) return;
      inspection.focus = event.target;
      consumeFocusScroll(port);
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (inspection) inspection.focus = null;
      if (event.target !== event.currentTarget && event.isPrimary && !event.defaultPrevented) onAttention();
    },
    onClick(event: MouseEvent<HTMLElement>) {
      if (event.target instanceof Element && event.target.closest("a[href]")) releaseInspection();
    },
    /** A wheel over the docked composer scrolls the transcript, unless the composer can scroll. */
    onComposerWheel(event: WheelEvent<HTMLElement>) {
      const port = scrollport.current;
      if (!port || event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
      onAttention();
      for (
        let node = event.target instanceof Element ? event.target : null;
        node;
        node = node.parentElement
      ) {
        const canScroll =
          event.deltaY < 0
            ? node.scrollTop > 0
            : node.scrollTop + node.clientHeight < node.scrollHeight;
        if (node.scrollHeight > node.clientHeight && canScroll) return;
        if (node === event.currentTarget) break;
      }
      const atEdge =
        event.deltaY < 0
          ? port.scrollTop <= 0
          : port.scrollTop + port.clientHeight >= port.scrollHeight;
      if (atEdge) return;
      releaseInspection();
      jump(port.scrollTop + event.deltaY);
      event.preventDefault();
    },
  };
}

export function useChatScroll(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  lastUserId: string | null,
  initialId: string | null,
  latest: boolean,
  sent: string | null,
  onAttention: () => void,
  geometry: WindowGeometry,
) {
  const spacerElement = useRef<HTMLDivElement>(null);
  const [spacer, setSpacer] = useState(0);
  const [latestBelow, setLatestBelow] = useState(false);
  const attention = useRef(onAttention);
  attention.current = onAttention;
  const layout = useRef(geometry); layout.current = geometry;
  const [owner] = useState(() =>
    createScrollOwner(scrollport, transcript, spacerElement, setSpacer, setLatestBelow, () => attention.current(), () => layout.current),
  );
  useLayoutEffect(
    () => owner.turn(lastUserId, initialId, latest, sent),
    [owner, lastUserId, initialId, latest, sent, geometry.shown, geometry.motion],
  );
  useLayoutEffect(() => { owner.afterLayout(); });
  useLayoutEffect(() => owner.observe(), [owner]);
  return { ...owner, spacer, spacerElement, latestBelow };
}

/** The transcript owns scrolling; inspection never changes its message content. */
export async function inspectChatMessage(
  handle: ChatScrollHandle | null,
  id: string,
  context: SourceArrivalContext,
  passage: MarkdownPassage | null,
): Promise<boolean> {
  if (!handle || context.signal.aborted) return false;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (context.signal.aborted) return false;
  const target = handle.inspectMessage(id, !context.restored, passage);
  if (!target) return false;
  target.dataset.sourceInspection = context.activationId;
  target.classList.add(styles.inspected);
  const clear = () => {
    if (target.dataset.sourceInspection !== context.activationId) return;
    delete target.dataset.sourceInspection;
    target.classList.remove(styles.inspected);
  };
  context.signal.addEventListener("abort", clear, { once: true });
  if (context.mayFocus()) {
    const transcript = handle.getTranscriptElement();
    if (transcript) {
      transcript.tabIndex = -1;
      transcript.focus({ preventScroll: true });
    }
  }
  return true;
}
