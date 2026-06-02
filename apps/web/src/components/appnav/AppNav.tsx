"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import { getPaneRouteIcon, resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { useApiResource } from "@/lib/api/useApiResource";
import { pinnedObjectsPath, type PinnedObject } from "@/lib/pinnedObjects";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import { dispatchOpenCommandPalette } from "@/components/commandPaletteEvents";
import { DEFAULT_KEYBINDINGS, formatKeyCombo, loadKeybindings } from "@/lib/keybindings";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { NAV_MODEL, type NavDestination, type NavGroup, type NavItem } from "./navModel";
import { resolveActiveDestinationId } from "./navActive";
import NavRail from "./NavRail";
import NavSheet from "./NavSheet";
import NavTopBar from "./NavTopBar";

const COLLAPSE_KEY = "nexus.nav.collapsed.v1";

interface PinnedObjectsResponse {
  data: { pins: PinnedObject[] };
}

function toNavItem(destination: NavDestination): NavItem {
  return {
    id: destination.id,
    label: destination.label,
    href: destination.href,
    icon: destination.icon ?? getPaneRouteIcon(destination.href),
    signature: destination.signature,
  };
}

export default function AppNav() {
  const isMobile = useIsMobileViewport();
  const { state, navigatePane } = useWorkspaceStore();
  const pinsResource = useApiResource<PinnedObjectsResponse>({
    cacheKey: "navbar",
    path: pinnedObjectsPath,
  });

  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);
  const activePane = useMemo(
    () => primaryPanes.find((p) => p.id === state.activePrimaryPaneId) ?? null,
    [primaryPanes, state.activePrimaryPaneId],
  );
  const activePathname = activePane ? parseWorkspaceHref(activePane.href)?.pathname ?? "" : "";

  const pins = useMemo<NavItem[]>(() => {
    if (pinsResource.status !== "ready") return [];
    return pinsResource.data.data.pins.flatMap((pin) => {
      const route = pin.objectRef.route;
      if (!route) return [];
      return [{ id: pin.id, label: pin.objectRef.label, href: route, icon: getPaneRouteIcon(route) }];
    });
  }, [pinsResource]);

  // The account/Settings destination renders outside the groups (in the account
  // menu), but stays in NAV_MODEL as the single source of truth for its href/label/icon.
  const account = useMemo(() => {
    const destination = NAV_MODEL.find((d) => d.slot === "account");
    if (!destination) throw new Error("NAV_MODEL must define an account destination");
    return toNavItem(destination);
  }, []);

  const groups = useMemo<NavGroup[]>(
    () => [
      { id: "primary", label: "Library", items: NAV_MODEL.filter((d) => d.slot === "primary").map(toNavItem) },
      { id: "pinned", label: "Pinned", items: pins },
      { id: "tools", label: "Tools", items: NAV_MODEL.filter((d) => d.slot === "tools").map(toNavItem) },
    ],
    [pins],
  );

  // Exact pin matches outrank section prefixes, so list pins before the model.
  const activeId = useMemo(
    () => resolveActiveDestinationId(activePathname, [...pins, ...NAV_MODEL]),
    [activePathname, pins],
  );
  const settingsActive = activeId === "settings";

  // Raw combo ("Meta+k") for aria-keyshortcuts (ARIA token syntax); display form ("⌘K") for the kbd hint.
  const commandCombo = useMemo(
    () => loadKeybindings()["open-palette"] ?? DEFAULT_KEYBINDINGS["open-palette"],
    [],
  );
  const commandHint = useMemo(() => formatKeyCombo(commandCombo), [commandCombo]);

  // Close the sheet when the active route changes from outside the sheet (e.g. the command palette).
  useEffect(() => setSheetOpen(false), [activePathname]);

  const onNavigate = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      if (resolvePaneRoute(href).id === "unsupported") return;
      event.preventDefault();
      if (activePane) navigatePane(activePane.id, href);
      else window.location.assign(href);
    },
    [activePane, navigatePane],
  );

  const openCommand = useCallback(() => dispatchOpenCommandPalette(), []);
  const openAdd = useCallback(() => dispatchOpenAddContent("content"), []);

  if (isMobile) {
    return (
      <>
        <NavTopBar
          onOpenSheet={() => setSheetOpen(true)}
          onOpenCommand={openCommand}
          onOpenAdd={openAdd}
          paneCount={primaryPanes.length}
        />
        <NavSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          groups={groups}
          activeId={activeId}
          account={account}
          settingsActive={settingsActive}
          commandHint={commandHint}
          onOpenCommand={openCommand}
          onOpenAdd={openAdd}
          onNavigate={onNavigate}
        />
      </>
    );
  }

  return (
    <NavRail
      groups={groups}
      account={account}
      settingsActive={settingsActive}
      activeId={activeId}
      collapsed={collapsed}
      onToggleCollapse={toggleCollapse}
      commandHint={commandHint}
      commandCombo={commandCombo}
      onOpenCommand={openCommand}
      onOpenAdd={openAdd}
      onNavigate={onNavigate}
    />
  );
}
