"use client";

import { useCallback, type RefObject } from "react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
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
  const commands: ActionDescriptor[] = actions.map(action => ({
    kind: "command", id: action.id,
    label: action.menuLabel,
    icon: action.icon,
    disabled: action.disabled,
    disabledReason: action.disabledReason ?? undefined,
    busy: action.busy,
    hasPopup: action.hasPopup ?? undefined,
    restoreFocusOnClose: action.hasPopup === null,
    onSelect: ({ triggerEl }) => action.invoke({ trigger: triggerEl, returnFocus, afterRemoval: returnFocus }),
  }));
  return <ContextualActionMenu navigation={null}
    title={subject.title} subjectKey={subjectKey}
    sections={[{ id: "View", actions: [...commands, ...viewActions] }]}
    triggerRef={setTrigger}
    triggerAttributes={{ "data-row-actions-control": "" }}
  />;
}
