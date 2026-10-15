"use client";

import { useCallback, useEffect, useRef } from "react";
import Button from "@/components/ui/Button";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import type { MediaId } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import styles from "./LecternAddControl.module.css";

/**
 * An inspected add action, or current membership; an unresolved command wins.
 * The media's verbs are read on mount and again whenever its lectern
 * membership changes, so only a fresh read says present or absent.
 */
export default function LecternAddControl({
  mediaId, title, returnFocus,
}: {
  mediaId: MediaId;
  title: string;
  returnFocus: () => HTMLElement | null;
}) {
  const { options, onOpenChange } = useResourceActionMenu(`media:${mediaId}`);
  const { resource, ensureRequests } = useLectern();
  const request = ensureRequests.get(mediaId);
  const member =
    resource.status === "ready" &&
    resource.data.items.some((item) => item.mediaSummary.media_id === mediaId);
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
      <span className={styles.control}>
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
          <span className={styles.quiet} role="status">checking the add…</span>
        ) : null}
      </span>
    );
  }
  if (options[0]?.id === "ResourceActions.Loading")
    return <span className={styles.quiet}>checking lectern…</span>;
  if (options[0]?.id === "ResourceActions.Failed") {
    return (
      <span className={styles.control}>
        <span className={styles.quiet}>couldn’t check lectern</span>
        <Button
          ref={controlRef}
          className={styles.button}
          variant="ghost"
          size="sm"
          aria-label={`retry lectern check for ${title}`}
          onClick={() => onOpenChange(true)}
        >retry</Button>
      </span>
    );
  }
  const action = options.find((descriptor) => descriptor.id === "LecternMembership");
  if (action?.kind !== "command") return null;
  if (action.state?.kind === "toggle" && action.state.pressed)
    return <span className={styles.quiet}>on lectern</span>;
  return (
    <span className={styles.control}>
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
    </span>
  );
}
