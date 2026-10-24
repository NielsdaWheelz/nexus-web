"use client";

// One binding for reader destination controls, including hosts without panes.
import type { HTMLAttributes, KeyboardEvent, MouseEvent, Ref } from "react";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useReaderState } from "./DocumentReader";
import type { ReaderDestination } from "./location";
import type { Reader } from "./runtime";
import { sourceTarget,localTarget } from "./model";

export function activateReaderDestination(reader: Reader, destination: ReaderDestination, event: TargetActivationEvent, onDefault?: () => void, enter: "native" | "activate" = "native") {
  const activation = workspaceTargetActivationIntent(event, enter);
  if (activation.kind === "Unowned") return "unhandled" as const;
  event.preventDefault();
  if (activation.kind === "Consume") return "consumed" as const;
  const local = onDefault ?? (() => {
    // justify-defect: evidence destinations are host-owned and always bind their local activation.
    if (destination.target.kind === "evidence_item") throw new Error("evidence destination requires a host activation");
    const state=reader.getState().document;
    const target=state.status==="ready" && state.doc.identity===destination.source_identity ? localTarget(state.doc,destination.target) : null;
    if (target && target.kind!=="evidence_item") void reader.inspect({target});
  });
  if (reader.navigation) {
    if (reader.navigation.activate(destination, activation.intent, local) === "Refused") return "consumed" as const;
  }
  else local();
  return activation.intent === "new_pane" && reader.navigation ? "handled-new-pane" as const : "handled-default" as const;
}

/**
 * Binds one reader destination to its host's native control: a link where the
 * host has hrefs, else a button. A disabled link stays mounted and named but
 * drops its href; its click, auxiliary click and activation keys stop here, so
 * neither a native gesture nor an ancestor can act on it. It stays focusable
 * unless the caller sets another tab policy.
 */
export function ReaderLink({ reader, target, onDefault, disabled = false, ref, children, ...attributes }: HTMLAttributes<HTMLElement> & {
  readonly reader: Reader;
  readonly target: ReaderDestination["target"];
  readonly onDefault?: () => void;
  readonly disabled?: boolean;
  readonly ref?: Ref<HTMLAnchorElement | HTMLButtonElement>;
}) {
  const doc=useReaderState(reader,(state)=>state.document.status==="ready"?state.document.doc:null);
  const portable=doc===null?null:sourceTarget(doc,target);
  const destination = doc===null || portable===null ? null : {source_identity:doc.identity,target:portable};
  const href = destination && reader.navigation?.href(destination);
  const activate = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if (disabled || !destination) {
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    activateReaderDestination(reader, destination, event, onDefault);
  };
  const blockAuxiliary = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // justify-type-assertion: react writes only the mounted host into the ref, and either host is a member of its declared union.
  return href ? <a {...attributes} ref={ref as Ref<HTMLAnchorElement>} href={disabled ? undefined : href} role={disabled ? "link" : attributes.role} data-workspace-rich-target="true" aria-disabled={disabled || undefined} tabIndex={attributes.tabIndex ?? (disabled ? 0 : undefined)} onClick={activate} onAuxClick={disabled ? blockAuxiliary : attributes.onAuxClick} onKeyDown={activate}>{children}</a>
    // justify-type-assertion: as above, for the button host.
    : <button {...attributes} ref={ref as Ref<HTMLButtonElement>} type="button" disabled={disabled || destination === null} onClick={activate} onKeyDown={activate}>{children}</button>;
}
