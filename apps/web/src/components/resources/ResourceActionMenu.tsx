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
  /** Accessible name of the trigger or directly anchored menu. */
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
  /** A direct menu at an existing interaction target, with no overflow trigger. */
  readonly anchored?: ActionMenuProps["anchored"];
}

/**
 * The canonical resource-only dropdown. It is a thin wrapper over `ActionMenu`:
 * resource-only surfaces render this directly. It owns no policy —
 * membership, current verb, ordering, danger-last, busy/blocked, and dispatch
 * all live in the resource-action runtime and the pure planner. It accepts no
 * actions, groups, capability flags, callbacks, projection, or surface id; only
 * a subject and menu presentation.
 *
 * The runtime prefetches the ref's snapshot when this mounts. Loading explains
 * itself on the trigger or inside a directly anchored menu; Error exposes Retry.
 * Descriptors fire their ports only on selection.
 */
export default function ResourceActionMenu({
  actionSubject,
  label,
  placement,
  align,
  renderTrigger,
  triggerAttributes,
  triggerRef,
  anchored,
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
      anchored={anchored}
      onOpenChange={onOpenChange}
    />
  );
}
