"use client";

import { ArrowLeft } from "lucide-react";
import type { MouseEvent } from "react";
import type {
  NexusAction,
  NexusEntry,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import styles from "./switchboard.module.css";

export default function SwitchboardActions({
  entry,
  onBack,
  onSelect,
  onUnavailable,
  unavailableAnnouncement,
}: {
  entry: NexusEntry;
  onBack: () => void;
  onSelect(
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
    entry: NexusEntry,
  ): void;
  onUnavailable(reason: string): void;
  unavailableAnnouncement: string;
}) {
  const select = (
    action: NexusAction,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (action.availability.kind === "Unavailable") {
      onUnavailable(action.availability.reason);
      return;
    }
    onSelect(
      action,
      {
        disposition: { kind: "Follow" },
        modality: event.detail === 0 ? "Keyboard" : "Pointer",
      },
      event.currentTarget,
      entry,
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className={styles.srOnly}>Back</span>
        </button>
        <h2 tabIndex={-1} data-switchboard-heading>
          {entry.label}
        </h2>
      </header>
      <ul className={styles.rows}>
        {entry.secondaryActions.map((action) => {
          const Icon = action.icon;
          const unavailable =
            action.availability.kind === "Unavailable"
              ? action.availability.reason
              : null;
          return (
            <li key={action.id} className={styles.row}>
              <button
                type="button"
                className={styles.rowMain}
                aria-disabled={unavailable !== null || undefined}
                aria-label={
                  unavailable === null
                    ? undefined
                    : `${action.label}. Unavailable. ${unavailable}`
                }
                onClick={(event) => select(action, event)}
              >
                <span className={styles.rowIcon} aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className={styles.rowBody}>
                  <span className={styles.rowLabel}>{action.label}</span>
                  {unavailable !== null ? (
                    <span className={styles.rowUnavailable}>{unavailable}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div
        className={styles.liveRegion}
        role="status"
        aria-label="Nexus status"
        aria-live="polite"
      >
        {unavailableAnnouncement}
      </div>
    </div>
  );
}
