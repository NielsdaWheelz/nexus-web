"use client";

import { useRef, useState } from "react";
import { ListMinus } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ConnectionMutation } from "@/lib/resourceGraph/links";
import styles from "./ContextEdgeMenu.module.css";

const EDGE_ACTIONS: Record<
  ConnectionMutation["kind"],
  { readonly id: string; readonly label: string; readonly busyLabel: string }
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
  undo_assistant_write: {
    id: "ContextEdgeAction.Assistant.Undo",
    label: "Undo assistant link",
    busyLabel: "Undoing…",
  },
};

/**
 * The one-item menu for an edge mutation the server named on a row (unlink,
 * dismiss, remove from chat, undo an assistant link). It is not a resource
 * verb: it holds its own busy lock and failure notice; `presentFailure` maps
 * an expected failure to copy and throws a defect to the nearest boundary.
 */
export default function ContextEdgeMenu({
  mutationKind,
  execute,
  presentFailure,
  label,
  retryable = false,
}: {
  readonly mutationKind: ConnectionMutation["kind"];
  /** The mutation; any reload afterwards is the caller's. */
  readonly execute: () => Promise<void>;
  readonly presentFailure: (error: unknown) => FeedbackContent;
  readonly label: string;
  readonly retryable?: boolean;
}) {
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  async function run() {
    if (busyRef.current) return;
    // Back to the trigger before the notice or the row can disappear.
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
        // Its own icon, not "…": distinct from the resource menu beside it.
        renderTrigger={(props) => (
          <button {...props} className={styles.trigger}>
            <ListMinus size={16} aria-hidden="true" />
          </button>
        )}
        triggerRef={(node) => {
          triggerRef.current = node;
        }}
      />
      {feedback ? (
        <FeedbackNotice
          content={feedback}
          announcement="Assertive"
          actions={
            retryable ? [{ label: "Retry", onClick: () => void run() }] : undefined
          }
        />
      ) : null}
    </>
  );
}
