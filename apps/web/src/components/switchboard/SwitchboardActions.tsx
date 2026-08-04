"use client";

import { ArrowLeft } from "lucide-react";
import type { MouseEvent } from "react";
import { useResourceActionCatalogProjection } from "@/lib/actions/resourceActionRuntime";
import type {
  NexusAction,
  NexusEntry,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./switchboard.module.css";

/**
 * The full-screen actions list for a NON-resource entry: its own local
 * NexusAction secondaries (panes, continuations), activated through the shared
 * mobile Nexus dispatcher.
 */
function SwitchboardNexusActions({
  entry,
  onSelect,
  onUnavailable,
}: {
  entry: NexusEntry;
  onSelect(
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
    entry: NexusEntry,
  ): void;
  onUnavailable(reason: string): void;
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
  );
}

/**
 * The full-screen actions list for a canonical resource entry. It renders the
 * SAME catalog projection the resource dropdown shows for `target` — the shared
 * planner owns membership, order, and dispatch (each descriptor's port fires
 * only on selection). Navigating actions (Open, Chat) route through the
 * Nexus-unaware runtime, which the controller observes to dismiss the Nexus.
 */
function SwitchboardResourceActions({
  target,
}: {
  target: ResourceActionSubject;
}) {
  const model = useResourceActionCatalogProjection(target);
  return (
    <ul className={styles.rows}>
      {model.descriptors.map((descriptor) => (
        <li key={descriptor.id} className={styles.row}>
          <SwitchboardResourceActionItem descriptor={descriptor} />
        </li>
      ))}
    </ul>
  );
}

function SwitchboardResourceActionItem({
  descriptor,
}: {
  descriptor: ActionDescriptor;
}) {
  const disabled = descriptor.kind !== "custom" && descriptor.disabled === true;
  const disabledReason =
    descriptor.kind !== "custom" ? descriptor.disabledReason : undefined;
  const body = (
    <>
      <span className={styles.rowIcon} aria-hidden="true">
        {descriptor.icon}
      </span>
      <span className={styles.rowBody}>
        <span className={styles.rowLabel}>{descriptor.label}</span>
        {disabled && disabledReason ? (
          <span className={styles.rowUnavailable}>{disabledReason}</span>
        ) : null}
      </span>
    </>
  );
  const ariaLabel =
    disabled && disabledReason
      ? `${descriptor.label}. Unavailable. ${disabledReason}`
      : undefined;

  if (descriptor.kind === "link") {
    return (
      <a
        className={styles.rowMain}
        href={disabled ? undefined : descriptor.href}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          descriptor.onSelect?.({ triggerEl: null });
        }}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={styles.rowMain}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (disabled || descriptor.kind === "custom") return;
        descriptor.onSelect({ triggerEl: event.currentTarget });
      }}
    >
      {body}
    </button>
  );
}

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
      {entry.resourceTarget ? (
        <SwitchboardResourceActions target={entry.resourceTarget} />
      ) : (
        <SwitchboardNexusActions
          entry={entry}
          onSelect={onSelect}
          onUnavailable={onUnavailable}
        />
      )}
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
