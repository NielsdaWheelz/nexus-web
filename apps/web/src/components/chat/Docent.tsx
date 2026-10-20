"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./ChatPanels.module.css";

/** One in-flow band; route arrivals and their focus belong to the destination. */
export function SourceTourBand() {
  const { tour, move, leave, consumeStartFocus, openExternal } = useActionRuntime().sourceTour;
  const nextControl = useRef<HTMLElement | null>(null);
  const previousControl = useRef<HTMLElement | null>(null);
  const retainControlAt = useRef<{ index: number; direction: "previous" | "next" } | null>(null);
  useLayoutEffect(() => {
    const pending = retainControlAt.current;
    retainControlAt.current = null;
    if (tour && consumeStartFocus(tour)) nextControl.current?.focus({ preventScroll: true });
    if (tour && pending?.index === tour.index && tour.steps[tour.index].activation.kind !== "route") {
      const directionControl = pending.direction === "next" ? nextControl.current : previousControl.current;
      const oppositeControl = pending.direction === "next" ? previousControl.current : nextControl.current;
      const atBoundary = pending.direction === "next"
        ? tour.index === tour.steps.length - 1 : tour.index === 0;
      if (!hasActiveInteractionOwner() &&
        (document.activeElement === document.body || (atBoundary && document.activeElement === directionControl)))
        (atBoundary ? oppositeControl : directionControl)?.focus({ preventScroll: true });
    }
  }, [tour, consumeStartFocus]);
  if (!tour) return null;
  const step = tour.steps[tour.index];
  const go = (direction: "previous" | "next", intent: OpenIntent = "default") => {
    const index = tour.index + (direction === "next" ? 1 : -1);
    const destination = tour.steps[index];
    const focused = document.activeElement;
    retainControlAt.current = destination?.activation.kind !== "route" &&
      focused instanceof HTMLElement && focused.closest("[data-source-tour-band]") &&
      focused.matches("button,a[href]") ? { index, direction } : null;
    move(direction, intent);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing ||
      hasActiveInteractionOwner() || isEditableTarget(event.target) ||
      !(event.target instanceof HTMLElement) || !event.target.closest("button,a[href]")) return;
    const command = event.key === "p" || event.key === "ArrowLeft" ? "previous"
      : event.key === "n" || event.key === "ArrowRight" ? "next"
      : event.key === "Escape" ? "leave" : null;
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    if (command === "leave") leave();
    else go(command);
  };
  const neighbor = (direction: "previous" | "next", label: string) => {
    const ref = direction === "next"
      ? (node: HTMLElement | null) => { nextControl.current = node; }
      : (node: HTMLElement | null) => { previousControl.current = node; };
    const activate = (event: TargetActivationEvent) => {
      const action = workspaceTargetActivationIntent(event);
      if (action.kind === "Unowned") return;
      event.preventDefault();
      if (action.kind === "Open") go(direction, action.intent);
    };
    return <Button
      ref={ref}
      variant="ghost"
      size="sm"
      disabled={direction === "previous" ? tour.index === 0 : tour.index === tour.steps.length - 1}
      aria-label={label}
      onClick={activate}
      onKeyDown={activate}
    >{label}</Button>;
  };
  const activateExternal = (event: TargetActivationEvent) => {
    const action = workspaceTargetActivationIntent(event);
    if (action.kind === "Unowned") return;
    event.preventDefault();
    if (action.kind === "Open") openExternal(action.intent);
  };
  return <div className={styles.docent} data-source-tour-band="true" onKeyDown={onKeyDown}>
    <FeedbackStatus content={{ tone: "Neutral", title: `source ${tour.index + 1} of ${tour.steps.length} · ${step.title}` }} announcement="Polite" />
    <div className={styles.sentence}>
      {step.sentence ? <MachineText variant="inline" origin={{ label: "Assistant" }}>{step.sentence}</MachineText> : <span aria-hidden="true">—</span>}
    </div>
    {step.activation.kind === "none" ? <span className={styles.faint}>source unavailable</span> : null}
    {step.activation.kind === "external" && step.activation.href ? <a
      href={step.activation.href}
      data-workspace-rich-target="true"
      onClick={activateExternal}
      onKeyDown={activateExternal}
    >open external source</a> : null}
    <div className={styles.docentControls}>
      {neighbor("previous", "previous source")}
      {neighbor("next", "next source")}
      <Button variant="ghost" size="sm" onClick={leave} aria-label="leave walk">leave walk</Button>
    </div>
  </div>;
}
