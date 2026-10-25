"use client";

import { Fragment, useId, useRef } from "react";
import Button from "@/components/ui/Button";
import type { ActionButtonSpec } from "@/lib/actions/inlineActions";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./ActionButtons.module.css";

/** Presentation only: command identity may change while its focused control remains. */
export default function ActionButtons({ actions, density, returnFocus, afterRemoval }: {
  readonly actions: readonly ActionButtonSpec[];
  readonly density: "Row" | "Header";
  readonly returnFocus: () => HTMLElement | null;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useActionFocusRecovery(root, returnFocus);
  return <div ref={root} className={styles.actions} data-resource-actions="" data-density={density}>
    {actions.map(action => {
      const reasonId = `${id}-${action.controlKey}`;
      const label = action.accessibleLabel;
      return <Fragment key={action.controlKey}>
        <Button iconOnly icon={action.icon} className={styles.button} data-action-control-key={action.controlKey}
          aria-label={label} aria-disabled={action.disabled || undefined} aria-busy={action.busy || undefined}
          aria-describedby={action.disabledReason ? reasonId : undefined}
          aria-haspopup={action.hasPopup ?? undefined}
          tooltip={{ text: action.disabledReason ? `${label}: ${action.disabledReason}` : label }}
          data-action-id={action.id}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            if (!action.disabled) action.invoke({ trigger: event.currentTarget, returnFocus, afterRemoval });
          }} />
        {action.disabledReason ? <span className="sr-only" id={reasonId} data-action-control-key={action.controlKey}>{action.disabledReason}</span> : null}
      </Fragment>;
    })}
  </div>;
}
