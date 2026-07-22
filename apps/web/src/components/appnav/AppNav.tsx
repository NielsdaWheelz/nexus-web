"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import { hasSamePaneRoute } from "@/lib/panes/paneIdentity";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import { DEFAULT_KEYBINDINGS } from "@/lib/keybindings";
import { useKeybinding, useKeybindingLabel } from "@/lib/keybindingsProvider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  NAV_ACCOUNT,
  NAV_HOME,
  NAV_MODEL,
  type NavDestination,
  type NavItem,
} from "./navModel";
import { handleAppNavLinkActivation } from "./navActivation";
import NavRail from "./NavRail";
import NavSheet from "./NavSheet";
import NavTopBar from "./NavTopBar";

const COLLAPSE_KEY = "nexus.nav.collapsed";

function toNavItem(destination: NavDestination): NavItem {
  return {
    id: destination.id,
    label: destination.label,
    href: destination.href,
    icon: destination.icon ?? getPaneRouteIcon(destination.href),
    presentation: destination.presentation,
  };
}

const NAV_ITEMS = NAV_MODEL.map(toNavItem);
const NAV_HOME_ITEM = toNavItem(NAV_HOME);
const NAV_ACCOUNT_ITEM = toNavItem(NAV_ACCOUNT);

export default function AppNav() {
  const isMobile = useIsMobileViewport();
  const { state, openPane } = useWorkspaceStore();

  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const commandCombo =
    useKeybinding("open-launcher") ?? DEFAULT_KEYBINDINGS["open-launcher"];
  const commandHint = useKeybindingLabel("open-launcher") ?? commandCombo;

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
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);
  const activePane = useMemo(
    () => primaryPanes.find((p) => p.id === state.activePrimaryPaneId) ?? null,
    [primaryPanes, state.activePrimaryPaneId],
  );
  const activeDestinationId = activePane
    ? sectionDestinationIdForHref(activePane.href)
    : null;
  const activeId = NAV_MODEL.some(
    (destination) => destination.id === activeDestinationId,
  )
    ? activeDestinationId
    : null;
  const settingsActive = activeDestinationId === NAV_ACCOUNT.id;

  const onNavigate = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      return handleAppNavLinkActivation(event, href, (nextHref) => {
        const result =
          activePane && hasSamePaneRoute(activePane.href, nextHref)
            ? "handled-source-focus"
            : "handled-destination-focus";
        openPane({ href: nextHref });
        return result;
      });
    },
    [activePane, openPane],
  );

  const openCommand = useCallback(() => dispatchOpenLauncher(), []);
  const openAdd = useCallback(
    () =>
      dispatchOpenLauncher({
        kind: "Add",
        seed: {
          kind: "Content",
          initialFocus: "Url",
          initialDestinations: [],
        },
      }),
    [],
  );

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
          onClose={closeSheet}
          items={NAV_ITEMS}
          home={NAV_HOME_ITEM}
          activeId={activeId}
          activeHref={activePane?.href ?? null}
          account={NAV_ACCOUNT_ITEM}
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
      items={NAV_ITEMS}
      home={NAV_HOME_ITEM}
      account={NAV_ACCOUNT_ITEM}
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
