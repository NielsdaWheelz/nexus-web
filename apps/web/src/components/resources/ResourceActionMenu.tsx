"use client";

import type { ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { useMobileChromeActionMenuLock } from "@/lib/workspace/useMobileChromeActionMenuLock";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

interface ResourceActionMenuProps {
  /** The one and only resource this menu acts on. */
  readonly actionSubject: ResourceActionSubject;
  /** Trigger accessible label. Presentation only. */
  readonly label?: string;
  /** Menu placement relative to the trigger. Presentation only. */
  readonly placement?: ActionMenuProps["placement"];
  /** Menu cross-axis alignment. Presentation only. */
  readonly align?: ActionMenuProps["align"];
  /** Custom trigger (e.g. a player/header overflow control). Presentation only. */
  readonly renderTrigger?: ActionMenuProps["renderTrigger"];
  /** Composite-widget attributes forwarded to the shared trigger. */
  readonly triggerAttributes?: ActionMenuProps["triggerAttributes"];
  /** Shares the trigger node with presentation behavior such as dragging. */
  readonly triggerRef?: ActionMenuProps["triggerRef"];
}

/**
 * The canonical resource-only dropdown. It is a thin wrapper over `ActionMenu`:
 * resource-only surfaces render this directly, while contextual panes and rows
 * delegate to it when they have no local descriptors. It owns no policy —
 * membership, current verb, ordering, danger-last, busy/blocked, and dispatch
 * all live in the resource-action runtime and the pure planner. It accepts no
 * actions, groups, capability flags, callbacks, projection, or surface id; only
 * a subject and presentation-only trigger options.
 *
 * The runtime prefetches the ref's snapshot when this mounts. The trigger
 * is always present: inert with an explanation while Loading, Retry-capable on
 * Error, and backed by descriptors whose ports fire only on selection.
 */
export default function ResourceActionMenu({
  actionSubject,
  label,
  placement,
  align,
  renderTrigger,
  triggerAttributes,
  triggerRef,
}: ResourceActionMenuProps) {
  const model = useResourceActionMenuModel(actionSubject);
  const { onOpenChange } = useMobileChromeActionMenuLock();
  return (
    <ActionMenu
      options={model.descriptors}
      triggerDisabled={model.triggerDisabled}
      triggerDisabledReason={model.triggerDisabledReason}
      label={label ?? "More actions"}
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
      triggerAttributes={triggerAttributes}
      triggerRef={triggerRef}
      onOpenChange={onOpenChange}
    />
  );
}
