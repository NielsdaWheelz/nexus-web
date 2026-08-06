"use client";

import { useCallback, useRef, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { useOptionalMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";

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
}

/**
 * The one canonical resource dropdown. It is a thin wrapper over `ActionMenu`:
 * every surface (row, header, pane, player, Nexus) renders THIS with the same
 * `actionSubject` and gets the identical menu. It owns no policy — membership, current
 * verb, ordering, danger-last, busy/blocked, and dispatch all live in the
 * resource-action runtime and the pure planner. The component accepts no
 * actions, groups, capability flags, callbacks, projection, or surface id; only
 * a subject and presentation-only trigger options.
 *
 * The runtime prefetches the ref's snapshot the moment this mounts. The trigger
 * is always present: inert with an explanation while Loading, Retry-capable on
 * Error, and backed by descriptors whose ports fire only on selection.
 */
export default function ResourceActionMenu({
  actionSubject,
  label,
  placement,
  align,
  renderTrigger,
}: ResourceActionMenuProps) {
  const model = useResourceActionMenuModel(actionSubject);
  // Keep the mobile bottom chrome pinned while the dropdown is open, so it does
  // not collapse under the portaled menu — the behaviour every ActionMenu-backed
  // dropdown gets, now owned once by the canonical resource menu.
  const { acquire } = useOptionalMobileChromeVisibleLocks();
  const releaseLockRef = useRef<(() => void) | null>(null);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        releaseLockRef.current?.();
        releaseLockRef.current = null;
        return;
      }
      if (releaseLockRef.current) return;
      releaseLockRef.current = acquire("action-menu");
    },
    [acquire],
  );
  return (
    <ActionMenu
      options={model.descriptors}
      triggerDisabled={model.triggerDisabled}
      triggerDisabledReason={model.triggerDisabledReason}
      label={label ?? "More actions"}
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
      onOpenChange={handleOpenChange}
    />
  );
}
