/**
 * The small, navigation-oriented action set for a drilled item. Pure; the first action
 * is the item's default (what Enter/select runs). Each action carries a LauncherActionTarget
 * so the controller dispatches it through the one `dispatchTarget` owner.
 * Resource items consume the same canonical core policy and catalog metadata
 * as standing menus, projected into Launcher-specific targets.
 */

import { ArrowUpRight, Link as LinkIcon, PanelLeft, Share2, Sparkles, X } from "lucide-react";
import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionCatalogKey,
  type ResourceCoreCatalogKey,
  resolveResourceCoreCatalogKeys,
} from "@/lib/actions/resourceActions";
import { routeShareTarget } from "@/lib/sharing/targets";
import type {
  LauncherAction,
  LauncherActionTarget,
  LauncherItem,
} from "./model";

type ResourceOpenTarget = Extract<
  LauncherActionTarget,
  { kind: "ResourceOpen" }
>;

function projectResourceActionToLauncher(
  catalogKey: ResourceActionCatalogKey,
  target: LauncherAction["target"],
): LauncherAction {
  const entry = RESOURCE_ACTION_CATALOG[catalogKey];
  return {
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    target,
  };
}

function projectResourceCoreActionToLauncher(
  item: LauncherItem,
  target: ResourceOpenTarget,
  catalogKey: ResourceCoreCatalogKey,
): LauncherAction {
  switch (catalogKey) {
    case "Open":
      return projectResourceActionToLauncher("Open", {
        ...target,
        labelHint: target.labelHint ?? item.title,
      });
    case "Share":
      return projectResourceActionToLauncher("Share", {
        kind: "ResourceShare",
        subject: target.subject,
      });
    case "Chat":
      return projectResourceActionToLauncher("Chat", {
        kind: "ResourceChat",
        ref: target.subject.ref,
      });
  }
}

export function buildItemActions(item: LauncherItem): LauncherAction[] {
  const ask: LauncherAction = {
    id: "ask",
    label: "Ask AI about this",
    icon: Sparkles,
    target: { kind: "Ask", text: item.title },
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
      : {
          id: "share",
          label: "Share…",
          icon: Share2,
          target: {
            kind: "share",
            target: routeShareTarget({ href, label: item.title }),
          },
        };
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

  if (item.target.kind === "ResourceOpen") {
    const target = item.target;
    return resolveResourceCoreCatalogKeys(
      target.subject,
      "Representation",
    ).map((catalogKey) =>
      projectResourceCoreActionToLauncher(item, target, catalogKey),
    );
  }

  return [];
}
