"use client";

import { useCallback, useState, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import {
  NO_ACTIONS,
  useResourceActionMenu,
} from "@/lib/actions/useResourceActionMenu";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

type ActionMenuProps = ComponentProps<typeof ActionMenu>;

export interface ContextActionSection {
  readonly id: "Pane" | "Occurrence" | "View";
  readonly actions: readonly ActionDescriptor[];
}

/** Pane, occurrence or view commands, then the resource's verbs after a separator. */
export default function ContextualActionMenu({
  sections,
  resourceRef,
  onDefect,
  omitResourceActions = [],
  showSourceSubject = false,
  commandDisabledReason,
  ...props
}: Pick<
  ActionMenuProps,
  | "label"
  | "placement"
  | "align"
  | "renderTrigger"
  | "triggerAttributes"
  | "triggerRef"
> & {
  readonly sections: readonly ContextActionSection[];
  readonly resourceRef?: CanonicalResourceRef;
  readonly omitResourceActions?: readonly string[];
  readonly showSourceSubject?: boolean;
  readonly commandDisabledReason?: string;
  /** Where a defect while loading goes when the menu renders outside its pane. */
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
}) {
  const { options: resource, onOpenChange, label: resourceLabel } = useResourceActionMenu(
    resourceRef ?? null,
    onDefect,
  );
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const local = sections.map((section) => section.actions);
  // A resource-only menu with no verbs still says so.
  const alone = resourceRef && !local.some((actions) => actions.length > 0);
  const eligible = resource.filter((action) => !omitResourceActions.includes(action.id));
  const verbs = alone && eligible.length === 0 ? [NO_ACTIONS] : eligible;
  const subject: ActionDescriptor[] = showSourceSubject && resourceLabel !== null ? [{
    kind: "custom", id: "ResourceActions.Subject", label: `source: ${resourceLabel}`,
    render: () => <FeedbackStatus content={{ tone: "Neutral", title: `source: ${resourceLabel}` }} announcement="None" />,
  }] : [];
  const options = [subject, ...local, verbs]
    .filter((actions) => actions.length > 0)
    .flatMap((actions, group) =>
      actions.map((action, index) =>
        group > 0 && index === 0 ? { ...action, separatorBefore: true } : action,
      ),
    );
  return <ActionMenu {...props} options={options.map((action) => commandDisabledReason && action.kind === "command" ? { ...action, disabled: true, disabledReason: commandDisabledReason } : action)} onOpenChange={openChange} />;
}
