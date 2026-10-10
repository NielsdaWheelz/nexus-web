"use client";

import { useRef, useState, type ComponentProps } from "react";
import { ListMinus } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  FeedbackNotice,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ConnectionMutation } from "@/lib/resourceGraph/links";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

const UNDO_ASSISTANT = {
  id: "ContextEdgeAction.Assistant.Undo",
  label: "Undo assistant link",
  busyLabel: "Undoing…",
};

/** Menu item copy per server-named edge mutation. */
const EDGE_ACTIONS: Record<
  ConnectionMutation["kind"],
  { id: string; label: string; busyLabel: string }
> = {
  unlink: {
    id: "ContextEdgeAction.Connection.Unlink",
    label: "Remove link",
    busyLabel: "Removing…",
  },
  dismiss_discovery: {
    id: "ContextEdgeAction.Connection.Dismiss",
    label: "Dismiss link",
    busyLabel: "Dismissing...",
  },
  detach_context: {
    id: "ContextEdgeAction.Context.Remove",
    label: "Remove from chat",
    busyLabel: "Removing...",
  },
  undo_assistant_chat: UNDO_ASSISTANT,
  undo_assistant_generation: UNDO_ASSISTANT,
};

/**
 * The separate control that owns context-edge commands — remove from
 * conversation context, unlink a connection edge, or dismiss a discovery edge.
 * These are edge mutations, NOT resource-snapshot facts, so they never enter the
 * canonical `ResourceActionMenu`: they publish through this dedicated,
 * distinctly-labelled trigger + one-item menu. Busy and expected-error feedback
 * are local to the edge mutation. The control holds its own in-flight lock,
 * maps a failure to feedback through the caller's domain adapter, and propagates
 * any same-system defect (via `presentFailure` throwing) to the nearest boundary.
 */
export default function ContextEdgeMenu({
  mutationKind,
  execute,
  presentFailure,
  label,
  retryable = false,
}: {
  readonly mutationKind: ConnectionMutation["kind"];
  /**
   * Runs the server-declared owning mutation. Any post-mutation reload is the
   * caller's own — this control never touches the resource snapshot cache.
   */
  readonly execute: () => Promise<void>;
  /**
   * Map an expected failure to feedback copy for THIS surface's domain; THROW to
   * escalate a same-system defect / unknown error to the nearest error boundary.
   */
  readonly presentFailure: (error: unknown) => FeedbackContent;
  /** Trigger accessible label. */
  readonly label: string;
  /** Offer a Retry affordance on the failure notice. */
  readonly retryable?: boolean;
}) {
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  async function run() {
    if (busyRef.current) return;
    // Both menu selection and Retry return to the trigger before the feedback
    // or row can disappear. The row owner moves focus when removal succeeds.
    triggerRef.current?.focus();
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

  const entry = EDGE_ACTIONS[mutationKind];
  const retryActions: FeedbackActions | undefined = retryable
    ? [{ label: "Retry", onClick: () => void run() }]
    : undefined;

  // The action's own icon (not the "…" overflow glyph) keeps this edge control
  // visually distinct from the adjacent canonical resource menu.
  const iconTrigger: ActionMenuProps["renderTrigger"] = (triggerProps) => (
    <button {...triggerProps}>
      <ListMinus size={16} aria-hidden="true" />
    </button>
  );

  return (
    <>
      <ActionMenu
        options={[
          {
            kind: "command",
            id: entry.id,
            label: busy ? entry.busyLabel : entry.label,
            icon: <ListMinus size={14} aria-hidden="true" />,
            disabled: busy || undefined,
            disabledReason: busy ? "Working…" : undefined,
            onSelect: () => void run(),
            restoreFocusOnClose: false,
          },
        ]}
        label={label}
        renderTrigger={iconTrigger}
        triggerRef={(node) => { triggerRef.current = node; }}
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
