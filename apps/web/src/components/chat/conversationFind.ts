"use client";

import { useMemo, useRef, type RefObject } from "react";
import type { ChatReadingPosition, ChatScrollHandle } from "./useChatScroll";
import type { Message } from "@/lib/chat/wire";
import { chatFindDestinationHref, type ChatFindDestination } from "@/lib/chat/findDestination";
import { findInUnits, highlightPainter, type FindRow, type FindSource } from "@/lib/find/find";
import { textSha256 } from "@/lib/find/textSha256";
import { buildDomTextCursor } from "@/lib/canonicalText/domTextCursor";
import { resolveDomTextRanges } from "@/lib/canonicalText/domTextRanges";
import type { SourceArrivalContext, SourceArrivalOutcome } from "@/lib/reader/sourceArrival";

interface ChatFindMatch {
  readonly destination: ChatFindDestination;
  readonly leafId: string | null;
  readonly message: Message;
  readonly renderedText: string;
  readonly ranges: readonly StaticRange[];
}

function messageCursor(handle: ChatScrollHandle | null, messageId: string) {
  const block = handle?.getTranscriptElement()?.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"] [data-pane-find-block]`,
  );
  return block ? buildDomTextCursor(block, (element) => element.hasAttribute("data-pane-find-exclude")) : null;
}

/**
 * Search terminal rendered messages on the selected path, excluding find chrome.
 * Each row freezes its branch, message, codepoint range and complete-text digest.
 * Only local inspection retains DOM ranges and a way back; hrefs retain neither.
 */
export function useConversationFindSource(input: {
  readonly ownerKey: string;
  readonly conversationId: string | null;
  readonly activeLeafMessageId: string | null;
  readonly messages: readonly Message[];
  readonly scroll: RefObject<ChatScrollHandle | null>;
  readonly isCurrent: (message: Message) => boolean;
  readonly onInspect: () => void;
}): FindSource<ChatFindMatch> | null {
  const { scroll } = input;
  const latest = useRef(input);
  latest.current = input;
  const terminal = input.messages.filter((message) => message.status !== "pending");
  const key = input.conversationId && JSON.stringify([
    input.ownerKey, input.conversationId, input.activeLeafMessageId,
    terminal.map((message) => [message.id, message.status, message.content]),
  ]);
  return useMemo<FindSource<ChatFindMatch> | null>(() => {
    const captured = latest.current;
    const { conversationId, activeLeafMessageId } = captured;
    if (!key || !conversationId) return null;
    let origin: ChatReadingPosition | null = null;
    return {
      key,
      label: "Find in conversation",
      narrowLabel: null,
      prepare: () => null,
      async search(options, _narrow, signal) {
        const snapshots = new Map(captured.messages.flatMap((message) => {
          const cursor = message.status === "pending" ? null : messageCursor(scroll.current, message.id);
          return cursor ? [[message.id, { message, cursor }] as const] : [];
        }));
        const outcome = findInUnits(
          [...snapshots].map(([id, { cursor }]) => ({ id, text: cursor.emitted })),
          options,
          (hit) => {
            const message = snapshots.get(hit.unit)!.message;
            return { at: hit, context: [message.role === "user" ? "You" : "Assistant", `Message ${captured.messages.indexOf(message) + 1}`] };
          },
        );
        if (outcome.kind !== "Rows") return outcome;
        const digests = new Map<string, string>();
        for (const { at } of outcome.rows) {
          if (digests.has(at.unit)) continue;
          signal.throwIfAborted();
          digests.set(at.unit, await textSha256(snapshots.get(at.unit)!.cursor.emitted));
          signal.throwIfAborted();
        }
        // Every asynchronous hash must settle before validating the captured path
        // and rebuilding ranges. A re-render may have replaced equivalent nodes.
        for (const id of digests.keys()) {
          const snapshot = snapshots.get(id)!;
          const cursor = messageCursor(scroll.current, id);
          if (!captured.isCurrent(snapshot.message) || !cursor || cursor.emitted !== snapshot.cursor.emitted)
            return { kind: "Failed", message: "this match is no longer available" };
          snapshots.set(id, { ...snapshot, cursor });
        }
        const rows: FindRow<ChatFindMatch>[] = [];
        for (const row of outcome.rows) {
          const { message, cursor } = snapshots.get(row.at.unit)!;
          const ranges = resolveDomTextRanges(cursor, row.at.start, row.at.end);
          if (!ranges) return { kind: "Failed", message: "this match is no longer available" };
          rows.push({ ...row, at: {
            destination: { kind: "find_match", message_id: message.id, start: row.at.start, end: row.at.end, text_sha256: digests.get(message.id)! },
            leafId: activeLeafMessageId, message, renderedText: cursor.emitted, ranges,
          } });
        }
        return { ...outcome, rows };
      },
      href: (at) => at.leafId === null ? null : chatFindDestinationHref(conversationId, at.leafId, at.destination),
      async reveal(at, signal) {
        if (signal.aborted) return { kind: "Cancelled" };
        const surface = scroll.current;
        const cursor = messageCursor(surface, at.destination.message_id);
        const ranges = cursor && cursor.emitted === at.renderedText && captured.isCurrent(at.message)
          ? resolveDomTextRanges(cursor, at.destination.start, at.destination.end) : null;
        if (!surface || !ranges?.[0]) return { kind: "Failed", message: "this match is no longer available" };
        captured.onInspect();
        origin ??= surface.captureReadingPosition();
        surface.revealRange(ranges[0]);
        return { kind: "Shown" };
      },
      paint: highlightPainter((at) => at.ranges),
      returnToOrigin() {
        if (origin) scroll.current?.restoreReadingPosition(origin);
        origin = null;
      },
    };
  }, [key, scroll]);
}

/** The arrival owns exact positioning, paint and focus until its signal retires. */
export async function inspectConversationFindMatch(input: {
  readonly handle: ChatScrollHandle | null;
  readonly destination: ChatFindDestination;
  readonly context: SourceArrivalContext;
  readonly isCurrent: () => boolean;
}): Promise<SourceArrivalOutcome> {
  const { handle, destination, context, isCurrent } = input;
  if (context.signal.aborted) return "Cancelled";
  const cursor = messageCursor(handle, destination.message_id);
  if (!handle || !cursor || !isCurrent()) return "Unavailable";
  const digest = await textSha256(cursor.emitted);
  if (context.signal.aborted) return "Cancelled";
  const current = messageCursor(handle, destination.message_id);
  if (!isCurrent() || !current || current.emitted !== cursor.emitted || digest !== destination.text_sha256) return "Unavailable";
  const ranges = resolveDomTextRanges(current, destination.start, destination.end);
  if (!ranges?.[0]) return "Unavailable";
  if (!context.restored) handle.revealRange(ranges[0]);
  const paint = highlightPainter<readonly StaticRange[]>((at) => at);
  paint([{ at: ranges, context: [], snippet: [] }], 0);
  context.signal.addEventListener("abort", () => paint([], -1), { once: true });
  if (context.mayFocus()) {
    const transcript = handle.getTranscriptElement();
    if (transcript) { transcript.tabIndex = -1; transcript.focus({ preventScroll: true }); }
  }
  return "Applied";
}
