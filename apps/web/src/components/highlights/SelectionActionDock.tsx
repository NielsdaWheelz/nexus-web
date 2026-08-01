"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import {
  projectActionControlState,
  type PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./SelectionActionDock.module.css";

export type SelectionPendingActionId =
  "color" | "share" | "learn" | "quote-new" | "quote-existing";

interface SelectionActionDockProps {
  readonly actions: readonly PaneHeaderAction[];
  readonly pendingActionId: SelectionPendingActionId | null;
  readonly externalBusy: boolean;
}

export default function SelectionActionDock({
  actions,
  pendingActionId,
  externalBusy,
}: SelectionActionDockProps) {
  const [rovingIndex, setRovingIndex] = useState(0);
  const [customActionId, setCustomActionId] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const actionRefs = useRef<Array<HTMLElement | null>>([]);
  const customTriggerRef = useRef<HTMLButtonElement>(null);
  const customContentRef = useRef<HTMLDivElement>(null);
  const focusCustomContentOnOpenRef = useRef(false);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const focusEnteredRef = useRef(false);
  const customContentId = useId();
  const safeRovingIndex = Math.min(
    rovingIndex,
    Math.max(0, actions.length - 1),
  );
  const customAction = actions.find(
    (action): action is Extract<PaneHeaderAction, { kind: "custom" }> =>
      action.id === customActionId && action.kind === "custom",
  );
  const busy = externalBusy || pendingActionId !== null;

  const recordFocusEntry = useCallback((relatedTarget: EventTarget | null) => {
    if (focusEnteredRef.current) return;
    priorFocusRef.current =
      relatedTarget instanceof HTMLElement ? relatedTarget : null;
    focusEnteredRef.current = true;
  }, []);

  useEffect(() => {
    if (!customAction || !focusCustomContentOnOpenRef.current) return;
    focusCustomContentOnOpenRef.current = false;
    const focusFrame = window.requestAnimationFrame(() => {
      const selectedSwatch =
        customContentRef.current?.querySelector<HTMLElement>(
          'button[aria-pressed="true"]:not(:disabled)',
        );
      const firstEnabledSwatch =
        customContentRef.current?.querySelector<HTMLElement>(
          "button:not(:disabled)",
        );
      (selectedSwatch ?? firstEnabledSwatch)?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [customAction]);

  useEffect(() => {
    return () => {
      if (focusEnteredRef.current && priorFocusRef.current?.isConnected) {
        priorFocusRef.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    const focusPalette = (event: KeyboardEvent) => {
      if (
        event.key !== "F10" ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      recordFocusEntry(activeElement);
      actionRefs.current[safeRovingIndex]?.focus();
    };
    window.addEventListener("keydown", focusPalette);
    return () => window.removeEventListener("keydown", focusPalette);
  }, [recordFocusEntry, safeRovingIndex]);

  const closeCustomAction = useCallback((restoreFocus: boolean) => {
    focusCustomContentOnOpenRef.current = false;
    setCustomActionId(null);
    if (restoreFocus) {
      customTriggerRef.current?.focus();
    }
  }, []);

  if (actions.length === 0) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activeIndex = actionRefs.current.findIndex(
      (action) => action === document.activeElement,
    );
    const nextIndex = nextRovingIndexForKey({
      key: event.key,
      currentIndex: activeIndex < 0 ? safeRovingIndex : activeIndex,
      itemCount: actions.length,
      orientation: "horizontal",
      wrap: false,
    });
    if (nextIndex === null) return;
    event.preventDefault();
    setRovingIndex(nextIndex);
    actionRefs.current[nextIndex]?.focus();
  };

  return (
    <div ref={frameRef} className={styles.frame}>
      <div
        role="toolbar"
        aria-label="Selection actions"
        aria-orientation="horizontal"
        aria-keyshortcuts="Alt+F10"
        aria-busy={busy || undefined}
        data-action-count={actions.length}
        className={styles.dock}
        onFocusCapture={(event) => recordFocusEntry(event.relatedTarget)}
        onKeyDown={handleKeyDown}
      >
        {actions.map((action, index) => {
          const pending = actionIsPending(action.id, pendingActionId);
          const disabled = action.disabled === true || pendingActionId !== null;
          return (
            <Fragment key={action.id}>
              {action.separatorBefore && index > 0 ? (
                <span
                  className={styles.separator}
                  data-selection-separator="true"
                  aria-hidden="true"
                />
              ) : null}
              {renderAction({
                action,
                index,
                tabIndex: index === safeRovingIndex ? 0 : -1,
                disabled,
                pending,
                customContentId,
                customOpen: customActionId === action.id,
                setActionRef: (node) => {
                  actionRefs.current[index] = node;
                  if (action.kind === "custom") {
                    customTriggerRef.current =
                      node instanceof HTMLButtonElement ? node : null;
                  }
                },
                onOpenCustom: (focusContent) => {
                  if (!disabled) {
                    const opening = customActionId !== action.id;
                    focusCustomContentOnOpenRef.current =
                      opening && focusContent;
                    setRovingIndex(index);
                    setCustomActionId(opening ? action.id : null);
                  }
                },
                onPrepareKeyboardCustom: () => {
                  focusCustomContentOnOpenRef.current = true;
                },
              })}
            </Fragment>
          );
        })}
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {pendingActionId !== null
            ? `${pendingActionLabel(actions, pendingActionId)} in progress`
            : externalBusy
              ? "Selection action in progress"
              : ""}
        </span>
      </div>
      <FloatingActionSurface
        open={customAction !== undefined}
        anchor={frameRef.current}
        placement="below"
        align="start"
        flip
        dismissIgnore
        preservePointerSelection
        additionalDismissRefs={[customTriggerRef]}
        className={styles.colorPopover}
        onDismiss={(reason) => closeCustomAction(reason === "escape")}
      >
        {customAction ? (
          <div
            ref={customContentRef}
            id={customContentId}
            role="dialog"
            aria-label="Highlight colours"
            className={styles.colorContent}
            onFocusCapture={(event) => recordFocusEntry(event.relatedTarget)}
          >
            {customAction.render({
              closeMenu: () => closeCustomAction(true),
              closeMenuWithoutFocus: () => closeCustomAction(false),
              triggerEl: customTriggerRef.current,
            })}
          </div>
        ) : null}
      </FloatingActionSurface>
    </div>
  );
}

function renderAction({
  action,
  index,
  tabIndex,
  disabled,
  pending,
  customContentId,
  customOpen,
  setActionRef,
  onOpenCustom,
  onPrepareKeyboardCustom,
}: {
  action: PaneHeaderAction;
  index: number;
  tabIndex: number;
  disabled: boolean;
  pending: boolean;
  customContentId: string;
  customOpen: boolean;
  setActionRef: (node: HTMLElement | null) => void;
  onOpenCustom: (focusContent: boolean) => void;
  onPrepareKeyboardCustom: () => void;
}) {
  const common = {
    "aria-busy": pending || undefined,
    "aria-disabled": disabled || undefined,
    "data-action-id": action.id,
    "data-action-index": index,
    "data-pending": pending ? "true" : undefined,
    tabIndex,
    title: action.disabledReason,
  } as const;
  const icon = (
    <span className={styles.actionIcon} aria-hidden="true">
      {pending ? (
        <span
          className={styles.busyIndicator}
          data-selection-busy-indicator="true"
        />
      ) : (
        action.icon
      )}
    </span>
  );
  const content = (
    <span className={styles.actionLabel} data-selection-action-label="true">
      {action.label}
    </span>
  );

  switch (action.kind) {
    case "command": {
      const control = projectActionControlState(action.label, action.state);
      return (
        <Button
          ref={setActionRef}
          variant={action.tone === "danger" ? "danger" : "ghost"}
          size="sm"
          leadingIcon={icon}
          className={cx(styles.action, control.active && styles.active)}
          aria-pressed={control.barPressed}
          aria-expanded={control.barExpanded}
          aria-controls={control.barControls}
          {...common}
          onClick={(event) => {
            event.stopPropagation();
            if (disabled) return;
            action.onSelect({ triggerEl: event.currentTarget });
          }}
        >
          {content}
        </Button>
      );
    }
    case "link":
      return (
        <Button
          variant={action.tone === "danger" ? "danger" : "ghost"}
          size="sm"
          asChild
          className={styles.action}
        >
          <a
            ref={setActionRef}
            href={disabled ? undefined : action.href}
            {...common}
            onClick={(event) => {
              event.stopPropagation();
              if (disabled) {
                event.preventDefault();
                return;
              }
              action.onSelect?.({ triggerEl: null });
            }}
          >
            {icon}
            {content}
          </a>
        </Button>
      );
    case "custom":
      if (action.id !== "color") {
        throw new Error(`Unexpected selection custom action: ${action.id}`);
      }
      return (
        <Button
          ref={setActionRef}
          variant="ghost"
          size="sm"
          leadingIcon={icon}
          className={styles.action}
          aria-haspopup="dialog"
          aria-expanded={customOpen}
          aria-controls={customOpen ? customContentId : undefined}
          {...common}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              onPrepareKeyboardCustom();
            }
          }}
          onClick={(event) => {
            event.stopPropagation();
            onOpenCustom(event.detail === 0);
          }}
        >
          {content}
        </Button>
      );
    default: {
      const exhaustive: never = action;
      throw new Error(
        `Unhandled selection action: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function actionIsPending(
  actionId: string,
  pendingActionId: SelectionPendingActionId | null,
): boolean {
  if (pendingActionId === null) return false;
  switch (pendingActionId) {
    case "color":
      return actionId === "color";
    case "share":
      return actionId === "ResourceAction.Share";
    case "learn":
    case "quote-new":
    case "quote-existing":
      return actionId === pendingActionId;
    default: {
      const exhaustive: never = pendingActionId;
      throw new Error(`Unhandled pending selection action: ${exhaustive}`);
    }
  }
}

function pendingActionLabel(
  actions: readonly PaneHeaderAction[],
  pendingActionId: SelectionPendingActionId,
): string {
  const action = actions.find((candidate) =>
    actionIsPending(candidate.id, pendingActionId),
  );
  if (!action)
    throw new Error(
      `Pending selection action is not available: ${pendingActionId}`,
    );
  return action.label;
}
