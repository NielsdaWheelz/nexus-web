"use client";

import { useState } from "react";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import ActionBar from "@/components/ui/ActionBar";
import ActionMenu from "@/components/ui/ActionMenu";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { buildHighlightActions } from "./highlightActions";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";

type HighlightMutationOperation = "ChangeColor" | "Delete";

function highlightMutationErrorMessage(
  error: unknown,
  operation: HighlightMutationOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title:
          operation === "ChangeColor"
            ? "Couldn't change the highlight color"
            : "Couldn't delete the highlight",
        message: "Check your connection and try again.",
        requestId: error.requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title:
          operation === "ChangeColor"
            ? "Couldn't change the highlight color"
            : "Couldn't delete the highlight",
        message: "Please wait a moment, then try again.",
        requestId: error.requestId,
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This highlight is no longer available",
        message: "Refresh the reader to see the latest highlights.",
        requestId: error.requestId,
      };
    case "E_MEDIA_NOT_FOUND":
      return {
        tone: "Danger",
        title: "This highlight's source is no longer available",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

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
  const [contractDefect, setContractDefect] = useState<{
    error: unknown;
  } | null>(null);

  const selectColor = async (color: HighlightColor) => {
    if (changingColor) return;
    setChangingColor(true);
    try {
      await props.onSelectColor(color);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        feedback.publish({
          kind: "Hud",
          content: highlightMutationErrorMessage(error, "ChangeColor"),
          actions: [
            {
              label: "Retry",
              onClick: () => void selectColor(color),
            },
          ],
        });
      } catch (defect) {
        setContractDefect({ error: defect });
      }
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
      try {
        feedback.publish({
          kind: "Hud",
          content: highlightMutationErrorMessage(error, "Delete"),
          actions: [
            {
              label: "Retry",
              onClick: () => void deleteHighlight(),
            },
          ],
        });
      } catch (defect) {
        setContractDefect({ error: defect });
      }
    } finally {
      setDeleting(false);
    }
  };

  if (contractDefect !== null) throw contractDefect.error;

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
