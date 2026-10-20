import type { Schema } from "@/lib/api/wire";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

export type ResourceActivation = Schema<"ResourceActivationOut">;

/**
 * Open a resource where its activation points: a workspace route through
 * `activateTarget` with its canonical href, an outside url in the browser.
 * False when it goes nowhere.
 */
export function activateResource(
  activation: ResourceActivation,
  input: {
    labelHint?: string | null;
    disposition: WorkspaceTargetDisposition;
    activateTarget: (input: {
      target: WorkspaceTarget;
      disposition: WorkspaceTargetDisposition;
    }) => void;
  },
): boolean {
  const { href } = activation;
  if (!href) return false;
  if (activation.kind === "external") {
    if (input.disposition.kind === "Fork")
      window.open(href, "_blank", "noopener,noreferrer");
    else window.location.assign(href);
    return true;
  }
  const labelHint = input.labelHint ? { labelHint: input.labelHint } : {};
  input.activateTarget({
    target: { href, ...labelHint },
    disposition: input.disposition,
  });
  return true;
}
