"use client";

import { ArrowLeft } from "lucide-react";
import type {
  NexusAction,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import styles from "./Nexus.module.css";

export default function ChooseCreatePage({
  initialDraft,
  actions,
  onBack,
  onSelect,
  onUnavailable,
}: {
  readonly initialDraft: string;
  readonly actions: readonly NexusAction[];
  readonly onBack: () => void;
  readonly onSelect: (
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
  ) => void;
  readonly onUnavailable: (reason: string) => void;
}) {
  return (
    <section className={styles.workflowPage}>
      <header className={styles.workflowHeader}>
        <button type="button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <h2 tabIndex={-1} data-switchboard-heading>
            Create “{initialDraft}”
          </h2>
          <p>Choose where this draft belongs.</p>
        </div>
      </header>
      <div className={styles.workflowChoices}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              aria-disabled={action.availability.kind === "Unavailable" || undefined}
              onClick={(event) => {
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
                );
              }}
            >
              <Icon size={18} aria-hidden="true" />
              <span>
                {action.label}
                {action.availability.kind === "Unavailable" ? (
                  <small>{action.availability.reason}</small>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
