"use client";

import { useCallback, useMemo, useRef } from "react";
import Button from "@/components/ui/Button";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { MediaId } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./LecternAddControl.module.css";

/** An inspected add action, or current membership; an unresolved command wins. */
export default function LecternAddControl({
  mediaId, title, returnFocus,
}: {
  mediaId: MediaId;
  title: string;
  returnFocus: () => HTMLElement | null;
}) {
  const subject = useMemo(
    () => ({ ref: canonicalResourceRef({ scheme: "media", id: mediaId }) }),
    [mediaId],
  );
  const model = useResourceActionMenuModel(subject);
  const request = useLectern().ensureRequests.get(mediaId);
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
  if (model.status === "Loading" || model.status === "Refreshing")
    return <span className={styles.quiet}>checking lectern…</span>;
  if (model.status === "Error") {
    const retry = model.descriptors.find((action) => action.id === "ResourceActionSnapshot.Retry");
    return (
      <span className={styles.control}>
        <span className={styles.quiet}>couldn’t check lectern</span>
        <Button
          ref={controlRef}
          className={styles.button}
          variant="ghost"
          size="sm"
          aria-label={`retry lectern check for ${title}`}
          aria-disabled={retry?.disabled || undefined}
          aria-busy={retry?.disabled || undefined}
          onClick={(event) => {
            if (retry?.kind === "command" && !retry.disabled)
              retry.onSelect({ triggerEl: event.currentTarget });
          }}
        >retry</Button>
      </span>
    );
  }
  const membership = model.capabilities.find((capability) => capability.kind === "LecternMembership");
  if (!membership) return null;
  if (membership.state === "Present") return <span className={styles.quiet}>on lectern</span>;
  const action = model.descriptors.find((descriptor) => descriptor.id === "RelationshipAction.LecternMembership");
  if (action?.kind !== "command") return null;
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
