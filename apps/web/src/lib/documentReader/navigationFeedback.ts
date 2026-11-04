import type { Line } from "@/components/feedback/stage";
import type { NavigationFailure } from "./navigator";

const NAVIGATION_FACTS: Record<NavigationFailure["operation"], string> = {
  Open: "couldn’t open that passage.",
  Restore: "couldn’t restore your reading position.",
  Return: "couldn’t return to your place.",
  Reflow: "couldn’t keep this passage in view.",
  Continue: "couldn’t move your reading position here.",
};

/** The failed intention's line. A capture failure has its own fact except on adoption; a
 * reason is given only where the navigator proves it. */
export function navigationFailureLine({ operation, reason }: NavigationFailure): Line {
  if (operation !== "Continue" && reason === "CaptureUnavailable") return { fact: "couldn’t hold your current place." };
  const fact = NAVIGATION_FACTS[operation];
  if (operation === "Open" && reason === "TargetUnavailable") return { fact, reason: "it isn’t in this version." };
  if (operation === "Return" && reason === "SourceChanged") return { fact, reason: "this version no longer has it." };
  return { fact };
}
