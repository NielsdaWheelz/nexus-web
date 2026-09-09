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
  NAV_UTILITIES,
  isAccountDestinationId,
  type NavItem,
} from "./navModel";
import NavRail from "./NavRail";
import MobilePaneBar from "./MobilePaneBar";

const COLLAPSE_KEY = "nexus.nav.collapsed";

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
  const accountActiveId = isAccountDestinationId(activeDestinationId)
    ? activeDestinationId
    : null;
  const utilityActiveId =
    activeDestinationId === NAV_UTILITIES.imports.id ? activeDestinationId : null;

  const onNavigate = useCallback(
    (event: MouseEvent<HTMLElement>, destination: NavItem) => {
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
        href: destination.href,
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
      items={NAV_MODEL}
      home={NAV_HOME}
      utilities={NAV_UTILITIES}
      account={NAV_ACCOUNT}
      utilityActiveId={utilityActiveId}
      accountActiveId={accountActiveId}
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
