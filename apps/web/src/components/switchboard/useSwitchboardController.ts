"use client";

import { useMemo } from "react";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import { paneStatusLabel } from "@/lib/switchboard/paneStatusLabel";
import type { LauncherController } from "@/components/launcher/useLauncherController";

export function useSwitchboardController(controller: LauncherController) {
  const places = useMemo(
    () =>
      controller.switchboardPlaces.map((place) => ({
        ...place,
        icon: place.icon ?? getPaneRouteIcon(place.href),
      })),
    [controller.switchboardPlaces],
  );
  const panes = useMemo(
    () =>
      controller.switchboardPanes.map((pane) => ({
        id: pane.id,
        label: pane.label,
        metadata: paneStatusLabel(pane),
        current: pane.current,
        activationRouteId: pane.activationRouteId,
      })),
    [controller.switchboardPanes],
  );
  const recentlyClosed = useMemo(
    () =>
      controller.switchboardClosedPanes.map((pane) => ({
        id: pane.id,
        label: pane.label,
        metadata: "Closed tab",
      })),
    [controller.switchboardClosedPanes],
  );
  return {
    ...controller,
    places,
    panes,
    recentlyClosed,
  };
}
