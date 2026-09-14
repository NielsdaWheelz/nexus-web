const PULSE = "reader-apparatus-pulse";

function finishPulse(event: AnimationEvent): void {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement) || event.target !== element || event.animationName !== PULSE) return;
  // An older completion event may arrive after the live animation was restarted.
  if (element.getAnimations().some((animation) => animation instanceof CSSAnimation
    && animation.animationName === PULSE && animation.playState === "running")) return;
  element.classList.remove(PULSE);
}

/** The node and its CSS animation own the pulse; retirement leaves no timer holding source DOM. */
export function pulseReaderApparatusElement(element: HTMLElement): void {
  element.addEventListener("animationend", finishPulse);
  element.addEventListener("animationcancel", finishPulse);
  const active = element.getAnimations().find((animation) => animation instanceof CSSAnimation && animation.animationName === PULSE);
  if (active !== undefined) { active.currentTime = 0; return; }
  element.classList.add(PULSE);
}
