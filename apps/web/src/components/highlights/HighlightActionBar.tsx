"use client";

import { useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import ActionBar from "@/components/ui/ActionBar";
import ActionMenu from "@/components/ui/ActionMenu";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { buildHighlightActions } from "./highlightActions";

type ExistingProps = {
  variant: "existing";
  presentation: "bar" | "menu";
  highlight: AnchoredHighlightRow;
  canQuoteToChat: boolean;
  canAddNote?: boolean;
  isReflowable: boolean;
  isEditingBounds: boolean;
  onSelectColor: (color: HighlightColor) => Promise<void>;
  onAddNote?: () => void;
  onDelete: () => Promise<void>;
  onQuoteToNewChat: () => void;
  onQuoteToExistingChat: () => void;
  onToggleEditBounds: () => void;
  className?: string;
};

type SelectionProps = {
  variant: "selection";
  selectionColor: HighlightColor;
  canQuoteToChat: boolean;
  canAddNote?: boolean;
  busy: boolean;
  onSelectColor: (color: HighlightColor) => void;
  onAddNote?: () => void;
  onQuoteToNewChat: () => void;
  onQuoteToExistingChat: () => void;
  className?: string;
};

/**
 * The only widget a surface mounts to show highlight actions. Delegates the
 * descriptor set to {@link buildHighlightActions} and the rendering to
 * {@link ActionBar}. The existing variant owns the confirm + spinner state for
 * delete/color so every surface shares one copy; the selection variant creates
 * instead and reports busy from its caller (and needs no feedback wiring).
 */
export default function HighlightActionBar(props: ExistingProps | SelectionProps) {
  return props.variant === "existing" ? (
    <ExistingActionBar {...props} />
  ) : (
    <SelectionActionBar {...props} />
  );
}

function SelectionActionBar(props: SelectionProps) {
  const options = buildHighlightActions({
    target: { kind: "selection", color: props.selectionColor },
    canQuoteToChat: props.canQuoteToChat,
    canAddNote: props.canAddNote ?? false,
    isReflowable: false,
    state: { isEditingBounds: false, deleting: false, changingColor: props.busy },
    handlers: {
      onSelectColor: props.onSelectColor,
      onAddNote: props.onAddNote,
      onQuoteToNewChat: props.onQuoteToNewChat,
      onQuoteToExistingChat: props.onQuoteToExistingChat,
      onToggleEditBounds: () => {},
      onDelete: () => {},
    },
  });
  return <ActionBar options={options} label="Highlight actions" className={props.className} />;
}

function ExistingActionBar(props: ExistingProps) {
  const feedback = useFeedback();
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
