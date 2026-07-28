"use client";

import { ArrowLeft } from "lucide-react";
import type { LauncherAction } from "@/lib/launcher/model";
import styles from "./switchboard.module.css";

export default function SwitchboardActions({
  label,
  actions,
  onBack,
  onSelect,
}: {
  label: string;
  actions: readonly LauncherAction[];
  onBack: () => void;
  onSelect: (action: LauncherAction) => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className={styles.srOnly}>Back</span>
        </button>
        <h2 tabIndex={-1} data-switchboard-heading>
          {label}
        </h2>
      </header>
      <ul className={styles.rows}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <li key={action.id} className={styles.row}>
              <button
                type="button"
                className={styles.rowMain}
                onClick={() => onSelect(action)}
              >
                <Icon size={18} aria-hidden="true" />
                <span className={styles.rowLabel}>{action.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
