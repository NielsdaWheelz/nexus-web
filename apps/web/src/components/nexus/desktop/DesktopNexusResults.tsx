"use client";

import type { DesktopNexusController } from "./types";
import { DESKTOP_NEXUS_LISTBOX_ID } from "./DesktopNexusInput";
import DesktopNexusRow from "./DesktopNexusRow";
import styles from "./desktopNexus.module.css";

export default function DesktopNexusResults({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  const typed = controller.query.trim().length > 0;
  const entriesByKey = new Map(
    controller.entries.map((entry) => [entry.key, entry] as const),
  );
  const childrenByActionableParent = new Map<
    string,
    (typeof controller.entries)[number][]
  >();
  const childrenByGroupParent = new Map<
    string,
    (typeof controller.entries)[number][]
  >();
  for (const entry of controller.entries) {
    if (!entry.parentKey || entry.parentKey === entry.key) continue;
    if (entriesByKey.has(entry.parentKey)) {
      const children = childrenByActionableParent.get(entry.parentKey) ?? [];
      childrenByActionableParent.set(entry.parentKey, [...children, entry]);
      continue;
    }
    if (!entry.parentLabel) continue;
    const children = childrenByGroupParent.get(entry.parentKey) ?? [];
    childrenByGroupParent.set(entry.parentKey, [...children, entry]);
  }
  const renderRow = (
    entry: (typeof controller.entries)[number],
    nested = false,
  ) => (
    <DesktopNexusRow
      key={entry.key}
      entry={entry}
      nested={nested}
      selected={entry.key === controller.activeEntryKey}
      controller={controller}
    />
  );
  return (
    <>
      {controller.failures.size > 0 ? (
        <div className={styles.sourceFailures} aria-live="polite">
          {controller.failures.has("Openables") ? (
            <p>
              Couldn’t search your resources. <button type="button" onClick={() => controller.retry("Openables")}>Retry</button>
            </p>
          ) : null}
          {controller.failures.has("Owned") ? (
            <p>
              Couldn’t search inside your library. <button type="button" onClick={() => controller.retry("Owned")}>Retry</button>
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        id={DESKTOP_NEXUS_LISTBOX_ID}
        role="listbox"
        aria-label={typed ? "Find results" : "Open and new"}
        aria-busy={controller.busy || undefined}
        className={styles.list}
      >
        {controller.entries.map((entry) => {
          const hasActionableParent =
            entry.parentKey !== undefined &&
            entry.parentKey !== entry.key &&
            entriesByKey.has(entry.parentKey);
          if (hasActionableParent) return null;
          const actionableChildren =
            childrenByActionableParent.get(entry.key) ?? [];
          if (actionableChildren.length > 0) {
            return (
              <div
                key={entry.key}
                role="group"
                aria-label={`Matches in ${entry.label}`}
              >
                {renderRow(entry)}
                {actionableChildren.map((child) => renderRow(child, true))}
              </div>
            );
          }
          const groupChildren = entry.parentKey
            ? childrenByGroupParent.get(entry.parentKey) ?? []
            : [];
          if (groupChildren.length > 0) {
            if (groupChildren[0]?.key !== entry.key) return null;
            return (
              <div
                key={`group:${entry.parentKey}`}
                role="group"
                aria-label={`Matches in ${entry.parentLabel}`}
              >
                {groupChildren.map((child) => renderRow(child, true))}
              </div>
            );
          }
          return renderRow(entry);
        })}
        {typed && controller.entries.length === 0 && !controller.busy ? (
          <p className={styles.empty}>No owned results for “{controller.query.trim()}”</p>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite">
        {controller.busy ? "Searching…" : `${controller.entries.length} ${controller.entries.length === 1 ? "result" : "results"}`}
      </div>
    </>
  );
}
