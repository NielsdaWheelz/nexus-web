"use client";

import { useSyncExternalStore } from "react";

export interface ConversationIndexChange {
  readonly revision: number;
}

const INITIAL: ConversationIndexChange = { revision: 0 };
let current = INITIAL;
const listeners = new Set<() => void>();

/** Publish after a committed command changes the viewer's Chats index. */
export function publishConversationIndexChange(): void {
  current = { revision: current.revision + 1 };
  for (const listener of listeners) listener();
}

export function conversationIndexSnapshot(): ConversationIndexChange {
  return current;
}

export function useConversationIndexRevision(): ConversationIndexChange {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    conversationIndexSnapshot,
    () => INITIAL,
  );
}
