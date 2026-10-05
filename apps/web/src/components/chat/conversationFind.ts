"use client";

import { useMemo, type RefObject } from "react";
import type {
  ChatReadingPosition,
  ChatScrollHandle,
} from "@/components/chat/useChatScroll";
import type { Message } from "@/lib/chat/wire";
import {
  findInUnits,
  highlightPainter,
  type FindSource,
} from "@/lib/find/find";
import { buildDomTextCursor } from "@/lib/canonicalText/domTextCursor";
import { resolveDomTextRanges } from "@/lib/canonicalText/domTextRanges";

/**
 * Conversation find searches what the transcript shows: each rendered
 * `[data-pane-find-block]` (a terminal message block on the selected path)
 * without its `[data-pane-find-exclude]` chrome. No reader owns this scroll, so
 * find keeps the way back.
 */
export function useConversationFindSource(input: {
  readonly conversationId: string | null;
  readonly activeLeafMessageId: string | null;
  readonly messages: readonly Message[];
  readonly scroll: RefObject<ChatScrollHandle | null>;
}): FindSource<readonly StaticRange[]> | null {
  const { conversationId, scroll } = input;
  const terminal = input.messages.map((message) =>
    message.status === "pending" ? "" : `${message.id}:${message.status}`,
  );
  const key =
    conversationId &&
    JSON.stringify([conversationId, input.activeLeafMessageId, terminal]);
  return useMemo(() => {
    if (!key) return null;
    let origin: ChatReadingPosition | null = null;
    return {
      key,
      label: "Find in conversation",
      prepare: () => null,
      search(options) {
        const blocks = Array.from(
          scroll.current
            ?.getTranscriptElement()
            ?.querySelectorAll<HTMLElement>("[data-pane-find-block]") ?? [],
        );
        const cursors = blocks.map((block) =>
          buildDomTextCursor(block, (element) =>
            element.hasAttribute("data-pane-find-exclude"),
          ),
        );
        return findInUnits(
          cursors.map((cursor, index) => ({
            id: String(index),
            text: cursor.emitted,
          })),
          options,
          (hit) => {
            const { paneFindRole, paneFindMessageOrdinal } =
              blocks[Number(hit.unit)]!.dataset;
            return {
              at:
                resolveDomTextRanges(
                  cursors[Number(hit.unit)]!,
                  hit.start,
                  hit.end,
                ) ?? [],
              context: [
                paneFindRole === "user" ? "You" : "Assistant",
                `Message ${paneFindMessageOrdinal}`,
              ],
            };
          },
        );
      },
      async reveal(ranges) {
        origin ??= scroll.current?.captureReadingPosition() ?? null;
        if (ranges[0]) scroll.current?.revealRange(ranges[0]);
        return null;
      },
      paint: highlightPainter((ranges) => ranges),
      returnToOrigin() {
        if (origin) scroll.current?.restoreReadingPosition(origin);
        origin = null;
      },
    };
  }, [key, scroll]);
}
