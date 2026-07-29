"use client";

import type { RetainedActivation } from "@/lib/nexus/model";
import styles from "./switchboard.module.css";

function completionLabel(retained: RetainedActivation): string {
  if (retained.completion.kind === "Absent") {
    return "Your destination is ready to open.";
  }
  switch (retained.completion.value.kind) {
    case "TodayCapture":
      return "Your note was saved.";
    case "Page":
      return "Your page was created.";
    case "Library":
      return "Your library was created.";
    case "Import":
      return "Your import completed.";
    case "PodcastSubscription":
      return "Your podcast was subscribed.";
  }
}

export default function SwitchboardRecovery({
  retained,
  onManageTabs,
  onOpen,
  onCancel,
}: {
  retained: RetainedActivation;
  onManageTabs: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          Tab limit reached
        </h2>
      </header>
      <p>{completionLabel(retained)} Close a tab, then open it.</p>
      <div className={styles.recoveryActions}>
        <button type="button" onClick={onManageTabs}>
          Manage tabs
        </button>
        <button type="button" onClick={onOpen}>
          Open
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
