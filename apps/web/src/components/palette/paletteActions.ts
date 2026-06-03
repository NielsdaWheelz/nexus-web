/**
 * The small, navigation-oriented action set for a drilled item (§5.4 / §7.5).
 * Pure; the first action is the item's default (what Enter/select runs). This is
 * NOT the canonical resource menu (PaneShell paneMenuOptions) — see N9.
 */

import { ArrowUpRight, Link, PanelLeft, Sparkles, X } from "lucide-react";
import type { PaletteAction, PaletteItem } from "./paletteModel";
import type { PaletteContext } from "./paletteProviders";

export function buildItemActions(item: PaletteItem, ctx: PaletteContext): PaletteAction[] {
  const ask: PaletteAction | null = ctx.canOpenConversation
    ? { id: "ask", label: "Ask AI about this", icon: Sparkles, run: { kind: "ask", text: item.title } }
    : null;

  if (item.target.kind === "action" && item.target.actionId.startsWith("pane-open:")) {
    const paneId = item.target.actionId.slice("pane-open:".length);
    return [
      { id: "switch", label: "Switch to tab", icon: PanelLeft, run: { kind: "pane-activate", paneId } },
      { id: "close", label: "Close tab", icon: X, run: { kind: "pane-close", paneId } },
      ...(ask ? [ask] : []),
    ];
  }

  if (item.target.kind === "href") {
    const href = item.target.href;
    return [
      {
        id: "open",
        label: "Open",
        icon: ArrowUpRight,
        run: { kind: "open", href, externalShell: item.target.externalShell },
      },
      ...(ask ? [ask] : []),
      { id: "copy-link", label: "Copy link", icon: Link, run: { kind: "copy-link", href } },
    ];
  }

  return [];
}
