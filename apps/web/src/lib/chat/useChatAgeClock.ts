"use client";

import { useLayoutEffect, useState } from "react";
import type { ConversationListItem } from "./conversationIndex";

const CHAT_AGE_TICK_MS = 60_000;

/** One visible chat view ages its existing rows without changing its read owner. */
export function useChatAgeClock({ initialInstant, items, visible }: {
  initialInstant: string;
  items: readonly ConversationListItem[];
  visible: boolean;
}): number {
  const [nowMs, setNowMs] = useState(() => Date.parse(initialInstant));
  useLayoutEffect(() => {
    let interval: number | null = null;
    const refresh = () => setNowMs(Date.now());
    const synchronize = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = visible && document.visibilityState !== "hidden"
        ? window.setInterval(refresh, CHAT_AGE_TICK_MS) : null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") refresh();
      synchronize();
    };
    refresh();
    synchronize();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [items, visible]);
  return nowMs;
}
