"use client";

// The on-demand account row shows current sync state and its verified local fact.
// The authored account adapter owns persistent recovery and failure announcements.
import { Check, CircleAlert, CloudOff, LoaderCircle, LogIn } from "lucide-react";
import type { SyncStatus } from "@nexus/authored/types";
import Button from "@/components/ui/Button";
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

/** The supporting lines under a status: its local fact, then current preparation
 * progress or the failure's cause. Account-current still requires full scope. */
function details(status: SyncStatus, cause: string | null): readonly string[] {
  const failed = status === "local_error" || REMOTE_FAILURES.has(status);
  return [DETAIL[status], failed || status === "syncing" ? cause : null].filter(line => line !== null);
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
      <Icon size={16} className={styles.statusIcon} data-busy={Icon === LoaderCircle || undefined} aria-hidden="true" />
      <span className={styles.statusText}>
        <span>{STATUS_COPY[status]}</span>
        {details(status, cause).map((line, index) => <span key={index} className={styles.statusDetail} data-progress={status === "syncing" || undefined}>{line}</span>)}
        {status === "sign_in_required" ? <Button
          role={presentation === "menu" ? "menuitem" : undefined}
          tabIndex={presentation === "menu" ? -1 : 0}
          disabled={auth.busy}
          onClick={() => { closeMenu(); auth.onSignIn(); }}
          icon={<LogIn size={16} aria-hidden="true" />}
        >Sign in</Button> : null}
      </span>
    </div>,
  };
}
