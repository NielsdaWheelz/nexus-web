"use client";

import { RotateCcw, Save, Trash2 } from "lucide-react";
import type { NoteEditorSessionStatus } from "@/lib/notes/useNoteEditorSession";
import Button from "@/components/ui/Button";
import styles from "./NoteDraftRecovery.module.css";

export default function NoteDraftRecovery({
  status,
  hasRecoveredDraft,
  onRetry,
  onDiscard,
}: {
  status: NoteEditorSessionStatus;
  hasRecoveredDraft: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const isFailed = status === "failed";
  if (!isFailed && !hasRecoveredDraft) {
    return null;
  }

  const label = isFailed ? "Save failed" : "Recovered unsaved changes";
  const retryLabel = isFailed ? "Retry" : "Save";

  return (
    <div
      className={styles.recovery}
      data-state={isFailed ? "failed" : "recovered"}
      role={isFailed ? "alert" : "status"}
      aria-live="polite"
    >
      <span className={styles.message}>{label}</span>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leadingIcon={
            isFailed ? (
              <RotateCcw size={14} aria-hidden="true" />
            ) : (
              <Save size={14} aria-hidden="true" />
            )
          }
        >
          {retryLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          leadingIcon={<Trash2 size={14} aria-hidden="true" />}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}
