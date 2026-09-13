"use client";

import { useLayoutEffect } from "react";
import {
  nexusEntryKeyValue,
  type NexusGroup,
} from "@/lib/nexus/model";
import {
  completeNexusPerformance,
  NEXUS_LOCAL_FIND_PERFORMANCE,
  NEXUS_OPENABLES_PERFORMANCE,
} from "@/lib/nexus/performance";
import { DESKTOP_NEXUS_GRID_ID } from "./DesktopNexusInput";
import DesktopNexusRow from "./DesktopNexusRow";
import type {
  DesktopNexusActionsOpener,
  DesktopNexusCell,
  DesktopNexusController,
} from "./types";
import styles from "./desktopNexus.module.css";

function groupLayoutClass(layout: NexusGroup["layout"]): string {
  switch (layout) {
    case "Flow":
      return styles.flowGroup;
    case "CompactRail":
      return styles.compactRailGroup;
    case "PinnedBelowInput":
      return styles.pinnedGroup;
  }
}

export default function DesktopNexusResults({
  controller,
  activeCell,
  setActiveCell,
  registerActionsOpener,
  onActionMenuOpenChange,
}: {
  controller: DesktopNexusController;
  activeCell: DesktopNexusCell;
  setActiveCell(cell: DesktopNexusCell): void;
  registerActionsOpener(
    key: string,
    opener: DesktopNexusActionsOpener | null,
  ): void;
  onActionMenuOpenChange(key: string, open: boolean): void;
}) {
  const typed = controller.query.trim().length > 0;
  const activeKey = controller.projection.activeKey
    ? nexusEntryKeyValue(controller.projection.activeKey)
    : null;
  const entryCount = controller.projection.groups.reduce(
    (count, group) => count + group.entries.length,
    0,
  );
  const groupCount = controller.projection.groups.length;
  const resultCount =
    controller.projection.groups.find((group) => group.id === "Results")
      ?.entries.length ?? 0;
  const queryActionCount =
    controller.projection.groups.find((group) => group.id === "QueryActions")
      ?.entries.length ?? 0;
  const settledStatus = typed
    ? `${resultCount} ${resultCount === 1 ? "result" : "results"}. ${queryActionCount} ${
        queryActionCount === 1 ? "query action" : "query actions"
      }.`
    : `${entryCount} ${entryCount === 1 ? "item" : "items"} in ${groupCount} ${
        groupCount === 1 ? "section" : "sections"
      }`;
  const liveStatus = [
    controller.announcement,
    controller.busy ? "Searching…" : settledStatus,
  ]
    .filter(Boolean)
    .join(" ");

  useLayoutEffect(() => {
    completeNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
    completeNexusPerformance(NEXUS_OPENABLES_PERFORMANCE);
  }, [controller.projection.groups]);

  return (
    <>
      {controller.failures.size > 0 ? (
        <div className={styles.sourceFailures} aria-live="polite">
          {controller.failures.has("Openables") ? (
            <p>
              Couldn’t search your resources.{" "}
              <button
                type="button"
                onClick={() => controller.retry("Openables")}
              >
                Retry
              </button>
            </p>
          ) : null}
          {controller.failures.has("Owned") ? (
            <p>
              Couldn’t search inside your library.{" "}
              <button type="button" onClick={() => controller.retry("Owned")}>
                Retry
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        id={DESKTOP_NEXUS_GRID_ID}
        role="grid"
        aria-label={typed ? "Find results" : "Nexus options"}
        aria-colcount={2}
        aria-busy={controller.busy || undefined}
        className={styles.grid}
      >
        {controller.projection.groups.map((group) => {
          const headingId = `desktop-nexus-section-${group.id}`;
          return (
            <div
              key={group.id}
              role="rowgroup"
              aria-labelledby={headingId}
              className={`${styles.group} ${groupLayoutClass(group.layout)}`}
            >
              <div role="row" className={styles.headingRow}>
                <div role="gridcell" aria-colspan={2}>
                  <h3 id={headingId} className={styles.heading}>
                    {group.label}
                  </h3>
                </div>
              </div>
              {group.entries.map((entry) => (
                <DesktopNexusRow
                  key={nexusEntryKeyValue(entry.key)}
                  entry={entry}
                  nested={
                    entry.parent !== undefined &&
                    nexusEntryKeyValue(entry.parent.key) !==
                      nexusEntryKeyValue(entry.key)
                  }
                  selected={nexusEntryKeyValue(entry.key) === activeKey}
                  activeCell={activeCell}
                  controller={controller}
                  setActiveCell={setActiveCell}
                  registerActionsOpener={registerActionsOpener}
                  onActionMenuOpenChange={onActionMenuOpenChange}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </div>
    </>
  );
}
