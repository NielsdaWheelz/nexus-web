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
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import type { WorkspaceTargetActivationResult } from "@/lib/workspace/targetActivation";
import { requestNexusOpen } from "@/lib/nexus/events";
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
import NavRail from "./NavRail";
import MobilePaneBar from "./MobilePaneBar";

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
  const { state, activateWorkspaceTarget } = useWorkspaceStore();

  const [collapsed, setCollapsed] = useState(false);
  const commandCombo =
    useKeybinding("Nexus.Open") ?? DEFAULT_KEYBINDINGS["Nexus.Open"];
  const commandHint = useKeybindingLabel("Nexus.Open") ?? commandCombo;

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
  const activeDestinationId = activePane
    ? sectionDestinationIdForHref(activePane.currentVisit.href)
    : null;
  const activeId = NAV_MODEL.some(
    (destination) => destination.id === activeDestinationId,
  )
    ? activeDestinationId
    : null;
  const settingsActive = activeDestinationId === NAV_ACCOUNT.id;

  const onNavigate = useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      const activation = { result: null as WorkspaceTargetActivationResult | null };
      const result = activateTargetLink({
        event,
        runtime: {
          activateTarget: ({ target, disposition }) => {
            activation.result = activateWorkspaceTarget({
              originPaneId: state.activePrimaryPaneId,
              target,
              disposition,
              modality: event.detail === 0 ? "Keyboard" : "Pointer",
            });
          },
        },
        href,
      });
      if (result === "unhandled") {
        return result;
      }
      return activation.result?.kind === "Unchanged" ||
        activation.result?.kind === "Rejected"
        ? "handled-source-focus"
        : "handled-destination-focus";
    },
    [activateWorkspaceTarget, state.activePrimaryPaneId],
  );

  const openCommand = useCallback(
    () => requestNexusOpen({ kind: "Root" }),
    [],
  );
  const openAdd = useCallback(
    () =>
      requestNexusOpen({
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
    return <MobilePaneBar />;
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
