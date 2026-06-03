"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  assistantSelectionBranchDraft,
  mapAssistantSelectionToSource,
  type AssistantSelectionTextDraft,
} from "@/lib/conversations/assistantSelection";
import {
  conversationMessageText,
  type BranchDraft,
  type ConversationMessage,
} from "@/lib/conversations/types";
import { createRandomId } from "@/lib/createRandomId";

export interface AssistantSelectionBranchSelection
  extends AssistantSelectionTextDraft {
  rect: DOMRect;
  lineRects: DOMRect[];
}

export function useAssistantSelectionBranch({
  message,
  enabled,
  onReplyToAssistant,
}: {
  message: ConversationMessage;
  enabled: boolean;
  onReplyToAssistant?: (draft: BranchDraft) => void;
}) {
  const answerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] =
    useState<AssistantSelectionBranchSelection | null>(null);
  const assistantText = conversationMessageText(message);

  const captureSelection = useCallback(() => {
    if (!enabled) return;
    const liveSelection = window.getSelection();
    const container = answerRef.current;
    if (!liveSelection || !container || liveSelection.rangeCount === 0) {
      setSelection(null);
      return;
    }

    const range = liveSelection.getRangeAt(0);
    if (
      liveSelection.isCollapsed ||
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      setSelection(null);
      return;
    }

    const exact = liveSelection.toString().trim();
    if (!exact) {
      setSelection(null);
      return;
    }

    const renderedContext = renderedSelectionContext(container, range);
    const mapping = mapAssistantSelectionToSource(
      assistantText,
      renderedText(container),
      exact,
    );
    let prefix = renderedContext.prefix;
    let suffix = renderedContext.suffix;
    if (
      mapping.offset_status === "mapped" &&
      typeof mapping.start_offset === "number" &&
      typeof mapping.end_offset === "number"
    ) {
      prefix =
        assistantText.slice(
          Math.max(0, mapping.start_offset - 80),
          mapping.start_offset,
        ) || null;
      suffix =
        assistantText.slice(mapping.end_offset, mapping.end_offset + 80) || null;
    }

    const fallbackRect = rectSnapshot(container.getBoundingClientRect());
    const rangeRect = range.getBoundingClientRect();
    const rect =
      rangeRect.width > 0 || rangeRect.height > 0
        ? rectSnapshot(rangeRect)
        : fallbackRect;
    const lineRects = Array.from(range.getClientRects())
      .filter((lineRect) => lineRect.width > 0 && lineRect.height > 0)
      .map(rectSnapshot);

    setSelection({
      exact,
      prefix,
      suffix,
      start_offset: mapping.start_offset,
      end_offset: mapping.end_offset,
      offset_status: mapping.offset_status,
      client_selection_id: createRandomId(),
      rect,
      lineRects: lineRects.length > 0 ? lineRects : [rect],
    });
  }, [assistantText, enabled]);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  const branchFromSelection = useCallback(() => {
    if (!selection || !onReplyToAssistant) return;
    onReplyToAssistant(
      assistantSelectionBranchDraft({
        parentMessageId: message.id,
        parentMessageSeq: message.seq,
        parentMessagePreview: assistantText,
        selection,
      }),
    );
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [assistantText, message.id, message.seq, onReplyToAssistant, selection]);

  useEffect(() => {
    setSelection(null);
  }, [enabled, message.id]);

  useEffect(() => {
    if (!selection) return;
    const dismissCollapsedOrExternalSelection = () => {
      const liveSelection = window.getSelection();
      const container = answerRef.current;
      if (!liveSelection || !container || liveSelection.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = liveSelection.getRangeAt(0);
      if (
        liveSelection.isCollapsed ||
        !container.contains(range.startContainer) ||
        !container.contains(range.endContainer)
      ) {
        setSelection(null);
      }
    };
    document.addEventListener("selectionchange", dismissCollapsedOrExternalSelection);
    return () => {
      document.removeEventListener(
        "selectionchange",
        dismissCollapsedOrExternalSelection,
      );
    };
  }, [selection]);

  return {
    answerRef,
    selection,
    captureSelection,
    clearSelection,
    branchFromSelection,
  };
}

function renderedSelectionContext(container: HTMLElement, range: Range) {
  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);

  const after = range.cloneRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);

  const prefix = before.toString().slice(-80) || null;
  const suffix = after.toString().slice(0, 80) || null;
  before.detach();
  after.detach();
  return { prefix, suffix };
}

function renderedText(container: HTMLElement): string {
  return (container.innerText ?? container.textContent ?? "").trim();
}

function rectSnapshot(rect: DOMRect): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height);
}
