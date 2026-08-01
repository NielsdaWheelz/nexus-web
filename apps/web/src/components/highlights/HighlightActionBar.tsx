"use client";

import { useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import ActionBar from "@/components/ui/ActionBar";
import ActionMenu from "@/components/ui/ActionMenu";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { buildHighlightActions } from "./highlightActions";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";

type ExistingProps = {
  presentation: "bar" | "menu";
  highlight: AnchoredReaderRow;
  canQuoteToChat: boolean;
  canAddNote?: boolean;
  isReflowable: boolean;
  isEditingBounds: boolean;
  onSelectColor: (color: HighlightColor) => Promise<void>;
  onAddNote?: () => void;
  onLink?: () => void;
  onLearn?: () => void;
  onDelete: () => Promise<void>;
  onQuoteToNewChat: () => void;
  onQuoteToExistingChat: () => void;
  onToggleEditBounds: () => void;
  className?: string;
};

/**
 * The existing-Highlight widget delegates the descriptor set to
 * {@link buildHighlightActions} and renders it as an ActionBar or ActionMenu.
 * It owns the shared confirm and pending state for delete/color.
 */
export default function HighlightActionBar(props: ExistingProps) {
  const feedback = useFeedback();
  const { openShare } = useShareController();
  const [deleting, setDeleting] = useState(false);
  const [changingColor, setChangingColor] = useState(false);

  const selectColor = async (color: HighlightColor) => {
    if (changingColor) return;
    setChangingColor(true);
    try {
      await props.onSelectColor(color);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Failed to change color" }));
      console.error("highlight_color_change_failed", error);
    } finally {
      setChangingColor(false);
    }
  };

  const deleteHighlight = async () => {
    if (deleting || !window.confirm("Delete this highlight?")) return;
    setDeleting(true);
    try {
      await props.onDelete();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Failed to delete highlight" }));
      console.error("highlight_delete_failed", error);
    } finally {
      setDeleting(false);
    }
  };

  const options = buildHighlightActions({
    target: { kind: "existing", highlight: props.highlight },
    canQuoteToChat: props.canQuoteToChat,
    canAddNote: props.canAddNote ?? false,
    isReflowable: props.isReflowable,
    state: { isEditingBounds: props.isEditingBounds, deleting, changingColor },
    handlers: {
      onSelectColor: (color) => void selectColor(color),
      onAddNote: props.onAddNote,
      onLink: props.onLink,
      onShare: ({ triggerEl }) =>
        openShare(
          resourceShareTarget(`highlight:${props.highlight.id}`),
          anchoredShareOpenOptions(triggerEl, () =>
            document.querySelector<HTMLElement>(
              `[data-highlight-anchor="${CSS.escape(props.highlight.id)}"]`,
            ),
          ),
        ),
      onLearn: props.onLearn,
      onQuoteToNewChat: props.onQuoteToNewChat,
      onQuoteToExistingChat: props.onQuoteToExistingChat,
      onToggleEditBounds: props.onToggleEditBounds,
      onDelete: () => void deleteHighlight(),
    },
  });
  return props.presentation === "menu" ? (
    <ActionMenu options={options} label="Highlight actions" className={props.className} />
  ) : (
    <ActionBar options={options} label="Highlight actions" className={props.className} />
  );
}
