/**
 * SelectionPopover - Selection actions for highlight and chat destinations.
 *
 * Appears when the user selects text in a reader. The shared floating surface
 * owns collision-aware placement; the dock owns action presentation and focus.
 * Actions that need a persisted highlight create it first, then continue with
 * that exact highlight (this component owns and serializes that sequencing).
 * Dismisses on Escape, click outside, or selection collapse.
 */

"use client";

import { useCallback, useRef, useState } from "react";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import SelectionActionDock, {
  type SelectionPendingActionId,
} from "@/components/highlights/SelectionActionDock";
import {
  buildHighlightActions,
  projectSelectionActionPlan,
} from "@/components/highlights/highlightActions";
import styles from "./SelectionPopover.module.css";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import {
  useContainingModalLayer,
  useIsModalLayerTopmost,
} from "@/lib/ui/useModalLayer";

interface SelectionPopoverBaseProps<H extends { id: string }> {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => Promise<H | null>;
  onAddNote?: () => void;
  onLink?: () => void;
  onLearn?: (highlight: H) => void | Promise<void>;
  onDismiss: () => void;
  isCreating?: boolean;
}

type SelectionPopoverChatProps<H extends { id: string }> =
  | {
      onQuoteToNewChat: (highlight: H) => void | Promise<void>;
      onQuoteToExistingChat: (highlight: H) => void | Promise<void>;
    }
  | {
      onQuoteToNewChat?: never;
      onQuoteToExistingChat?: never;
    };

type SelectionPopoverProps<H extends { id: string }> =
  SelectionPopoverBaseProps<H> & SelectionPopoverChatProps<H>;

export const DEFAULT_COLOR: HighlightColor = "yellow";

export default function SelectionPopover<H extends { id: string }>({
  selectionRect,
  selectionLineRects,
  containerRef,
  onCreateHighlight,
  onQuoteToNewChat,
  onQuoteToExistingChat,
  onAddNote,
  onLink,
  onLearn,
  onDismiss,
  isCreating = false,
}: SelectionPopoverProps<H>) {
  const { openShare } = useShareController();
  const modalToken = useContainingModalLayer();
  const modalIsTopmost = useIsModalLayerTopmost(modalToken);
  const actionLockRef = useRef(false);
  const [pendingActionId, setPendingActionId] =
    useState<SelectionPendingActionId | null>(null);
  const actionBusy = isCreating || pendingActionId !== null;
  useHistoryDismiss(
    true,
    () => {
      window.getSelection()?.removeAllRanges();
      onDismiss();
    },
    { isTopmost: modalIsTopmost },
  );
  const chatDestinations =
    onQuoteToNewChat && onQuoteToExistingChat
      ? {
          newChat: onQuoteToNewChat,
          existingChat: onQuoteToExistingChat,
        }
      : null;

  const runHighlightFirst = useCallback(
    (
      actionId: SelectionPendingActionId,
      color: HighlightColor,
      afterCreate?: (highlight: H) => void | Promise<void>,
    ) => {
      if (isCreating || actionLockRef.current) return;
      actionLockRef.current = true;
      setPendingActionId(actionId);
      void (async () => {
        try {
          const highlight = await onCreateHighlight(color);
          if (highlight && afterCreate) await afterCreate(highlight);
        } finally {
          actionLockRef.current = false;
          setPendingActionId(null);
        }
      })();
    },
    [isCreating, onCreateHighlight],
  );

  const quoteHighlight = useCallback(
    (
      actionId: "quote-new" | "quote-existing",
      quote: (highlight: H) => void | Promise<void>,
    ) => {
      runHighlightFirst(actionId, DEFAULT_COLOR, quote);
    },
    [runHighlightFirst],
  );
  const shareHighlight = useCallback(
    (triggerEl: HTMLButtonElement | null) => {
      runHighlightFirst("share", DEFAULT_COLOR, (highlight) => {
        openShare(
          resourceShareTarget(`highlight:${highlight.id}`),
          anchoredShareOpenOptions(triggerEl, () =>
            document.querySelector<HTMLElement>(
              `[data-highlight-anchor="${CSS.escape(highlight.id)}"]`,
            ),
          ),
        );
      });
    },
    [openShare, runHighlightFirst],
  );
  const learnHighlight = onLearn
    ? () => runHighlightFirst("learn", DEFAULT_COLOR, onLearn)
    : undefined;
  const chatHandlers = chatDestinations
    ? {
        onQuoteToNewChat: () =>
          quoteHighlight("quote-new", chatDestinations.newChat),
        onQuoteToExistingChat: () =>
          quoteHighlight("quote-existing", chatDestinations.existingChat),
      }
    : {};

  const plan = projectSelectionActionPlan(
    buildHighlightActions({
      target: { kind: "selection", color: DEFAULT_COLOR },
      canQuoteToChat: chatDestinations !== null,
      canAddNote: Boolean(onAddNote),
      isReflowable: false,
      state: {
        isEditingBounds: false,
        deleting: false,
        changingColor: actionBusy,
      },
      handlers: {
        onSelectColor: (color) => runHighlightFirst("color", color),
        onAddNote,
        onLink,
        onShare: ({ triggerEl }) => shareHighlight(triggerEl),
        onLearn: learnHighlight,
        ...chatHandlers,
        onToggleEditBounds: () => {},
        onDelete: () => {},
      },
    }),
  );

  return (
    <FloatingActionSurface
      open
      anchor={selectionRect}
      strategy="text-selection"
      lineRects={selectionLineRects}
      boundary={containerRef.current}
      className={styles.popover}
      preservePointerSelection
      onDismiss={onDismiss}
    >
      <SelectionActionDock
        plan={plan}
        pendingActionId={pendingActionId}
        externalBusy={isCreating && pendingActionId === null}
      />
    </FloatingActionSurface>
  );
}
