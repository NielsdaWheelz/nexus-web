"use client";

import { useCallback, type RefObject } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useMediaActions } from "@/lib/actions/useMediaActions";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

/** External commands retain sealed identity and the account's acquisition owner. */
export default function ExternalMediaMenu({ subject, subjectKey, viewActions, triggerRef, returnFocus }: {
  subject: Extract<MediaSubject, { kind: "External" }>;
  subjectKey: string;
  viewActions: readonly ActionDescriptor[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  returnFocus: () => HTMLElement | null;
}) {
  const actions = useMediaActions(subject, null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; }, [triggerRef]);
  const commands: ActionDescriptor[] = actions.map(action => {
    return {
      kind: "command", id: action.id,
      label: action.id === "LibraryPlacement" ? ACTION_CATALOG.LibraryPlacement.label : action.label,
      icon: action.icon,
      disabled: action.disabled || undefined,
      disabledReason: action.disabledReason ?? undefined,
      onSelect: () => action.invoke({ trigger: triggerRef.current, returnFocus, afterRemoval: returnFocus }),
    };
  });
  return <ContextualActionMenu
    title={subject.title} subjectKey={subjectKey}
    sections={[{ id: "View", actions: [...commands, ...viewActions] }]}
    triggerRef={setTrigger}
    triggerAttributes={{ "data-row-actions-control": "" }}
  />;
}
