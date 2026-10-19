"use client";

// One binding for reader destination controls, including hosts without panes.
import type { HTMLAttributes } from "react";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useReaderState } from "./DocumentReader";
import type { ReaderDestination } from "./location";
import type { Reader } from "./runtime";

export function activateReaderDestination(reader: Reader, destination: ReaderDestination, event: TargetActivationEvent, onDefault?: () => void, enter: "native" | "activate" = "native") {
  const activation = workspaceTargetActivationIntent(event, enter);
  if (activation.kind === "Unowned") return "unhandled" as const;
  event.preventDefault();
  if (activation.kind === "Consume") return "consumed" as const;
  const local = onDefault ?? (() => {
    // justify-defect: evidence destinations are host-owned and always bind their local activation.
    if (destination.target.kind === "evidence_item") throw new Error("evidence destination requires a host activation");
    void reader.inspect({ target: destination.target });
  });
  if (reader.navigation) reader.navigation.activate(destination, activation.intent, local);
  else local();
  return activation.intent === "new_pane" && reader.navigation ? "handled-new-pane" as const : "handled-default" as const;
}

export function ReaderLink({ reader, target, onDefault, disabled = false, children, ...attributes }: HTMLAttributes<HTMLElement> & {
  readonly reader: Reader;
  readonly target: ReaderDestination["target"];
  readonly onDefault?: () => void;
  readonly disabled?: boolean;
}) {
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const destination = identity === null ? null : { source_identity: identity, target };
  const href = destination && reader.navigation?.href(destination);
  const activate = (event: TargetActivationEvent) => {
    if (disabled || !destination) {
      if (!("key" in event) || event.key === "Enter" || event.key === " ") event.preventDefault();
      return;
    }
    activateReaderDestination(reader, destination, event, onDefault);
  };
  return href ? <a {...attributes} href={href} data-workspace-rich-target="true" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : attributes.tabIndex} onClick={activate} onKeyDown={activate}>{children}</a>
    : <button {...attributes} type="button" disabled={disabled || identity === null} onClick={activate} onKeyDown={activate}>{children}</button>;
}
