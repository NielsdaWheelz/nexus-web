"use client";

import {
  useLayoutEffect,
  useState,
  type RefObject,
  type WheelEvent,
} from "react";
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
  /** Hold this message's eye-line across the next path change (wins over the new-turn pin). */
  keepAnchor(id: string | null): void;
  captureReadingPosition(): ChatReadingPosition | null;
  restoreReadingPosition(position: ChatReadingPosition): void;
  getTranscriptElement(): HTMLDivElement | null;
  revealRange(range: Range): void;
}

const NEAR_BOTTOM_PX = 72;

function createScrollOwner(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  setSpacer: (px: number) => void,
  setLatestBelow: (below: boolean) => void,
) {
  let mode: PinMode = "released";
  let anchorId: string | null = null;
  let spacer = 0;
  let settling: number | null = null; // a programmatic scroll's target
  let kept: { id: string; offset: number } | null = null;
  let previousUserId: string | null = null;
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
    settling = clamp(port, top);
    if (smooth)
      port.scrollTo({ top: settling, behavior: preferredScrollBehavior() });
    else port.scrollTop = settling;
  };
  const measure = () => {
    const port = scrollport.current;
    const content = transcript.current;
    const anchor = message(anchorId);
    if (!port || !content) return;
    const below = anchor ? content.scrollHeight - anchor.offsetTop - spacer : 0;
    const next = anchor ? Math.max(0, port.clientHeight - inset() - below) : 0;
    if (next !== spacer) setSpacer((spacer = next));
    setLatestBelow(overflows(port.scrollTop));
  };
  const hold = () => {
    const port = scrollport.current;
    const anchor = message(anchorId);
    if (!port) return;
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
  const pinTop = (id: string, smooth: boolean) => {
    mode = "top";
    const anchor = message(id);
    if (anchor) jump(anchor.offsetTop - inset(), smooth);
  };

  const handle: ChatScrollHandle = {
    scrollToMessage(id) {
      const target = message(id);
      if (!target) return;
      mode = "released";
      jump(target.offsetTop - inset(), true);
    },
    keepAnchor(id) {
      const port = scrollport.current;
      if (!port) return;
      const visible = Array.from(
        port.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find(
        (element) => element.offsetTop + element.offsetHeight > port.scrollTop,
      );
      const anchor = message(id) ?? visible;
      kept = anchor
        ? {
            id: anchor.dataset.messageId ?? "",
            offset: anchor.offsetTop - port.scrollTop,
          }
        : null;
    },
    captureReadingPosition: () => {
      const port = scrollport.current;
      return port && { scrollTop: port.scrollTop, pinMode: mode };
    },
    restoreReadingPosition(position) {
      mode = position.pinMode;
      jump(position.scrollTop, true);
    },
    getTranscriptElement: () => transcript.current,
    revealRange(range) {
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
      mode = "released";
      jump(
        port.scrollTop + rect.top - port.getBoundingClientRect().top - inset(),
        true,
      );
    },
  };

  return {
    handle,
    /** After each commit that may change the newest question or the loaded state. */
    turn(userId: string | null, ready: boolean) {
      const port = scrollport.current;
      if (!port) return;
      anchorId = userId;
      measure();
      const restore = kept && message(kept.id);
      if (kept && restore) {
        mode = "released";
        jump(restore.offsetTop - kept.offset, false);
      } else if (!laidOut) {
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
      kept = null;
      previousUserId = userId;
      measure();
    },
    observe() {
      const observer = new ResizeObserver(() => {
        measure();
        hold();
      });
      if (scrollport.current) observer.observe(scrollport.current);
      if (transcript.current) observer.observe(transcript.current);
      return () => observer.disconnect();
    },
    toLatest() {
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
      if (settling !== null) {
        if (Math.abs(port.scrollTop - settling) <= 1.5) settling = null;
      } else {
        const remaining =
          port.scrollHeight - port.clientHeight - port.scrollTop;
        mode = remaining <= NEAR_BOTTOM_PX ? "bottom" : "released";
      }
      setLatestBelow(overflows(port.scrollTop));
    },
    /** A wheel, touch or key gesture: the scroll it causes is the user's. */
    onUserScroll() {
      settling = null;
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
      settling = null;
      port.scrollTop += event.deltaY;
      event.preventDefault();
    },
  };
}

export function useChatScroll(
  scrollport: RefObject<HTMLDivElement | null>,
  transcript: RefObject<HTMLDivElement | null>,
  lastUserId: string | null,
  ready: boolean,
) {
  const [spacer, setSpacer] = useState(0);
  const [latestBelow, setLatestBelow] = useState(false);
  const [owner] = useState(() =>
    createScrollOwner(scrollport, transcript, setSpacer, setLatestBelow),
  );
  useLayoutEffect(
    () => owner.turn(lastUserId, ready),
    [owner, lastUserId, ready],
  );
  useLayoutEffect(() => owner.observe(), [owner]);
  return { ...owner, spacer, latestBelow };
}
