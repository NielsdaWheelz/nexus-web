"use client";

// The account's one sync status: current state only, closed copy, never a counter
// or event list. A local save failure is repaired beside the affected writing; here it
// is only the current state. Failures add the store's current cause; remote failures
// keep the local fact and announce once.
import { useEffect, useRef } from "react";
import { Check, CircleAlert, CloudOff, LoaderCircle } from "lucide-react";
import type { SyncStatus } from "@nexus/authored/types";
import Button from "@/components/ui/Button";
import { useFeedback } from "@/components/feedback/Feedback";
import { useAuthoredStatus, useAuthoredSyncDetail } from "@/lib/authored/provider";
import { STATUS_COPY } from "@/lib/authored/status";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./AccountMenu.module.css";

const SAVED_ON_DEVICE = "changes are saved on this device.";
const DETAIL: Record<SyncStatus, string | null> = {
  preparing: null, saving: null, offline: SAVED_ON_DEVICE, syncing: null, current: null,
  sign_in_required: SAVED_ON_DEVICE, update_required: SAVED_ON_DEVICE, local_error: null, sync_error: SAVED_ON_DEVICE,
};
const ICONS: Record<SyncStatus, typeof Check> = {
  preparing: LoaderCircle, saving: LoaderCircle, offline: CloudOff, syncing: LoaderCircle, current: Check,
  sign_in_required: CircleAlert, update_required: CircleAlert, local_error: CircleAlert, sync_error: CircleAlert,
};
const REMOTE_FAILURES: ReadonlySet<SyncStatus> = new Set(["sign_in_required", "update_required", "sync_error"]);

/** The supporting lines under a status: its local fact, then a failure's current cause. */
function details(status: SyncStatus, cause: string | null): readonly string[] {
  const failed = status === "local_error" || REMOTE_FAILURES.has(status);
  return [DETAIL[status], failed ? cause : null].filter(line => line !== null);
}

/** The status sentence an account trigger is described by. */
export function syncStatusText(status: SyncStatus, cause: string | null): string {
  const lines = details(status, cause);
  return lines.length === 0 ? STATUS_COPY[status] : `${STATUS_COPY[status]}. ${lines.join(" ")}`;
}

/** The account menu's fixed status row. Credential repair belongs inside this
 * status, so saving and auth transitions never change the menu's membership. */
export function syncStatusOption(status: SyncStatus, cause: string | null, auth: { onSignIn: () => void; busy: boolean }): ActionDescriptor {
  const Icon = ICONS[status];
  return {
    kind: "custom",
    id: "sync-status",
    label: "sync status",
    render: ({ closeMenu, presentation }) => <div className={styles.status} data-failed={Icon === CircleAlert || undefined}>
      <Icon size={16} className={styles.statusIcon} aria-hidden="true" />
      <span className={styles.statusText}>
        <span>{STATUS_COPY[status]}</span>
        {details(status, cause).map(line => <span key={line} className={styles.statusDetail}>{line}</span>)}
        {status === "sign_in_required" ? <Button
          role={presentation === "menu" ? "menuitem" : undefined}
          tabIndex={presentation === "menu" ? -1 : 0}
          disabled={auth.busy}
          onClick={() => { closeMenu(); auth.onSignIn(); }}
        >sign in</Button> : null}
      </span>
    </div>,
  };
}

/** Mounted once per account: entering a remote failure is reported once, never success.
 * Local saving and local errors outrank it without ending it; leaving it retracts the
 * report if it is still waiting or shown. */
export function SyncFailureReceipt() {
  const status = useAuthoredStatus();
  const cause = useAuthoredSyncDetail();
  const feedback = useFeedback();
  const reported = useRef<{ status: SyncStatus; retract: () => void } | null>(null);
  useEffect(() => {
    if (status === "saving" || status === "local_error" || reported.current?.status === status) return;
    reported.current?.retract();
    reported.current = REMOTE_FAILURES.has(status)
      ? { status, retract: feedback.receipt({ tone: "Warning", title: STATUS_COPY[status], message: details(status, cause).join(" ") }) }
      : null;
    // The cause accompanies an entered failure; a later cause alone is not a new failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: one report per entered status
  }, [feedback, status]);
  return null;
}
