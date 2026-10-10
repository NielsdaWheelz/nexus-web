import type { Schema } from "@/lib/api/wire";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";

export type ResourceActivation = Schema<"ResourceActivationOut">;

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
  const href = activation.href;
  if (!href) return false;
  if (activation.kind === "external" && typeof window !== "undefined") {
    switch (input.disposition.kind) {
      case "Follow":
        window.location.assign(href);
        return true;
      case "Fork":
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      case "Adopt":
        // justify-defect: named adoption is a workspace-only operation and
        // cannot preserve an origin when crossing into an external browser.
        throw new Error("Cannot adopt an external resource target");
    }
  }
  input.activateTarget({
    target: {
      href,
      ...(input.labelHint ? { labelHint: input.labelHint } : {}),
    },
    disposition: input.disposition,
  });
  return true;
}
