"use client";

import type { ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

interface ResourceActionMenuProps {
  /** The one and only resource this menu acts on. */
  readonly target: ResourceActionSubject;
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
 * `target` and gets the identical menu. It owns no policy — membership, current
 * verb, ordering, danger-last, busy/blocked, and dispatch all live in the
 * resource-action runtime and the pure planner. The component accepts no
 * actions, groups, capability flags, callbacks, projection, or surface id; only
 * a target and presentation-only trigger options.
 *
 * The runtime prefetches the ref's snapshot the moment this mounts, so the menu
 * model is either not-ready (no trigger yet) or ready with descriptors whose
 * `onSelect` closures fire only on selection. Opening the menu therefore never
 * triggers a network request.
 */
export default function ResourceActionMenu({
  target,
  label,
  placement,
  align,
  renderTrigger,
}: ResourceActionMenuProps) {
  const model = useResourceActionMenuModel(target);
  if (!model.ready) return null;
  return (
    <ActionMenu
      options={model.descriptors}
      label={label ?? "More actions"}
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
    />
  );
}
