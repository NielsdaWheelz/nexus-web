"use client";

import { Ellipsis } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import type { SelectionActionPlan } from "./highlightActions";
import styles from "./SelectionActionDock.module.css";

export type SelectionPendingActionId =
  "color" | "share" | "learn" | "quote-new" | "quote-existing";

interface SelectionActionDockProps {
  readonly plan: SelectionActionPlan;
  readonly pendingActionId: SelectionPendingActionId | null;
  readonly externalBusy: boolean;
}

/**
 * The fresh-selection icon toolbar: one row of icon-only direct controls plus a
 * `More` trigger for the overflow menu, with one roving tab stop across both.
 * It renders the supplied plan — it never ranks actions or infers capability.
 */
export default function SelectionActionDock({
  plan,
  pendingActionId,
  externalBusy,
}: SelectionActionDockProps) {
  const [rovingIndex, setRovingIndex] = useState(0);
  const [customActionId, setCustomActionId] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const controlRefs = useRef<Array<HTMLElement | null>>([]);
  const customTriggerRef = useRef<HTMLButtonElement>(null);
  const customContentRef = useRef<HTMLDivElement>(null);
  const focusCustomContentOnOpenRef = useRef(false);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const focusEnteredRef = useRef(false);
  const customContentId = useId();
  const overflowIndex = plan.direct.length;
  const controlCount = overflowIndex + (plan.overflow.length > 0 ? 1 : 0);
  const safeRovingIndex = Math.min(rovingIndex, Math.max(0, controlCount - 1));
  const customAction = plan.direct.find(
    (action): action is Extract<PaneHeaderAction, { kind: "custom" }> =>
      action.id === customActionId && action.kind === "custom",
  );
  const overflowPending = plan.overflow.some((action) =>
    actionIsPending(action.id, pendingActionId),
  );
  const busy = externalBusy || pendingActionId !== null;

  const recordFocusEntry = useCallback((relatedTarget: EventTarget | null) => {
    if (focusEnteredRef.current) return;
    priorFocusRef.current =
      relatedTarget instanceof HTMLElement ? relatedTarget : null;
    focusEnteredRef.current = true;
  }, []);

  const setOverflowRef = useCallback(
    (node: HTMLButtonElement | null) => {
      controlRefs.current[overflowIndex] = node;
    },
    [overflowIndex],
  );

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
    const focusToolbar = (event: KeyboardEvent) => {
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
      controlRefs.current[safeRovingIndex]?.focus();
    };
    window.addEventListener("keydown", focusToolbar);
    return () => window.removeEventListener("keydown", focusToolbar);
  }, [recordFocusEntry, safeRovingIndex]);

  const closeCustomAction = useCallback((restoreFocus: boolean) => {
    focusCustomContentOnOpenRef.current = false;
    setCustomActionId(null);
    if (restoreFocus) {
      customTriggerRef.current?.focus();
    }
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activeIndex = controlRefs.current.findIndex(
      (control) => control === document.activeElement,
    );
    const nextIndex = nextRovingIndexForKey({
      key: event.key,
      currentIndex: activeIndex < 0 ? safeRovingIndex : activeIndex,
      itemCount: controlCount,
      orientation: "horizontal",
      wrap: false,
    });
    if (nextIndex === null) return;
    event.preventDefault();
    setRovingIndex(nextIndex);
    controlRefs.current[nextIndex]?.focus();
  };

  return (
    <div ref={frameRef} className={styles.frame}>
      <div
        role="toolbar"
        aria-label="Selection actions"
        aria-orientation="horizontal"
        aria-keyshortcuts="Alt+F10"
        aria-busy={busy || undefined}
        className={styles.dock}
        onFocusCapture={(event) => recordFocusEntry(event.relatedTarget)}
        onKeyDown={handleKeyDown}
      >
        {plan.direct.map((action, index) => {
          if (
            action.kind === "link" ||
            (action.kind === "custom" && action.id !== "color")
          ) {
            // justify-defect: the fresh-selection catalog projects exactly one
            // custom action — the colour picker — and no link descriptors, so
            // anything else here is a catalog change without a toolbar.
            throw new Error(
              `Unrenderable selection action: ${action.kind}:${action.id}`,
            );
          }
          if (action.kind !== "command" && action.kind !== "custom") {
            // justify-defect: a descriptor kind reached the toolbar with no
            // reviewed glyph, label, or activation path. The `never` binding
            // makes adding one to the shared schema a compile error here
            // instead of a bare icon at runtime.
            const unrenderable: never = action;
            throw new Error(
              `Unrenderable selection action kind: ${unrenderable}`,
            );
          }
          const pending = actionIsPending(action.id, pendingActionId);
          const disabled = action.disabled === true || pendingActionId !== null;
          const customOpen = customActionId === action.id;
          return (
            <Button
              key={action.id}
              ref={(node) => {
                controlRefs.current[index] = node;
                if (action.kind === "custom") customTriggerRef.current = node;
              }}
              variant="ghost"
              size="sm"
              iconOnly
              className={styles.action}
              aria-label={action.label}
              title={action.label}
              aria-busy={pending || undefined}
              aria-disabled={disabled || undefined}
              aria-haspopup={action.kind === "custom" ? "dialog" : undefined}
              aria-expanded={action.kind === "custom" ? customOpen : undefined}
              aria-controls={customOpen ? customContentId : undefined}
              data-action-id={action.id}
              data-pending={pending ? "true" : undefined}
              tabIndex={index === safeRovingIndex ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                if (disabled) return;
                if (action.kind === "custom") {
                  // A keyboard activation reports no click count; that is the
                  // signal to move focus into the swatches.
                  focusCustomContentOnOpenRef.current =
                    !customOpen && event.detail === 0;
                  setRovingIndex(index);
                  setCustomActionId(customOpen ? null : action.id);
                  return;
                }
                action.onSelect({ triggerEl: event.currentTarget });
              }}
            >
              <span className={styles.actionIcon} aria-hidden="true">
                {pending ? (
                  <span className={styles.busyIndicator} />
                ) : (
                  action.icon
                )}
              </span>
            </Button>
          );
        })}
        {plan.overflow.length > 0 ? (
          <ActionMenu
            options={plan.overflow}
            label="More"
            triggerRef={setOverflowRef}
            renderTrigger={(trigger) => (
              <Button
                {...trigger}
                variant="ghost"
                size="sm"
                iconOnly
                className={styles.action}
                title="More"
                aria-busy={overflowPending || undefined}
                tabIndex={safeRovingIndex === overflowIndex ? 0 : -1}
              >
                <span className={styles.actionIcon} aria-hidden="true">
                  <Ellipsis aria-hidden="true" />
                </span>
              </Button>
            )}
          />
        ) : null}
        <span
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {pendingActionId !== null
            ? `${pendingActionLabel(plan, pendingActionId)} in progress`
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
      // justify-defect: every pending id names a fresh-selection action; a new
      // one without a mapping here would silently announce nothing.
      const exhaustive: never = pendingActionId;
      throw new Error(`Unhandled pending selection action: ${exhaustive}`);
    }
  }
}

function pendingActionLabel(
  plan: SelectionActionPlan,
  pendingActionId: SelectionPendingActionId,
): string {
  const action = [...plan.direct, ...plan.overflow].find((candidate) =>
    actionIsPending(candidate.id, pendingActionId),
  );
  if (!action) {
    // justify-defect: only a control the plan rendered can become pending, so a
    // pending id with no descriptor means the plan changed under the sequencer.
    throw new Error(
      `Pending selection action is not available: ${pendingActionId}`,
    );
  }
  return action.label;
}
