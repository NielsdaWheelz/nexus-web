"use client";

import {
  useLayoutEffect,
  useState,
  type RefObject,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import type { SourceArrivalContext } from "@/lib/reader/sourceArrival";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import styles from "./messageInspection.module.css";
import { preferredScrollBehavior } from "@/lib/preferredScrollBehavior";

// The one transcript scroll owner. A new question pins to the top inset
// ("top") until its answer overflows the fold, then follows the newest text
// ("bottom"); a user gesture releases it. A spacer under the newest question
// lets a short turn reach the top inset. Growth is read from a ResizeObserver,
// so live text and markdown reflow hold the pin without any plumbing.

type PinMode = "top" | "bottom" | "released";
export interface ChatReadingPosition {
  readonly scrollTop: number;
  readonly pinMode: PinMode;
}
export interface ChatScrollHandle {
  scrollToMessage(id: string): void;
  inspectMessage(id: string, move: boolean): HTMLElement | null;
  /** Hold the inspected control's eye-line while content above it changes. */
  inspectDisclosure(trigger: HTMLElement): void;
  captureReadingPosition(): ChatReadingPosition | null;
  restoreReadingPosition(position: ChatReadingPosition): void;
  getTranscriptElement(): HTMLDivElement | null;
  revealRange(at: AbstractRange): void;
}

function createScrollOwner(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  setSpacer: (px: number) => void,
  setLatestBelow: (below: boolean) => void,
) {
  let mode: PinMode = "released";
  let anchorId: string | null = null;
  let spacer = 0;
  let previousUserId: string | null = null;
  let previousLeafId: string | null = null;
  let inspection: { trigger: HTMLElement; offset: number; top: number; focus: HTMLElement | null } | null = null;
  let scrollGesture: number | null = null;
  let laidOut = false;
  let sawEmptyReady = false;

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
  /** Would the newest content end below the fold with the transcript scrolled to `top`? */
  const overflows = (top: number) => {
    const port = scrollport.current;
    const content = transcript.current;
    return (
      !!port &&
      !!content &&
      content.scrollHeight - spacer > top + port.clientHeight + 1
    );
  };
  const jump = (top: number, smooth: boolean) => {
    const port = scrollport.current;
    if (!port) return;
    const target = clamp(port, top);
    if (Math.abs(port.scrollTop - target) < 0.5) return;
    if (smooth)
      port.scrollTo({ top: target, behavior: preferredScrollBehavior() });
    else {
      port.scrollTop = target;
      // A pending native gesture still belongs to the user after our correction.
      if (scrollGesture !== null) scrollGesture = port.scrollTop;
    }
  };
  const measure = () => {
    const port = scrollport.current;
    const content = transcript.current;
    const anchor = message(anchorId);
    if (!port || !content) return;
    consumeUserScroll(port);
    const below = anchor ? content.scrollHeight - anchor.offsetTop - spacer : 0;
    const next = anchor ? Math.max(0, port.clientHeight - inset() - below) : 0;
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
    if (!port) return;
    if (holdInspection()) return;
    if (mode === "top" && anchor) {
      const top = clamp(port, anchor.offsetTop - inset());
      if (!overflows(top)) {
        if (Math.abs(port.scrollTop - top) > 1) jump(top, false);
        return;
      }
      mode = "bottom";
    }
    if (
      mode === "bottom" &&
      Math.abs(port.scrollTop - clamp(port, port.scrollHeight)) > 1
    )
      jump(port.scrollHeight, false);
  };
  const holdInspection = () => {
    const port = scrollport.current;
    if (!port) return false;
    consumeUserScroll(port);
    consumeFocusScroll(port);
    if (!inspection) return false;
    const { trigger, offset } = inspection;
    if (!port.contains(trigger) || !trigger.getClientRects().length) {
      inspection = null;
      return false;
    }
    const drift = trigger.getBoundingClientRect().top - port.getBoundingClientRect().top - offset;
    if (Math.abs(drift) > 1) jump(port.scrollTop + drift, false);
    inspection.top = port.scrollTop;
    return true;
  };
  const releaseInspection = () => {
    inspection = null;
    scrollGesture = null;
    mode = "released";
  };
  const expectUserScroll = () => {
    const port = scrollport.current;
    if (inspection) inspection.focus = null;
    if (port) scrollGesture = port.scrollTop;
  };
  const consumeUserScroll = (port: HTMLElement) => {
    if (scrollGesture === null) return;
    // Native anchoring is disabled; geometry alone can only clamp the prior top.
    const expected = clamp(port, scrollGesture);
    if (port.scrollTop !== expected) releaseInspection();
    else scrollGesture = expected;
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
  const pinTop = (id: string, smooth: boolean) => {
    mode = "top";
    const anchor = message(id);
    if (anchor) jump(anchor.offsetTop - inset(), smooth);
  };

  const handle: ChatScrollHandle = {
    inspectMessage(id, move) {
      const target = message(id);
      if (!target) return null;
      releaseInspection();
      if (move) jump(target.offsetTop - inset(), false);
      return target;
    },
    inspectDisclosure(trigger) {
      const port = scrollport.current;
      if (!port || !port.contains(trigger)) return;
      releaseInspection();
      inspection = { trigger, offset: trigger.getBoundingClientRect().top - port.getBoundingClientRect().top, top: port.scrollTop, focus: null };
    },
    scrollToMessage(id) {
      const target = message(id);
      if (!target) return;
      releaseInspection();
      jump(target.offsetTop - inset(), true);
    },
    captureReadingPosition: () => {
      const port = scrollport.current;
      return port && { scrollTop: port.scrollTop, pinMode: mode };
    },
    restoreReadingPosition(position) {
      releaseInspection();
      mode = position.pinMode;
      jump(position.scrollTop, true);
    },
    getTranscriptElement: () => transcript.current,
    revealRange(at) {
      releaseInspection();
      const range = document.createRange();
      range.setStart(at.startContainer, at.startOffset);
      range.setEnd(at.endContainer, at.endOffset);
      const port = scrollport.current;
      const code = range.startContainer.parentElement?.closest<HTMLElement>(
        "[data-pane-find-code-scroll]",
      );
      const rect = range.getBoundingClientRect();
      const box = code?.getBoundingClientRect();
      if (code && box)
        code.scrollLeft +=
          rect.left < box.left
            ? rect.left - box.left
            : Math.max(0, rect.right - box.right);
      if (!port) return;
      jump(
        port.scrollTop + rect.top - port.getBoundingClientRect().top - inset(),
        true,
      );
    },
  };

  return {
    handle,
    /** After each commit that may change the newest question or the loaded state. */
    turn(userId: string | null, leafId: string | null, ready: boolean) {
      const port = scrollport.current;
      if (!port) return;
      if (leafId !== previousLeafId) {
        inspection = null;
        scrollGesture = null;
      }
      anchorId = userId;
      measure();
      if (!laidOut) {
        if (userId === null) sawEmptyReady ||= ready;
        else if (sawEmptyReady) pinTop(userId, true);
        else {
          mode = "bottom"; // an opened chat starts at its newest message, following a live answer
          jump(port.scrollHeight, false);
        }
        laidOut = userId !== null;
      } else if (userId !== null && userId !== previousUserId)
        pinTop(userId, true);
      else hold();
      previousUserId = userId;
      previousLeafId = leafId;
      measure();
      report();
    },
    // A terminal replacement can move the footer without changing total height.
    afterLayout: holdInspection,
    observe() {
      const observer = new ResizeObserver(() => {
        measure();
        hold();
        report();
      });
      if (scrollport.current) observer.observe(scrollport.current);
      if (transcript.current) observer.observe(transcript.current);
      return () => observer.disconnect();
    },
    toLatest() {
      releaseInspection();
      const port = scrollport.current;
      const anchor = message(anchorId);
      if (!port) return;
      if (anchor && !overflows(anchor.offsetTop - inset()))
        pinTop(anchorId ?? "", true);
      else {
        mode = "bottom";
        jump(port.scrollHeight, true);
      }
    },
    onScroll() {
      const port = scrollport.current;
      if (!port) return;
      consumeUserScroll(port);
      consumeFocusScroll(port);
      setLatestBelow(overflows(port.scrollTop));
    },
    onFocus(event: FocusEvent<HTMLElement>) {
      const port = scrollport.current;
      if (!port || !inspection) return;
      scrollGesture = null;
      inspection.focus = event.target;
      consumeFocusScroll(port);
    },
    /** A gesture releases inspection only if it actually moves this scrollport. */
    onUserScroll(event: WheelEvent<HTMLElement> | TouchEvent<HTMLElement>) {
      if (event.defaultPrevented || ("deltaY" in event && (event.deltaY === 0 || event.ctrlKey))) return;
      expectUserScroll();
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      scrollGesture = null;
      if (inspection) inspection.focus = null;
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (event.key === " " && event.target instanceof Element && event.target.closest("button, summary, [role='button']")) return;
      expectUserScroll();
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      // Native scrollbar drags target the scrollport, not its transcript.
      scrollGesture = null;
      if (inspection) inspection.focus = null;
      if (event.target === event.currentTarget) expectUserScroll();
    },
    onClick(event: MouseEvent<HTMLElement>) {
      scrollGesture = null;
      if (event.target instanceof Element && event.target.closest("a[href]")) releaseInspection();
    },
    /** A wheel over the docked composer scrolls the transcript, unless something inside can scroll. */
    onComposerWheel(event: WheelEvent<HTMLElement>) {
      const port = scrollport.current;
      if (!port || event.defaultPrevented || event.deltaY === 0) return;
      for (
        let node = event.target instanceof HTMLElement ? event.target : null;
        node && node !== event.currentTarget;
        node = node.parentElement
      ) {
        const canScroll =
          event.deltaY < 0
            ? node.scrollTop > 0
            : node.scrollTop + node.clientHeight < node.scrollHeight;
        if (node.scrollHeight > node.clientHeight && canScroll) return;
      }
      const atEdge =
        event.deltaY < 0
          ? port.scrollTop <= 0
          : port.scrollTop + port.clientHeight >= port.scrollHeight;
      if (atEdge) return;
      releaseInspection();
      port.scrollTop += event.deltaY;
      event.preventDefault();
    },
  };
}

export function useChatScroll(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  lastUserId: string | null,
  leafId: string | null,
  ready: boolean,
) {
  const [spacer, setSpacer] = useState(0);
  const [latestBelow, setLatestBelow] = useState(false);
  const [owner] = useState(() =>
    createScrollOwner(scrollport, transcript, setSpacer, setLatestBelow),
  );
  useLayoutEffect(
    () => owner.turn(lastUserId, leafId, ready),
    [owner, lastUserId, leafId, ready],
  );
  useLayoutEffect(() => { owner.afterLayout(); });
  useLayoutEffect(() => owner.observe(), [owner]);
  return { ...owner, spacer, latestBelow };
}

/** The transcript owns scrolling; inspection never changes its message content. */
export async function inspectChatMessage(
  handle: ChatScrollHandle | null,
  id: string,
  context: SourceArrivalContext,
): Promise<boolean> {
  if (!handle || context.signal.aborted) return false;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (context.signal.aborted) return false;
  const target = handle.inspectMessage(id, !context.restored);
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
