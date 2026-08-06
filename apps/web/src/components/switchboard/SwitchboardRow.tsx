"use client";

import { MoreHorizontal } from "lucide-react";
import {
  useEffect,
  useRef,
  type ComponentProps,
  type MouseEvent,
} from "react";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import {
  nexusEntryKeyValue,
  type NexusAction,
  type NexusEntry,
  type NexusTargetActivation,
} from "@/lib/nexus/model";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./switchboard.module.css";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

/**
 * The overflow menu for a canonical resource switchboard row. It renders the
 * SAME catalog projection every other surface shows for `actionSubject`, over the
 * row's own `ActionMenu` trigger — the resource secondary actions come from the
 * shared planner, never a private NexusAction array. The standing trigger is
 * inert until the ref's snapshot is ready, so opening performs no request.
 */
function SwitchboardRowResourceMenu({
  actionSubject,
  menuProps,
}: {
  actionSubject: ResourceActionSubject;
  menuProps: Omit<ActionMenuProps, "options">;
}) {
  const model = useResourceActionMenuModel(actionSubject);
  return (
    <ActionMenu
      options={model.descriptors}
      triggerDisabled={model.triggerDisabled}
      triggerDisabledReason={model.triggerDisabledReason}
      {...menuProps}
    />
  );
}

function openStateLabel(state: NexusEntry["openState"]): string | undefined {
  switch (state) {
    case undefined:
      return undefined;
    case "Active":
      return "Current";
    case "Open":
      return "Open";
    case "Minimized":
      return "Minimized";
  }
}

export default function SwitchboardRow({
  entry,
  active,
  compact = false,
  onActive,
  onActivate,
  onUnavailable,
}: {
  entry: NexusEntry;
  active: boolean;
  compact?: boolean;
  onActive(): void;
  onActivate(
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
    entry: NexusEntry,
  ): void;
  onUnavailable(reason: string): void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const menuModalityRef = useRef<NexusTargetActivation["modality"]>("Pointer");
  const Icon = entry.icon;
  const nested =
    entry.parent !== undefined &&
    nexusEntryKeyValue(entry.parent.key) !== nexusEntryKeyValue(entry.key);
  const secondary = [
    entry.typeLabel,
    entry.metadata,
    openStateLabel(entry.openState),
  ]
    .filter(
      (fact, index, all): fact is string =>
        Boolean(fact) && all.indexOf(fact) === index,
    )
    .join(" · ");
  const primaryUnavailable =
    entry.primaryAction.availability.kind === "Unavailable"
      ? entry.primaryAction.availability.reason
      : null;
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    if (primaryUnavailable !== null) {
      onActive();
      onUnavailable(primaryUnavailable);
      return;
    }
    onActivate(
      entry.primaryAction,
      {
        disposition: { kind: event.shiftKey ? "Fork" : "Follow" },
        modality: event.detail === 0 ? "Keyboard" : "Pointer",
      },
      event.currentTarget,
      entry,
    );
  };
  const actions: readonly ActionDescriptor[] = entry.secondaryActions.map(
    (action) => {
      const ActionIcon = action.icon;
      const unavailable =
        action.availability.kind === "Unavailable"
          ? action.availability.reason
          : null;
      return {
        kind: "command",
        id: action.id,
        label: action.label,
        icon: <ActionIcon size={16} aria-hidden="true" />,
        disabled: unavailable !== null,
        disabledReason: unavailable ?? undefined,
        onSelect: ({ triggerEl }) => {
          if (unavailable !== null || triggerEl === null) return;
          onActivate(
            action,
            {
              disposition: { kind: "Follow" },
              modality: menuModalityRef.current,
            },
            triggerEl,
            entry,
          );
        },
      };
    },
  );

  // Trigger wiring shared by the resource dropdown and the plain NexusAction
  // menu, so a resource row's overflow behaves like every other row's.
  const menuProps: Omit<ActionMenuProps, "options"> = {
    label: `Actions for ${entry.label}`,
    align: "end",
    onOpenChange: (open) => {
      if (open) onActive();
    },
    renderTrigger: (trigger) => (
      <button
        {...trigger}
        type="button"
        className={styles.rowMenu}
        aria-label={`Actions for ${entry.label}`}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
    ),
  };

  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <li
      ref={rowRef}
      className={styles.row}
      data-active={active || undefined}
      data-compact={compact || undefined}
      data-nested={nested || undefined}
      onPointerDownCapture={() => {
        menuModalityRef.current = "Pointer";
      }}
      onKeyDownCapture={() => {
        menuModalityRef.current = "Keyboard";
      }}
    >
      <button
        type="button"
        className={styles.rowMain}
        onClick={activate}
        aria-current={entry.openState === "Active" ? "page" : undefined}
        aria-disabled={primaryUnavailable !== null || undefined}
        aria-label={
          primaryUnavailable === null
            ? undefined
            : `${entry.label}. Unavailable. ${primaryUnavailable}`
        }
      >
        <span className={styles.rowIcon} aria-hidden="true">
          <Icon size={18} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowLabel}>{entry.label}</span>
          {secondary ? <span className={styles.rowMeta}>{secondary}</span> : null}
          {entry.snippetSegments ? (
            <span className={styles.rowSnippet}>
              <EmphasisSegments
                segments={entry.snippetSegments}
                emphasisClassName={styles.rowSnippetMatch}
              />
            </span>
          ) : null}
          {primaryUnavailable !== null ? (
            <span className={styles.rowUnavailable}>{primaryUnavailable}</span>
          ) : null}
        </span>
        {entry.shortcutHint ? (
          <kbd className={styles.rowShortcut}>{entry.shortcutHint}</kbd>
        ) : null}
      </button>
      {entry.actionSubject ? (
        <SwitchboardRowResourceMenu
          actionSubject={entry.actionSubject}
          menuProps={menuProps}
        />
      ) : actions.length > 0 ? (
        <ActionMenu options={actions} {...menuProps} />
      ) : null}
    </li>
  );
}
