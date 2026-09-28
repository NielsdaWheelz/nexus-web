"use client";

import type { NoteEditorSessionStatus } from "@/lib/notes/useNoteEditorSession";
import type { NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import Button from "@/components/ui/Button";
import styles from "./NoteDraftRecovery.module.css";

export default function NoteDraftRecovery({
  status,
  localRetained,
  hasRecoveredDraft,
  conflict,
  onRetry,
  onReapply,
  onDiscard,
  onExport,
}: {
  status: NoteEditorSessionStatus;
  localRetained: boolean;
  hasRecoveredDraft: boolean;
  conflict: { local: NoteBodyValue; remote: NoteBodyValue | null } | null;
  onRetry: () => void;
  onReapply: () => void;
  onDiscard: () => void;
  onExport: () => void;
}) {
  if (status === "clean" || status === "dirty" || status === "saving" || status === "saved") return null;

  const message = status === "storage_failed"
    ? "Changes are only in this tab. Export them before closing."
    : status === "network_failed"
      ? localRetained ? "Couldn’t confirm the save. Changes are on this device. Retry to confirm." : "Changes are only in this tab. Export them before closing."
      : status === "server_failed"
        ? localRetained ? "Couldn’t save. Changes are on this device." : "Couldn’t save. Changes are only in this tab."
        : status === "conflict"
          ? "This note changed elsewhere. Your version is retained below."
          : hasRecoveredDraft ? "Unsaved changes were recovered on this device." : "Unsaved changes are on this device.";

  return (
    <div className={styles.recovery} data-state={status} role={status === "recovered" ? "status" : "alert"}>
      <span className={styles.message}>{message}</span>
      {status === "conflict" && conflict ? (
        <details>
          <summary>Compare versions</summary>
          <p>Your version</p>
          <pre>{conflict.local.bodyText}</pre>
          <p>Saved version</p>
          <pre>{conflict.remote?.bodyText ?? "The saved version could not be loaded yet."}</pre>
        </details>
      ) : null}
      <div className={styles.actions}>
        {status === "conflict" ? (
          conflict?.remote ? <Button variant="secondary" size="sm" onClick={onReapply}>Use my version</Button> : null
        ) : status !== "storage_failed" ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>Retry save</Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onExport}>Export my text</Button>
        {status !== "network_failed" && (status !== "conflict" || conflict?.remote) ? (
          <Button variant="ghost" size="sm" onClick={onDiscard}>Discard my changes</Button>
        ) : null}
      </div>
    </div>
  );
}
