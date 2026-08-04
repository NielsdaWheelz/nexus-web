"use client";

import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { MoreHorizontal } from "lucide-react";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionCatalogProjection } from "@/lib/actions/resourceActionRuntime";
import {
  nexusEntryHasSecondaryActions,
  nexusEntryKeyValue,
  type NexusAction,
  type NexusEntry,
} from "@/lib/nexus/model";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { desktopNexusCellId } from "./DesktopNexusInput";
import type {
  DesktopNexusActionsOpener,
  DesktopNexusCell,
  DesktopNexusController,
  DesktopNexusModality,
} from "./types";
import styles from "./desktopNexus.module.css";

function openStateLabel(state: NexusEntry["openState"]): string | undefined {
  if (state === undefined) return undefined;
  switch (state) {
    case "Active":
      return "Current";
    case "Open":
      return "Open";
    case "Minimized":
      return "Minimized";
  }
}

function unavailableReason(action: NexusAction): string | undefined {
  switch (action.availability.kind) {
    case "Available":
      return undefined;
    case "Unavailable":
      return action.availability.reason;
  }
}

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

/**
 * The overflow menu for a canonical resource Nexus row. It renders the SAME
 * catalog projection every other surface shows for `target`, over the row's own
 * `ActionMenu` trigger wiring — so the resource secondary actions come from the
 * shared planner, never a private NexusAction array. The trigger stays withheld
 * until the ref's snapshot is ready, so opening the menu performs no request.
 */
function DesktopNexusRowResourceMenu({
  target,
  menuProps,
  onPresenceChange,
}: {
  target: ResourceActionSubject;
  menuProps: Omit<ActionMenuProps, "options">;
  onPresenceChange(present: boolean): void;
}) {
  const model = useResourceActionCatalogProjection(target);
  // Present only once the snapshot resolved AND the plan is non-empty; a
  // missing/ineligible resource yields no descriptors, so the row must not
  // advertise an actions trigger (or its shortcut) that renders nothing.
  const present = model.ready && model.descriptors.length > 0;
  useEffect(() => {
    onPresenceChange(present);
    return () => onPresenceChange(false);
  }, [present, onPresenceChange]);
  if (!present) return null;
  return <ActionMenu options={model.descriptors} {...menuProps} />;
}

export default function DesktopNexusRow({
  entry,
  selected,
  activeCell,
  nested = false,
  controller,
  setActiveCell,
  registerActionsOpener,
  onActionMenuOpenChange,
}: {
  entry: NexusEntry;
  selected: boolean;
  activeCell: DesktopNexusCell;
  nested?: boolean;
  controller: DesktopNexusController;
  setActiveCell(cell: DesktopNexusCell): void;
  registerActionsOpener(
    key: string,
    opener: DesktopNexusActionsOpener | null,
  ): void;
  onActionMenuOpenChange(key: string, open: boolean): void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingSnapshotRef = useRef<NexusEntry | null>(null);
  const menuModalityRef = useRef<DesktopNexusModality>("Pointer");
  const [menuSnapshot, setMenuSnapshot] = useState<NexusEntry | null>(null);
  // A resource entry's overflow is the shared canonical dropdown for
  // `resourceTarget`; it never reads a local NexusAction snapshot, so the
  // snapshot bookkeeping below is skipped for it (FIX 4). Its readiness is
  // reported up from the resource menu so the cell announces its shortcut only
  // when the menu is actually present (FIX 3).
  const isResource = entry.resourceTarget !== undefined;
  const [resourceMenuReady, setResourceMenuReady] = useState(false);
  const key = nexusEntryKeyValue(entry.key);
  const primaryCellId = desktopNexusCellId(entry.key, "Primary");
  const actionsCellId = desktopNexusCellId(entry.key, "Actions");
  const primaryUnavailableReason = unavailableReason(entry.primaryAction);
  const primaryReasonId = primaryUnavailableReason
    ? `${primaryCellId}-unavailable`
    : undefined;

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const selectCell = useCallback(
    (cell: DesktopNexusCell) => {
      controller.setActiveEntry(entry.key);
      setActiveCell(cell);
    },
    [controller, entry.key, setActiveCell],
  );

  const openActions = useCallback<DesktopNexusActionsOpener>(
    (snapshot, modality) => {
      pendingSnapshotRef.current = snapshot;
      menuModalityRef.current = modality;
      triggerRef.current?.click();
    },
    [],
  );

  const setTriggerNode = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      registerActionsOpener(key, node ? openActions : null);
    },
    [key, openActions, registerActionsOpener],
  );

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      onActionMenuOpenChange(key, open);
      if (!open && !isResource) setMenuSnapshot(null);
    },
    [isResource, key, onActionMenuOpenChange],
  );

  const actionEntry = menuSnapshot ?? entry;
  const actionOptions = useMemo<readonly ActionDescriptor[]>(
    () =>
      actionEntry.secondaryActions.map((action) => ({
        kind: "command" as const,
        id: action.id,
        label: action.label,
        icon: createElement(action.icon, { size: 16, "aria-hidden": true }),
        disabled: action.availability.kind === "Unavailable",
        disabledReason: unavailableReason(action),
        restoreFocusOnClose: false,
        onSelect: () =>
          controller.activateAction({
            entry: actionEntry,
            action,
            modality: menuModalityRef.current,
          }),
      })),
    [actionEntry, controller],
  );

  const activatePrimary = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    selectCell("Primary");
    controller.activatePrimary({
      entry,
      disposition: event.shiftKey ? "Fork" : "Follow",
      modality: "Pointer",
    });
  };
  const parentLabel =
    entry.parent && nexusEntryKeyValue(entry.parent.key) !== key
      ? entry.parent.label
      : undefined;
  const facts = [
    entry.typeLabel,
    entry.metadata,
    parentLabel,
    openStateLabel(entry.openState),
  ].filter(
    (fact, index, all): fact is string =>
      Boolean(fact) && all.indexOf(fact) === index,
  );
  const secondary = facts.join(" · ");
  const excerpt =
    entry.snippetSegments?.map((segment) => segment.text).join("") ?? "";
  const primaryLabel = [entry.label, entry.shortcutHint, secondary, excerpt]
    .filter(Boolean)
    .join(". ");
  const Icon = entry.icon;
  const hasSecondaryActions = nexusEntryHasSecondaryActions(entry);
  // The overflow trigger is present only when a menu will actually render: a
  // non-resource entry with local secondaries, or a resource entry whose shared
  // dropdown has resolved a non-empty plan. Gate the cell's shortcut
  // announcement on that so a not-yet-ready / ineligible resource never
  // advertises an action it cannot open (FIX 3).
  const menuPresent = isResource
    ? resourceMenuReady
    : entry.secondaryActions.length > 0;
  // Trigger wiring shared by both the resource dropdown and the plain
  // NexusAction menu, so the row's keyboard opener + focus behaviour are
  // identical regardless of where the secondary actions come from.
  const actionsMenuProps: Omit<ActionMenuProps, "options"> = {
    label: `Actions for ${entry.label}`,
    align: "end",
    onOpenChange: handleMenuOpenChange,
    triggerAttributes: { tabIndex: -1 },
    triggerRef: setTriggerNode,
    renderTrigger: (trigger) => (
      <button
        {...trigger}
        type="button"
        className={styles.rowActionsButton}
        onPointerMove={() => selectCell("Actions")}
        onKeyDown={(event) => {
          selectCell("Actions");
          trigger.onKeyDown(event);
        }}
        onClick={(event) => {
          const snapshot = pendingSnapshotRef.current ?? entry;
          pendingSnapshotRef.current = null;
          if (!isResource) setMenuSnapshot(snapshot);
          controller.setActiveEntry(snapshot.key);
          setActiveCell("Actions");
          trigger.onClick(event);
        }}
      >
        <kbd aria-hidden="true">{controller.nexusOpenShortcutLabel}</kbd>
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
    ),
  };

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      className={styles.row}
      data-selected={selected || undefined}
      data-nested={nested || undefined}
      onPointerDownCapture={() => {
        menuModalityRef.current = "Pointer";
      }}
      onKeyDownCapture={() => {
        menuModalityRef.current = "Keyboard";
      }}
    >
      <div
        id={primaryCellId}
        role="gridcell"
        aria-label={primaryLabel}
        aria-disabled={primaryUnavailableReason ? "true" : undefined}
        aria-describedby={primaryReasonId}
        className={styles.primaryCell}
        data-virtual-active={
          selected && activeCell === "Primary" ? "true" : undefined
        }
        onPointerMove={() => selectCell("Primary")}
        onClick={activatePrimary}
      >
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} aria-hidden="true" />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowLabel}>{entry.label}</span>
          {secondary ? <span className={styles.rowMeta}>{secondary}</span> : null}
          {excerpt ? (
            <span className={styles.rowExcerpt}>
              <EmphasisSegments
                segments={entry.snippetSegments ?? []}
                emphasisClassName={styles.rowExcerptMatch}
              />
            </span>
          ) : null}
        </span>
        {entry.shortcutHint ? (
          <kbd className={styles.entryShortcut}>{entry.shortcutHint}</kbd>
        ) : null}
        {primaryUnavailableReason ? (
          <span id={primaryReasonId} className="sr-only">
            {primaryUnavailableReason}
          </span>
        ) : null}
      </div>
      <div
        id={actionsCellId}
        role="gridcell"
        aria-label={
          menuPresent
            ? `Actions for ${entry.label}. Shortcut ${controller.nexusOpenShortcutLabel}`
            : undefined
        }
        className={styles.actionsCell}
        data-virtual-active={
          selected && activeCell === "Actions" ? "true" : undefined
        }
      >
        {hasSecondaryActions ? (
          entry.resourceTarget ? (
            <DesktopNexusRowResourceMenu
              target={entry.resourceTarget}
              menuProps={actionsMenuProps}
              onPresenceChange={setResourceMenuReady}
            />
          ) : (
            <ActionMenu options={actionOptions} {...actionsMenuProps} />
          )
        ) : null}
      </div>
    </div>
  );
}
