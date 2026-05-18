"use client";

import Button from "@/components/ui/Button";
import type { WorkspaceSessionOffer } from "@/lib/workspace/sessionSync";
import styles from "./SessionRestorePrompt.module.css";

interface SessionRestorePromptProps {
  offer: WorkspaceSessionOffer;
  onReopen: () => void;
  onDismiss: () => void;
}

export default function SessionRestorePrompt({
  offer,
  onReopen,
  onDismiss,
}: SessionRestorePromptProps) {
  const count = offer.state.panes.length;
  const tabs = `${count} ${count === 1 ? "tab" : "tabs"}`;
  const message =
    offer.source === "own"
      ? `Reopen your last ${tabs}?`
      : `Pick up ${tabs} from another device?`;

  return (
    <div className={styles.root} role="status">
      <span className={styles.message}>{message}</span>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button variant="primary" size="sm" onClick={onReopen}>
          Reopen
        </Button>
      </div>
    </div>
  );
}
