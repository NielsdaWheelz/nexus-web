/**
 * The small, navigation-oriented action set for a drilled item. Pure; the first action
 * is the item's default (what Enter/select runs). Each action carries a LauncherActionTarget
 * so the controller dispatches it through the one `dispatchTarget` owner. This is NOT the
 * canonical resource menu (PaneShell paneMenuOptions).
 */

import { ArrowUpRight, Link as LinkIcon, PanelLeft, Sparkles, X } from "lucide-react";
import { hrefForResourceActivation } from "@/lib/resources/activation";
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
    return [
      {
        id: "open",
        label: "Open",
        icon: ArrowUpRight,
        target: { kind: "href", href, externalShell: item.target.externalShell },
      },
      ask,
      { id: "copy-link", label: "Copy link", icon: LinkIcon, target: { kind: "copy-link", href } },
    ];
  }

  if (item.target.kind === "resource") {
    const href = hrefForResourceActivation(item.target.activation);
    if (!href) return [ask];
    return [
      {
        id: "open",
        label: "Open",
        icon: ArrowUpRight,
        target: {
          kind: "resource",
          activation: item.target.activation,
          titleHint: item.target.titleHint ?? item.title,
        },
      },
      ask,
      { id: "copy-link", label: "Copy link", icon: LinkIcon, target: { kind: "copy-link", href } },
    ];
  }

  return [];
}
