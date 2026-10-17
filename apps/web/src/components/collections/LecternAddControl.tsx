"use client";

import { useCallback, useEffect, useRef } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { lecternItems, useLectern, useLecternAdds } from "@/lib/lectern/lectern";
import styles from "./LecternAddControl.module.css";

/**
 * An inspected add action, or current membership; an unresolved command wins.
 * The media's verbs are read on mount and again whenever its lectern
 * membership changes, so only a fresh read says present or absent.
 */
export default function LecternAddControl({
  mediaId, title, returnFocus,
}: {
  mediaId: string;
  title: string;
  returnFocus: () => HTMLElement | null;
}) {
  const { options, onOpenChange, retrying } = useResourceActionMenu(`media:${mediaId}`);
  const request = useLecternAdds().adds.get(mediaId);
  const member = lecternItems(useLectern()).some(
    (item) => item.media_summary.media_id === mediaId,
  );
  useEffect(() => {
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [member, onOpenChange]);
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

  if (request) {
    const sending = request.kind === "Sending";
    const busy = request.kind !== "Unconfirmed";
    return (
      <div className={styles.control}>
        <Button
          ref={controlRef}
          className={styles.button}
          variant="secondary"
          size="sm"
          aria-label={sending ? `adding ${title} to lectern` : `check add for ${title}`}
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          onClick={() => { if (request.kind === "Unconfirmed") request.check(); }}
        >
          <span className={styles.label}>
            <span className={styles.sizer} aria-hidden>{sending ? "add to lectern" : "check add"}</span>
            <span>{sending ? "adding…" : "check add"}</span>
          </span>
        </Button>
        {request.kind === "Checking" ? (
          <FeedbackStatus content={{ tone: "Neutral", title: "checking the add…" }} announcement="Polite" />
        ) : null}
      </div>
    );
  }
  if (options[0]?.id === "ResourceActions.Loading")
    return <FeedbackStatus content={{ tone: "Neutral", title: "checking lectern…" }} announcement="None" />;
  if (options[0]?.id === "ResourceActions.Failed") {
    return (
      <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check lectern" }} announcement="Polite"
        actions={[{ label: "retry lectern check", onClick: () => onOpenChange(true), busy: retrying }]}
        returnFocus={returnFocus}
      />
    );
  }
  const action = options.find((descriptor) => descriptor.id === "LecternMembership");
  if (action?.kind !== "command") return null;
  if (action.state?.kind === "toggle" && action.state.pressed)
    return <FeedbackStatus content={{ tone: "Neutral", title: "on lectern" }} announcement="None" />;
  return (
    <div className={styles.control}>
      <Button
        ref={controlRef}
        className={styles.button}
        variant="secondary"
        size="sm"
        aria-label={`add ${title} to lectern`}
        aria-disabled={action.disabled || undefined}
        title={action.disabledReason}
        onClick={(event) => {
          if (!action.disabled) action.onSelect({ triggerEl: event.currentTarget });
        }}
      >
        <span className={styles.label}><span>add to lectern</span></span>
      </Button>
    </div>
  );
}
