"use client";

import { createElement } from "react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import { activateTargetLink, type TargetLinkActivationRuntime } from "./targetLinkActivation";

/** The caller owns the exact displayed target and its real pane origin. */
export function paneForkLink({ runtime, target, disabledReason }: {
  readonly runtime: TargetLinkActivationRuntime;
  readonly target: WorkspaceTarget;
  readonly disabledReason: string | null;
}): Extract<ActionDescriptor, { kind: "link" }> {
  const action = ACTION_CATALOG.OpenInNewPane;
  return {
    kind: "link", id: "Row.OpenInNewPane", label: action.label.toLowerCase(),
    icon: createElement(action.icon, { size: 16, "aria-hidden": true }), href: target.href,
    disabled: disabledReason !== null, disabledReason: disabledReason ?? undefined,
    restoreFocusOnClose: false,
    onActivate: event => {
      const result = activateTargetLink({ event, runtime, target,
        onDefault: () => runtime.activateTarget({ target, disposition: { kind: "Fork" } }) ?? null,
      });
      return result === "handled-default" ? "handled-new-pane" : result;
    },
  };
}
