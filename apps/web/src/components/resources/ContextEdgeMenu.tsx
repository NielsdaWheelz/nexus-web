"use client";

import { createElement, useRef, useState, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  FeedbackNotice,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  contextEdgeActionEntry,
  projectContextEdgeAction,
  type ContextEdgeActionKind,
} from "@/lib/actions/contextEdgeActions";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

/**
 * The separate control that owns context-edge commands — remove from
 * conversation context, unlink a connection edge, or dismiss a synapse edge.
 * These are edge mutations, NOT resource-snapshot facts, so they never enter the
 * canonical `ResourceActionMenu`: they publish through this dedicated,
 * distinctly-labelled trigger + one-item menu. Busy and expected-error feedback
 * are local to the edge mutation. The control holds its own in-flight lock,
 * maps a failure to feedback through the caller's domain adapter, and propagates
 * any same-system defect (via `presentFailure` throwing) to the nearest boundary.
 */
export default function ContextEdgeMenu({
  action,
  execute,
  presentFailure,
  label,
  retryable = false,
  align,
  placement,
  renderTrigger,
}: {
  readonly action: ContextEdgeActionKind;
  /**
   * Runs the owning edge mutation (deleteLink / deleteStance /
   * dismissSynapseEdge / removeContextRef). Any post-mutation reload is the
   * caller's own — this control never touches the resource snapshot cache.
   */
  readonly execute: () => Promise<void>;
  /**
   * Map an expected failure to feedback copy for THIS surface's domain; THROW to
   * escalate a same-system defect / unknown error to the nearest error boundary.
   */
  readonly presentFailure: (error: unknown) => FeedbackContent;
  /** Trigger accessible label. Presentation only; defaults to the action copy. */
  readonly label?: string;
  /** Offer a Retry affordance on the failure notice. */
  readonly retryable?: boolean;
  readonly align?: ActionMenuProps["align"];
  readonly placement?: ActionMenuProps["placement"];
  readonly renderTrigger?: ActionMenuProps["renderTrigger"];
}) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await execute();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setFeedback(presentFailure(error));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (defect !== null) throw defect.error;

  const entry = contextEdgeActionEntry(action);
  const descriptor = projectContextEdgeAction({
    kind: action,
    busy,
    onSelect: () => void run(),
  });
  const retryActions: FeedbackActions | undefined = retryable
    ? [{ label: "Retry", onClick: () => void run() }]
    : undefined;

  // Default to the action's own icon (not the "…" overflow glyph) so this edge
  // control is visually distinct from the adjacent canonical resource menu.
  const iconTrigger: ActionMenuProps["renderTrigger"] = (triggerProps) =>
    createElement(
      "button",
      triggerProps,
      createElement(entry.icon, { size: 16, "aria-hidden": true }),
    );

  return (
    <>
      <ActionMenu
        options={[descriptor]}
        label={label ?? entry.triggerLabel}
        align={align}
        placement={placement}
        renderTrigger={renderTrigger ?? iconTrigger}
      />
      {feedback ? (
        <FeedbackNotice
          content={feedback}
          announcement="Assertive"
          actions={retryActions}
        />
      ) : null}
    </>
  );
}
