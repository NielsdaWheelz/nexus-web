import type {
  ConversationFindOccurrence,
  ConversationFindSnapshot,
  ConversationFindUnit,
} from "@/lib/conversations/conversationFind";
import {
  buildDomTextCursor,
  type DomTextCursor,
  type DomTextSpan,
} from "@/lib/highlights/domTextCursor";

export interface PreparedConversationFindUnit extends ConversationFindUnit {
  readonly root: HTMLElement;
  readonly cursor: DomTextCursor;
}

function blockKey(messageId: string, blockIndex: number): string {
  return JSON.stringify([messageId, blockIndex]);
}

export function prepareConversationFindUnits({
  snapshot,
  transcript,
}: {
  readonly snapshot: ConversationFindSnapshot;
  readonly transcript: HTMLElement;
}): readonly PreparedConversationFindUnit[] {
  const roots = new Map<string, HTMLElement>();
  for (const root of transcript.querySelectorAll<HTMLElement>(
    "[data-pane-find-block='true']",
  )) {
    const messageId = root.dataset.paneFindMessageId;
    const blockIndex = Number(root.dataset.paneFindBlockIndex);
    if (!messageId || !Number.isSafeInteger(blockIndex) || blockIndex < 0) {
      throw new Error("Conversation Find block root has an invalid locator.");
    }
    const key = blockKey(messageId, blockIndex);
    if (roots.has(key)) {
      throw new Error("Conversation Find block root locator is duplicated.");
    }
    roots.set(key, root);
  }

  return snapshot.messages.flatMap((message) =>
    message.blocks.map((block) => {
      const root = roots.get(blockKey(message.id, block.blockIndex));
      if (!root) {
        throw new Error("Conversation Find block root is unavailable.");
      }
      if (
        root.dataset.paneFindMessageOrdinal !==
          String(message.messageOrdinal) ||
        root.dataset.paneFindRole !== message.role
      ) {
        throw new Error("Conversation Find block root identity drifted.");
      }
      const cursor = buildDomTextCursor(
        root,
        (element) => element.hasAttribute("data-pane-find-exclude"),
      );
      return {
        unitId: block.unitId,
        messageId: message.id,
        messageOrdinal: message.messageOrdinal,
        blockIndex: block.blockIndex,
        role: message.role,
        text: cursor.emitted,
        root,
        cursor,
      };
    }),
  );
}

function compareDomSpans(left: DomTextSpan, right: DomTextSpan): number {
  if (left.node === right.node) {
    return (
      left.startUtf16 - right.startUtf16 ||
      left.endUtf16 - right.endUtf16
    );
  }
  const position = left.node.compareDocumentPosition(right.node);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  throw new Error(
    "Conversation Find provenance must share one document tree.",
  );
}

function mergeDomSpans(spans: readonly DomTextSpan[]): readonly DomTextSpan[] {
  const merged: DomTextSpan[] = [];
  for (const span of [...spans].sort(compareDomSpans)) {
    const previous = merged[merged.length - 1];
    if (
      previous?.node === span.node &&
      span.startUtf16 <= previous.endUtf16
    ) {
      previous.endUtf16 = Math.max(previous.endUtf16, span.endUtf16);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function resolveConversationFindRanges({
  units,
  occurrence,
}: {
  readonly units: readonly PreparedConversationFindUnit[];
  readonly occurrence: ConversationFindOccurrence;
}): readonly Range[] {
  const unit = units.find(
    (candidate) =>
      candidate.messageId === occurrence.messageId &&
      candidate.blockIndex === occurrence.blockIndex,
  );
  if (
    !unit ||
    !unit.root.isConnected ||
    !Number.isSafeInteger(occurrence.startCp) ||
    !Number.isSafeInteger(occurrence.endCp) ||
    occurrence.startCp < 0 ||
    occurrence.endCp <= occurrence.startCp ||
    occurrence.endCp > unit.cursor.length
  ) {
    throw new Error("Conversation Find occurrence is not renderable.");
  }
  const spans = mergeDomSpans(
    unit.cursor.provenance
      .slice(occurrence.startCp, occurrence.endCp)
      .flatMap(({ spans: sourceSpans }) => sourceSpans),
  );
  if (spans.length === 0) {
    throw new Error("Conversation Find occurrence has no DOM provenance.");
  }
  return spans.map((span) => {
    const range = span.node.ownerDocument.createRange();
    range.setStart(span.node, span.startUtf16);
    range.setEnd(span.node, span.endUtf16);
    return range;
  });
}
