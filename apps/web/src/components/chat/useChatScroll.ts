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
}

/** The eye-line snapshot used for branch-switch and load-older restores. */
interface ChatScrollAnchor {
  anchorMessageId: string | null;
  anchorOffsetTop: number;
  activationAnchorMessageId: string | null;
  activationAnchorOffsetTop: number | null;
  scrollTop: number;
}

interface UseChatScroll {
  /** Reserved spacer height (px) rendered as the last child of the transcript. */
  spacerHeight: number;
  /** True when the newest message bottom sits below the fold (drives ↓ Latest). */
  isLatestBelowFold: boolean;
  /** Jump to the newest user turn (or the bottom if that turn exceeds the fold). */
  scrollToLatest: () => void;
  /** Forwards a wheel gesture over the fixed composer dock to the transcript. */
  onComposerWheel: (event: WheelEvent<HTMLElement>) => void;
  /** Scroll handler the view wires onto the scrollport; owns pin release + ↓ Latest. */
  onScroll: () => void;
  /** Explicit user gesture over the scrollport; releases pin/programmatic state. */
  releasePin: () => void;
  /** Methods exposed to the engine via ChatSurface's ref. */
  captureAnchor: ChatScrollHandle["captureAnchor"];
  scrollToMessage: ChatScrollHandle["scrollToMessage"];
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

function assistantMessageIdAfter(
  messages: ConversationMessage[],
  anchorMessageId: string,
): string | null {
  const anchorIndex = messages.findIndex((message) => message.id === anchorMessageId);
  if (anchorIndex < 0) return null;
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") return message.id;
    if (message.role === "user") return null;
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

  // Current pin anchor (latest user message), whether we are holding it at the
  // top, the live spacer height, the pending eye-line snapshot, and first-layout
  // tracking.
  const anchorMessageIdRef = useRef<string | null>(null);
  const pinnedRef = useRef(false);
  const spacerHeightRef = useRef(0);
  const pendingAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const didFirstLayoutRef = useRef(false);
  const sawEmptyReadyStateRef = useRef(false);
  const prevUserIdRef = useRef<string | null>(null);
  // The scrollTop a programmatic scroll is settling toward. `onScroll` skips the
  // pin release while a scroll lands on this target, then clears it; a scroll with
  // no target pending is a genuine user gesture (wheel, touch, key, or scrollbar
  // drag) and releases the pin until the next send.
  const programmaticTargetRef = useRef<number | null>(null);

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

  const measureLatestBelowFold = useCallback(() => {
    const scrollport = scrollportRef.current;
    const transcript = transcriptRef.current;
    if (!scrollport || !transcript) return;
    const newestBottom = transcript.scrollHeight - spacerHeightRef.current;
    setIsLatestBelowFold(
      newestBottom > scrollport.scrollTop + scrollport.clientHeight + 1,
    );
  }, [scrollportRef, transcriptRef]);

  const scrollTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const target = clampScrollTop(scrollport, top);
      programmaticTargetRef.current = target;
      scrollport.scrollTo({ top: target, behavior });
    },
    [scrollportRef],
  );

  // While pinned, hold the anchor's top at the top inset as content reflows above
  // or below it (e.g. a markdown image loads). Released by any user gesture.
  const holdPinned = useCallback(() => {
    const scrollport = scrollportRef.current;
    const anchorId = anchorMessageIdRef.current;
    if (!scrollport || !pinnedRef.current || !anchorId) return;
    const anchor = findMessage(scrollport, anchorId);
    if (!anchor) return;
    const target = clampScrollTop(scrollport, anchor.offsetTop - topInset());
    if (Math.abs(scrollport.scrollTop - target) > 1) {
      programmaticTargetRef.current = target;
      scrollport.scrollTop = target;
    }
  }, [scrollportRef, topInset]);

  const scrollToLatest = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    const anchorId = anchorMessageIdRef.current;
    const anchor = anchorId ? findMessage(scrollport, anchorId) : null;
    const inset = topInset();
    const assistantId = anchorId
      ? assistantMessageIdAfter(messages, anchorId)
      : null;
    const assistant = assistantId ? findMessage(scrollport, assistantId) : null;
    const assistantExceedsViewport =
      assistant !== null &&
      assistant.offsetHeight > scrollport.clientHeight - inset;
    pinnedRef.current = Boolean(anchor && !assistantExceedsViewport);
    if (anchor && !assistantExceedsViewport) {
      scrollTo(anchor.offsetTop - inset, "smooth");
    } else {
      scrollTo(scrollport.scrollHeight, "smooth");
    }
  }, [messages, scrollportRef, scrollTo, topInset]);

  const scrollToMessage = useCallback<ChatScrollHandle["scrollToMessage"]>(
    (messageId) => {
      const scrollport = scrollportRef.current;
      if (!scrollport) return;
      const target = findMessage(scrollport, messageId);
      if (!target) return;
      pinnedRef.current = false;
      scrollTo(target.offsetTop - topInset(), "smooth");
    },
    [scrollportRef, scrollTo, topInset],
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
      pinnedRef.current = false;
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
        pinnedRef.current = true;
        const anchor = findMessage(scrollport, nextUserId);
        if (anchor) scrollTo(anchor.offsetTop - topInset(), "smooth");
        measureLatestBelowFold();
        return;
      }
      pinnedRef.current = false;
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
      pinnedRef.current = true;
      const anchor = nextUserId ? findMessage(scrollport, nextUserId) : null;
      if (anchor) scrollTo(anchor.offsetTop - topInset(), "smooth");
    } else if (pinnedRef.current) {
      holdPinned();
    }
    measureLatestBelowFold();
  }, [
    messages,
    historyLoading,
    scrollportRef,
    measureSpacer,
    restorePendingAnchor,
    measureLatestBelowFold,
    holdPinned,
    scrollTo,
    topInset,
  ]);

  // One observer recomputes the spacer + below-fold and (while pinned) re-asserts
  // the anchor at the top as content grows during streaming.
  useLayoutEffect(() => {
    const scrollport = scrollportRef.current;
    const transcript = transcriptRef.current;
    if (!scrollport || !transcript) return;
    const observer = new ResizeObserver(() => {
      measureSpacer();
      holdPinned();
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
    holdPinned,
  ]);

  // The single pin-release path (§4.1/§11). A programmatic scroll records the
  // scrollTop it is settling toward (`programmaticTargetRef`); while a scroll lands
  // on that target we skip the release and clear the marker once it arrives. Any
  // scroll with no marker pending — wheel, touch, keyboard, OR a scrollbar drag —
  // is a genuine user gesture and releases the pin until the next send.
  const onScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (scrollport && programmaticTargetRef.current !== null) {
      if (
        Math.abs(scrollport.scrollTop - programmaticTargetRef.current) <= 1.5
      ) {
        programmaticTargetRef.current = null;
      }
    } else {
      pinnedRef.current = false;
    }
    measureLatestBelowFold();
  }, [scrollportRef, measureLatestBelowFold]);

  const releasePin = useCallback(() => {
    pinnedRef.current = false;
    programmaticTargetRef.current = null;
    measureLatestBelowFold();
  }, [measureLatestBelowFold]);

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
      pinnedRef.current = false;
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
    releasePin,
    captureAnchor,
    scrollToMessage,
  };
}
