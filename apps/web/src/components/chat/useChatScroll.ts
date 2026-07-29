"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type WheelEvent,
} from "react";
import type { ConversationMessage } from "@/lib/conversations/types";
import { preferredScrollBehavior } from "@/lib/preferredScrollBehavior";

/**
 * The small imperative surface the conversation adapter drives on the scroll
 * owner. Everything else (pin, release, ↓Latest, spacer) is internal to
 * {@link useChatScroll} and the view it backs.
 */
export interface ChatScrollHandle {
  /**
   * Snapshot the current eye-line (first-visible message offset + this
   * activation anchor + a raw scrollTop fallback). The owner restores it ONCE on
   * the next messages-driven layout, then clears it. Call synchronously BEFORE
   * the messages state change (branch switch / load-older).
   */
  captureAnchor: (activationAnchorMessageId?: string | null) => void;
  /** Scroll the scoped transcript to a rendered message. */
  scrollToMessage: (messageId: string) => void;
  /** Capture one exact visible transcript eye-line before a Find preview. */
  captureReadingPosition: () => ChatReadingPosition | null;
  /** Restore a previously captured Find eye-line and reading focus exactly. */
  restoreReadingPosition: (position: ChatReadingPosition) => boolean;
  /** Preview one revision-scoped Find occurrence without navigation. */
  previewFindOccurrence: (request: {
    readonly occurrence: ChatFindOccurrencePosition;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  /** Remove transient Find presentation without moving the transcript. */
  clearFindPresentation: () => void;
}

export interface ChatFindOccurrencePosition {
  readonly messageId: string;
  readonly blockIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface ChatReadingPosition {
  readonly anchorMessageId: string;
  readonly anchorOffsetTop: number;
  readonly focusTarget: HTMLElement | null;
}

/** The eye-line snapshot used for branch-switch and load-older restores. */
interface ChatScrollAnchor {
  anchorMessageId: string | null;
  anchorOffsetTop: number;
  activationAnchorMessageId: string | null;
  activationAnchorOffsetTop: number | null;
  scrollTop: number;
}

// Hybrid transcript anchoring (docs/cutovers/chat-scroll-anchoring-hard-cutover.md):
// `top` holds the new question at the top inset; `bottom` follows the newest
// streamed text at the bottom edge; `released` leaves the viewport where a user
// gesture put it. `top` hands off to `bottom` once the answer overflows the fold.
type PinMode = "top" | "bottom" | "released";

// Re-engage following when a genuine scroll lands within this many px of the
// bottom (reference: use-stick-to-bottom STICK_TO_BOTTOM_OFFSET_PX).
const NEAR_BOTTOM_PX = 72;

interface UseChatScroll {
  /** Reserved spacer height (px) rendered as the last child of the transcript. */
  spacerHeight: number;
  /** True when the newest message bottom sits below the fold (drives ↓ Latest). */
  isLatestBelowFold: boolean;
  /** Jump to the newest user turn (or the bottom if that turn exceeds the fold). */
  scrollToLatest: () => void;
  /** Forwards a wheel gesture over the fixed composer dock to the transcript. */
  onComposerWheel: (event: WheelEvent<HTMLElement>) => void;
  /** Scroll handler the view wires onto the scrollport; owns pin-mode + ↓ Latest. */
  onScroll: () => void;
  /** A user scroll gesture (wheel/touch/key); yields the next scroll to onScroll. */
  beginUserScroll: () => void;
  /** Methods exposed to the engine via ChatSurface's ref. */
  captureAnchor: ChatScrollHandle["captureAnchor"];
  scrollToMessage: ChatScrollHandle["scrollToMessage"];
  captureReadingPosition: ChatScrollHandle["captureReadingPosition"];
  restoreReadingPosition: ChatScrollHandle["restoreReadingPosition"];
  previewFindOccurrence: ChatScrollHandle["previewFindOccurrence"];
  clearFindPresentation: ChatScrollHandle["clearFindPresentation"];
  setReadingFocusTarget: (target: HTMLElement | null) => void;
  activeFindOccurrence: ChatFindOccurrencePosition | null;
}

function findMessage(scrollport: HTMLElement, messageId: string) {
  return scrollport.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
}

function lastUserMessageId(messages: ConversationMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id;
  }
  return null;
}

function clampScrollTop(scrollport: HTMLElement, top: number): number {
  const maxScrollTop = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
  return Math.min(Math.max(0, top), maxScrollTop);
}

export function useChatScroll(
  scrollportRef: RefObject<HTMLDivElement | null>,
  transcriptRef: RefObject<HTMLDivElement | null>,
  messages: ConversationMessage[],
  historyLoading = false,
): UseChatScroll {
  const [spacerHeight, setSpacerHeight] = useState(0);
  const [isLatestBelowFold, setIsLatestBelowFold] = useState(false);
  const [activeFindOccurrence, setActiveFindOccurrence] =
    useState<ChatFindOccurrencePosition | null>(null);

  // Current pin anchor (latest user message), the active pin mode, the live
  // spacer height, the pending eye-line snapshot, and first-layout tracking.
  const anchorMessageIdRef = useRef<string | null>(null);
  const pinModeRef = useRef<PinMode>("released");
  const spacerHeightRef = useRef(0);
  const pendingAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const didFirstLayoutRef = useRef(false);
  const sawEmptyReadyStateRef = useRef(false);
  const prevUserIdRef = useRef<string | null>(null);
  // The scrollTop a programmatic scroll is settling toward. `onScroll` skips the
  // mode change while a scroll lands on this target, then clears it; a scroll with
  // no target pending is a genuine user gesture (wheel, touch, key, or scrollbar
  // drag) and re-engages or releases following (see onScroll).
  const programmaticTargetRef = useRef<number | null>(null);
  const activeFindMessageRef = useRef<HTMLElement | null>(null);
  const activeFindOccurrenceRef = useRef<ChatFindOccurrencePosition | null>(
    null,
  );
  const findPreviewGenerationRef = useRef(0);
  const readingFocusTargetRef = useRef<HTMLElement | null>(null);

  const topInset = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return 0;
    return parseFloat(getComputedStyle(transcript).paddingTop) || 0;
  }, [transcriptRef]);

  const measureSpacer = useCallback(() => {
    const scrollport = scrollportRef.current;
    const transcript = transcriptRef.current;
    if (!scrollport || !transcript) return;
    const anchorId = anchorMessageIdRef.current;
    const anchor = anchorId ? findMessage(scrollport, anchorId) : null;
    let next = 0;
    if (anchor) {
      const contentBelowAnchorTop =
        transcript.scrollHeight - anchor.offsetTop - spacerHeightRef.current;
      next = Math.max(
        0,
        scrollport.clientHeight - topInset() - contentBelowAnchorTop,
      );
    }
    if (next !== spacerHeightRef.current) {
      spacerHeightRef.current = next;
      setSpacerHeight(next);
    }
  }, [scrollportRef, transcriptRef, topInset]);

  // True when the newest content would fall below the fold with the transcript
  // pinned so its top sits at `target` scrollTop. The single overflow predicate
  // behind the top→bottom handoff (holdPin), the ↓ Latest mode pick
  // (scrollToLatest), and the below-fold flag — measured identically so the three
  // can never disagree (a `1px` tolerance absorbs sub-pixel rounding).
  const overflowsBelow = useCallback(
    (target: number) => {
      const scrollport = scrollportRef.current;
      const transcript = transcriptRef.current;
      if (!scrollport || !transcript) return false;
      const newestBottom = transcript.scrollHeight - spacerHeightRef.current;
      return newestBottom > target + scrollport.clientHeight + 1;
    },
    [scrollportRef, transcriptRef],
  );

  const measureLatestBelowFold = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    setIsLatestBelowFold(overflowsBelow(scrollport.scrollTop));
  }, [scrollportRef, overflowsBelow]);

  // A discrete one-shot jump (new-turn / first-load top pins, ↓ Latest, scroll-to-
  // message). Honors reduced-motion. The per-frame streaming follow never routes
  // here — it writes scrollTop directly (see holdPin) because smooth can never
  // catch content that grows every frame.
  const scrollTo = useCallback(
    (top: number) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const target = clampScrollTop(scrollport, top);
      programmaticTargetRef.current = target;
      scrollport.scrollTo({ top: target, behavior: preferredScrollBehavior() });
    },
    [scrollportRef],
  );

  // Re-assert the active pin as content reflows during streaming. `top` holds the
  // question at the top inset until the answer would fall below the fold, then
  // hands off — one-way for the turn — to `bottom`, which follows the newest text.
  // Both write scrollTop directly: smooth can never catch content that grows every
  // frame. `released` is left untouched (a user gesture owns the viewport).
  const holdPin = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;

    if (pinModeRef.current === "top") {
      const anchorId = anchorMessageIdRef.current;
      const anchor = anchorId ? findMessage(scrollport, anchorId) : null;
      if (!anchor) return;
      const target = clampScrollTop(scrollport, anchor.offsetTop - topInset());
      if (!overflowsBelow(target)) {
        if (Math.abs(scrollport.scrollTop - target) > 1) {
          programmaticTargetRef.current = target;
          scrollport.scrollTop = target;
        }
        return;
      }
      pinModeRef.current = "bottom";
    }

    if (pinModeRef.current === "bottom") {
      const target = clampScrollTop(scrollport, scrollport.scrollHeight);
      if (Math.abs(scrollport.scrollTop - target) > 1) {
        programmaticTargetRef.current = target;
        scrollport.scrollTop = target;
      }
    }
  }, [scrollportRef, topInset, overflowsBelow]);

  const scrollToLatest = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    const anchorId = anchorMessageIdRef.current;
    const anchor = anchorId ? findMessage(scrollport, anchorId) : null;
    const inset = topInset();
    if (anchor && !overflowsBelow(anchor.offsetTop - inset)) {
      pinModeRef.current = "top";
      scrollTo(anchor.offsetTop - inset);
    } else {
      pinModeRef.current = "bottom";
      scrollTo(scrollport.scrollHeight);
    }
  }, [scrollportRef, scrollTo, topInset, overflowsBelow]);

  const scrollToMessage = useCallback<ChatScrollHandle["scrollToMessage"]>(
    (messageId) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const target = findMessage(scrollport, messageId);
      if (!target) return;
      pinModeRef.current = "released";
      scrollTo(target.offsetTop - topInset());
    },
    [scrollportRef, scrollTo, topInset],
  );

  const setReadingFocusTarget = useCallback((target: HTMLElement | null) => {
    readingFocusTargetRef.current = target;
  }, []);

  const captureReadingPosition = useCallback<
    ChatScrollHandle["captureReadingPosition"]
  >(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return null;
    const scrollTopNow = scrollport.scrollTop;
    const viewportBottom = scrollTopNow + scrollport.clientHeight;
    let firstIntersecting: HTMLElement | null = null;
    let firstAtOrBelowTop: HTMLElement | null = null;
    for (const element of scrollport.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      if (element.offsetTop + element.offsetHeight <= scrollTopNow) continue;
      if (element.offsetTop >= viewportBottom) continue;
      firstIntersecting ??= element;
      if (!firstAtOrBelowTop && element.offsetTop >= scrollTopNow) {
        firstAtOrBelowTop = element;
      }
    }
    const anchor = firstAtOrBelowTop ?? firstIntersecting;
    const anchorMessageId = anchor?.dataset.messageId;
    if (!anchor || !anchorMessageId) return null;
    const focusTarget = readingFocusTargetRef.current;
    return {
      anchorMessageId,
      anchorOffsetTop: anchor.offsetTop - scrollTopNow,
      focusTarget:
        focusTarget?.isConnected === true && scrollport.contains(focusTarget)
          ? focusTarget
          : null,
    };
  }, [scrollportRef]);

  const clearFindPresentation = useCallback(() => {
    findPreviewGenerationRef.current += 1;
    const active = activeFindMessageRef.current;
    if (active) {
      delete active.dataset.findActive;
      delete active.dataset.findBlockIndex;
      delete active.dataset.findStart;
      delete active.dataset.findEnd;
    }
    activeFindMessageRef.current = null;
    activeFindOccurrenceRef.current = null;
    setActiveFindOccurrence(null);
  }, []);

  const previewFindOccurrence = useCallback<
    ChatScrollHandle["previewFindOccurrence"]
  >(
    async ({ occurrence, signal }) => {
      const scrollport = scrollportRef.current;
      if (!scrollport || signal.aborted) return false;
      const target = findMessage(scrollport, occurrence.messageId);
      if (!target) return false;
      const generation = findPreviewGenerationRef.current + 1;
      findPreviewGenerationRef.current = generation;
      const previousOccurrence = activeFindOccurrenceRef.current;
      activeFindOccurrenceRef.current = occurrence;
      setActiveFindOccurrence(occurrence);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (
        signal.aborted ||
        findPreviewGenerationRef.current !== generation
      ) {
        if (findPreviewGenerationRef.current === generation) {
          activeFindOccurrenceRef.current = previousOccurrence;
          setActiveFindOccurrence(previousOccurrence);
        }
        return false;
      }
      const mark = Array.from(
        target.querySelectorAll<HTMLElement>("[data-find-active-mark='true']"),
      ).find(
        (candidate) =>
          candidate.dataset.findBlockIndex === String(occurrence.blockIndex) &&
          candidate.dataset.findStart === String(occurrence.start) &&
          candidate.dataset.findEnd === String(occurrence.end),
      );
      if (!mark) {
        activeFindOccurrenceRef.current = previousOccurrence;
        setActiveFindOccurrence(previousOccurrence);
        return false;
      }
      const priorMessage = activeFindMessageRef.current;
      if (priorMessage && priorMessage !== target) {
        delete priorMessage.dataset.findActive;
        delete priorMessage.dataset.findBlockIndex;
        delete priorMessage.dataset.findStart;
        delete priorMessage.dataset.findEnd;
      }
      target.dataset.findActive = "true";
      target.dataset.findBlockIndex = String(occurrence.blockIndex);
      target.dataset.findStart = String(occurrence.start);
      target.dataset.findEnd = String(occurrence.end);
      activeFindMessageRef.current = target;
      pinModeRef.current = "released";
      const markTop =
        scrollport.scrollTop +
        mark.getBoundingClientRect().top -
        scrollport.getBoundingClientRect().top;
      scrollTo(markTop - topInset());
      return true;
    },
    [scrollTo, scrollportRef, topInset],
  );

  const restoreReadingPosition = useCallback<
    ChatScrollHandle["restoreReadingPosition"]
  >(
    (position) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return false;
      const target = findMessage(scrollport, position.anchorMessageId);
      if (!target) return false;
      if (
        position.focusTarget !== null &&
        (!position.focusTarget.isConnected ||
          !scrollport.contains(position.focusTarget))
      ) {
        return false;
      }
      clearFindPresentation();
      pinModeRef.current = "released";
      scrollTo(target.offsetTop - position.anchorOffsetTop);
      position.focusTarget?.focus({ preventScroll: true });
      return true;
    },
    [clearFindPresentation, scrollTo, scrollportRef],
  );

  const captureAnchor = useCallback<ChatScrollHandle["captureAnchor"]>(
    (activationAnchorMessageId = null) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const scrollTopNow = scrollport.scrollTop;
      const viewportBottom = scrollTopNow + scrollport.clientHeight;
      let anchorMessageId: string | null = null;
      let anchorOffsetTop = 0;
      let activationAnchorOffsetTop: number | null = null;

      for (const element of scrollport.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      )) {
        const messageId = element.dataset.messageId ?? null;
        if (!messageId) continue;
        const offsetTop = element.offsetTop - scrollTopNow;
        if (messageId === activationAnchorMessageId) {
          activationAnchorOffsetTop = offsetTop;
        }
        if (element.offsetTop + element.offsetHeight <= scrollTopNow) continue;
        if (element.offsetTop >= viewportBottom) continue;
        if (!anchorMessageId || (anchorOffsetTop < 0 && offsetTop >= 0)) {
          anchorMessageId = messageId;
          anchorOffsetTop = offsetTop;
        }
      }

      pendingAnchorRef.current = {
        anchorMessageId,
        anchorOffsetTop,
        activationAnchorMessageId: activationAnchorMessageId ?? null,
        activationAnchorOffsetTop,
        scrollTop: scrollTopNow,
      };
    },
    [scrollportRef],
  );

  const restorePendingAnchor = useCallback(
    (snapshot: ChatScrollAnchor) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const restoreOffset = (messageId: string, offsetTop: number) => {
        const target = findMessage(scrollport, messageId);
        if (!target) return false;
        const nextScrollTop = clampScrollTop(scrollport, target.offsetTop - offsetTop);
        scrollport.scrollTop = nextScrollTop;
        programmaticTargetRef.current = nextScrollTop;
        return true;
      };
      if (
        snapshot.anchorMessageId &&
        restoreOffset(snapshot.anchorMessageId, snapshot.anchorOffsetTop)
      ) {
        return;
      }
      if (
        snapshot.activationAnchorMessageId &&
        snapshot.activationAnchorOffsetTop !== null &&
        restoreOffset(
          snapshot.activationAnchorMessageId,
          snapshot.activationAnchorOffsetTop,
        )
      ) {
        return;
      }
      const nextScrollTop = clampScrollTop(scrollport, snapshot.scrollTop);
      scrollport.scrollTop = nextScrollTop;
      programmaticTargetRef.current = nextScrollTop;
    },
    [scrollportRef],
  );

  // Single messages-driven layout pass. Priority: restore a pending eye-line
  // snapshot (branch switch / load-older) → first load settles at the bottom →
  // a new trailing user turn pins to the top inset (smooth). Always re-sizes the
  // spacer and recomputes the below-fold flag afterwards. All derived turn state
  // (next user id, is-new-turn) is computed and recorded HERE, in the committed
  // effect — never during render — so a React StrictMode / concurrent
  // double-render cannot mis-read the trailing turn and drop the pin.
  useLayoutEffect(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    const nextUserId = lastUserMessageId(messages);
    anchorMessageIdRef.current = nextUserId;

    if (pendingAnchorRef.current) {
      const snapshot = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      pinModeRef.current = "released";
      measureSpacer();
      restorePendingAnchor(snapshot);
      measureLatestBelowFold();
      didFirstLayoutRef.current = true;
      prevUserIdRef.current = nextUserId;
      return;
    }

    if (!didFirstLayoutRef.current) {
      measureSpacer();
      // The engine renders empty while loading; wait for the first real (non-empty)
      // layout so an existing conversation opens at the bottom. If the empty
      // surface was already ready (new chat, or an existing empty conversation),
      // its first user turn is a send and should enter the pin cycle.
      if (messages.length === 0) {
        if (!historyLoading) sawEmptyReadyStateRef.current = true;
        return;
      }
      didFirstLayoutRef.current = true;
      prevUserIdRef.current = nextUserId;
      if (sawEmptyReadyStateRef.current && nextUserId) {
        pinModeRef.current = "top";
        const anchor = findMessage(scrollport, nextUserId);
        if (anchor) scrollTo(anchor.offsetTop - topInset());
        measureLatestBelowFold();
        return;
      }
      // Open an existing conversation at its newest message in bottom-follow, so
      // a resumed in-flight run keeps streaming into view; a user scroll-up
      // releases it. (Identical position to "released" for a finished transcript.)
      pinModeRef.current = "bottom";
      const bottom = clampScrollTop(scrollport, scrollport.scrollHeight);
      scrollport.scrollTop = bottom;
      programmaticTargetRef.current = bottom;
      measureLatestBelowFold();
      return;
    }

    measureSpacer();
    const isNewTurn = nextUserId !== null && nextUserId !== prevUserIdRef.current;
    prevUserIdRef.current = nextUserId;
    if (isNewTurn) {
      pinModeRef.current = "top";
      const anchor = nextUserId ? findMessage(scrollport, nextUserId) : null;
      if (anchor) scrollTo(anchor.offsetTop - topInset());
    } else if (pinModeRef.current !== "released") {
      holdPin();
    }
    measureLatestBelowFold();
  }, [
    messages,
    historyLoading,
    scrollportRef,
    measureSpacer,
    restorePendingAnchor,
    measureLatestBelowFold,
    holdPin,
    scrollTo,
    topInset,
  ]);

  // One observer recomputes the spacer + below-fold and (while pinned) re-asserts
  // the anchor or follows the bottom as content grows during streaming.
  useLayoutEffect(() => {
    const scrollport = scrollportRef.current;
    const transcript = transcriptRef.current;
    if (!scrollport || !transcript) return;
    const observer = new ResizeObserver(() => {
      measureSpacer();
      holdPin();
      measureLatestBelowFold();
    });
    observer.observe(scrollport);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [
    scrollportRef,
    transcriptRef,
    measureSpacer,
    measureLatestBelowFold,
    holdPin,
  ]);

  // The single pin-mode authority (§6.2/§10). A programmatic scroll records the
  // scrollTop it is settling toward (`programmaticTargetRef`); while a scroll lands
  // on that target we skip mode changes and clear the marker once it arrives. Any
  // scroll with no marker pending — wheel, touch, keyboard, OR a scrollbar drag —
  // is a genuine user gesture: it re-engages following inside the near-bottom band
  // and otherwise releases until the next send.
  const onScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (scrollport && programmaticTargetRef.current !== null) {
      if (
        Math.abs(scrollport.scrollTop - programmaticTargetRef.current) <= 1.5
      ) {
        programmaticTargetRef.current = null;
      }
    } else if (scrollport) {
      const maxScrollTop = Math.max(
        0,
        scrollport.scrollHeight - scrollport.clientHeight,
      );
      pinModeRef.current =
        maxScrollTop - scrollport.scrollTop <= NEAR_BOTTOM_PX
          ? "bottom"
          : "released";
    }
    measureLatestBelowFold();
  }, [scrollportRef, measureLatestBelowFold]);

  // A user input gesture (wheel / touch / key) is taking over the viewport. Drop
  // the programmatic-settle marker so the resulting scroll is read by `onScroll`
  // as a genuine gesture — re-engaging or releasing follow from the final
  // position — not as the hook's own write landing on its target. The mode is
  // decided only by `onScroll`, never eagerly here: a gesture that moves nothing
  // (e.g. a wheel at the bottom) must not drop an active follow.
  const beginUserScroll = useCallback(() => {
    programmaticTargetRef.current = null;
  }, []);

  const onComposerWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.deltaY === 0) return;
      let target = event.target instanceof Element ? event.target : null;
      while (target && target !== event.currentTarget) {
        if (
          target instanceof HTMLElement &&
          target.scrollHeight > target.clientHeight &&
          ((event.deltaY < 0 && target.scrollTop > 0) ||
            (event.deltaY > 0 &&
              target.scrollTop + target.clientHeight < target.scrollHeight))
        ) {
          return;
        }
        target = target.parentElement;
      }
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      if (
        (event.deltaY < 0 && scrollport.scrollTop <= 0) ||
        (event.deltaY > 0 &&
          scrollport.scrollTop + scrollport.clientHeight >=
            scrollport.scrollHeight)
      ) {
        return;
      }
      programmaticTargetRef.current = null;
      scrollport.scrollTop += event.deltaY;
      event.preventDefault();
    },
    [scrollportRef],
  );

  return {
    spacerHeight,
    isLatestBelowFold,
    scrollToLatest,
    onComposerWheel,
    onScroll,
    beginUserScroll,
    captureAnchor,
    scrollToMessage,
    captureReadingPosition,
    restoreReadingPosition,
    previewFindOccurrence,
    clearFindPresentation,
    setReadingFocusTarget,
    activeFindOccurrence,
  };
}
