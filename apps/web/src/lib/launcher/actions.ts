/**
 * The small, navigation-oriented action set for a drilled item. Pure; the first action
 * is the item's default (what Enter/select runs). Each action carries a LauncherActionTarget
 * so the controller dispatches it through the one `dispatchTarget` owner. This is NOT the
 * canonical resource menu (PaneShell paneMenuOptions).
 */

import { ArrowUpRight, Link as LinkIcon, PanelLeft, Share2, Sparkles, X } from "lucide-react";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceCapabilityForScheme } from "@/lib/resources/resourceCapabilities";
import {
  resourceShareTarget,
  routeShareTarget,
} from "@/lib/sharing/targets";
import type { LauncherAction, LauncherItem } from "./model";

export function buildItemActions(item: LauncherItem): LauncherAction[] {
  const ask: LauncherAction = {
    id: "ask",
    label: "Ask AI about this",
    icon: Sparkles,
    target: { kind: "ask", text: item.title },
  };

  if (item.target.kind === "pane-open") {
    const paneId = item.target.paneId;
    return [
      { id: "switch", label: "Switch to tab", icon: PanelLeft, target: { kind: "pane-open", paneId } },
      { id: "close", label: "Close tab", icon: X, target: { kind: "pane-close", paneId } },
      ask,
    ];
  }

  if (item.target.kind === "href") {
    const href = item.target.href;
    const shareAction: LauncherAction | null = item.target.externalShell
      ? {
          id: "copy-external-link",
          label: "Copy external link",
          icon: LinkIcon,
          target: { kind: "copy-external-link", href },
        }
      : (() => {
          try {
            return {
              id: "share",
              label: "Share…",
              icon: Share2,
              target: {
                kind: "share",
                target: routeShareTarget({ href, label: item.title }),
              },
            };
          } catch {
            return null;
          }
        })();
    return [
      {
        id: "open",
        label: "Open",
        icon: ArrowUpRight,
        target: { kind: "href", href, externalShell: item.target.externalShell },
      },
      ask,
      ...(shareAction ? [shareAction] : []),
    ];
  }

  if (item.target.kind === "resource") {
    const href = hrefForResourceActivation(item.target.activation);
    if (!href) return [ask];
    const ref = parseResourceRef(item.target.activation.resourceRef);
    const canShare =
      ref !== null &&
      resourceCapabilityForScheme(ref.scheme).sharing !== "None";
    return [
      {
        id: "open",
        label: "Open",
        icon: ArrowUpRight,
        target: {
          kind: "resource",
          activation: item.target.activation,
          labelHint: item.target.labelHint ?? item.title,
        },
      },
      ask,
      ...(canShare
        ? [
            {
              id: "share",
              label: "Share…",
              icon: Share2,
              target: {
                kind: "share" as const,
                target: resourceShareTarget(item.target.activation.resourceRef),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}
