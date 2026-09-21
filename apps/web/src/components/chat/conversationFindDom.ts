import type {
  ConversationFindOccurrence,
  ConversationFindSnapshot,
  ConversationFindUnit,
} from "@/lib/conversations/conversationFind";
import {
  buildDomTextCursor,
  type DomTextCursor,
} from "@/lib/highlights/domTextCursor";
import { resolveDomTextRanges } from "@/lib/highlights/domTextRanges";

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
  const ranges = resolveDomTextRanges(
    unit.cursor,
    occurrence.startCp,
    occurrence.endCp,
  );
  if (ranges === null) {
    throw new Error("Conversation Find occurrence has no DOM provenance.");
  }
  return ranges;
}
