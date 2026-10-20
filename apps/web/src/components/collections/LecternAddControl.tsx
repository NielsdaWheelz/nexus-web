"use client";

import { useCallback, useId, useRef } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useLecternAddAction } from "@/lib/actions/ResourceActionsProvider";
import { assertNever } from "@/lib/assertNever";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import styles from "./LecternAddControl.module.css";

/** The runtime owns membership and recovery; this leaf reserves the add's footprint. */
export default function LecternAddControl({
  mediaId, title, returnFocus,
}: {
  mediaId: string;
  title: string;
  returnFocus: () => HTMLElement | null;
}) {
  const state = useLecternAddAction({ mediaId, title });
  const reasonId = useId();
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  // Cache updates can remove this leaf's button without rendering its collection.
  // A stable ref cleanup checks ownership at removal, never before awaiting.
  const controlRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement !== button) return;
      const target = returnFocusRef.current();
      if (target?.isConnected && !target.closest("[inert]"))
        target.focus({ preventScroll: true });
    };
  }, []);

  switch (state.kind) {
    case "Loading":
      return <div className={styles.control}>
        <FeedbackStatus content={{ tone: "Neutral", title: "checking lectern…" }} announcement="None" />
      </div>;
    case "Failed":
      return (
        <div className={styles.control}>
          <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check lectern" }} announcement="Polite"
            actions={[{ label: "retry", onClick: state.retry, busy: state.busy }]} returnFocus={returnFocus} />
        </div>
      );
    case "Present":
      return <div className={styles.control}>
        <span className={styles.surface}>
          <span className={styles.label}>
            <span className={styles.sizer} aria-hidden>add to lectern</span>
            <span>on lectern</span>
          </span>
        </span>
      </div>;
    case "Action": {
      const { action, busy, pending } = state;
      const label = pending?.intent === "Ensure" && pending.phase === "Sending"
        ? "add to lectern" : action.label;
      return (
        <div className={styles.control}>
          <Button
            ref={controlRef}
            className={`${styles.surface} ${styles.button}`}
            variant="secondary"
            size="sm"
            aria-label={`${label}: ${title}`}
            aria-busy={busy || undefined}
            aria-disabled={action.disabled || undefined}
            aria-describedby={action.disabledReason ? reasonId : undefined}
            onClick={(event) => {
              if (action.disabled) return;
              const detail = prepareActionSelect(event, event.currentTarget);
              if (detail) action.onSelect(detail);
            }}
            onKeyDown={(event) => {
              if (action.disabled) return;
              const detail = prepareActionSelect(event, event.currentTarget);
              if (detail) action.onSelect(detail);
            }}
          >
            <span className={styles.label}>
              <span className={styles.sizer} aria-hidden>add to lectern</span>
              <span>{label}</span>
            </span>
          </Button>
          {action.disabledReason ? (
            <span id={reasonId} className="sr-only">{action.disabledReason}</span>
          ) : null}
        </div>
      );
    }
    default:
      return assertNever(state, "Unsupported lectern add presentation");
  }
}
