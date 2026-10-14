"use client";

import { useCallback, useState, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  NO_ACTIONS,
  useResourceActionMenu,
} from "@/lib/actions/useResourceActionMenu";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

/**
 * The menu for one resource: its verbs are fetched when it opens. It takes a
 * ref and presentation only; what the verbs are and do is the runtime's.
 */
export default function ResourceActionMenu({
  resourceRef,
  label = "More actions",
  ...presentation
}: Pick<
  ActionMenuProps,
  "placement" | "align" | "renderTrigger" | "anchored"
> & {
  readonly resourceRef: CanonicalResourceRef;
  /** The trigger's (or an anchored menu's) accessible name. */
  readonly label?: string;
}) {
  const { options, onOpenChange } = useResourceActionMenu(resourceRef);
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  return (
    <ActionMenu
      {...presentation}
      label={label}
      options={options.length > 0 ? options : [NO_ACTIONS]}
      onOpenChange={openChange}
    />
  );
}
