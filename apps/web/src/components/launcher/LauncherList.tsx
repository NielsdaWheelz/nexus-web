"use client";

import { ArrowLeft } from "lucide-react";
import { LAUNCHER_LISTBOX_ID, LAUNCHER_OPTION_ID_PREFIX, type LauncherView } from "@/lib/launcher/model";
import type { LauncherController } from "./useLauncherController";
import LauncherRow from "./LauncherRow";
import styles from "./launcher.module.css";

// Text announced to assistive tech via the persistent role=status region — a result
// count while typing, "Searching…" mid-fetch, "No matches" when empty.
function liveStatus(view: LauncherView, loading: boolean): string {
  if (view.state !== "querying") return "";
  if (loading) return "Searching…";
  const matches = view.results.filter((item) => item.pin !== "last");
  return matches.length === 0 ? "No matches" : `${matches.length} results`;
}

export default function LauncherList({ controller }: { controller: LauncherController }) {
  const { view, activeId } = controller;
  const loading = controller.searchLoading || controller.browseLoading;
  // In the typed list, content matches render first; the pinned omnibox rows
  // (ask / create-note / browse-web / see-all) sink into a visibly distinct group (§4.4.3).
  const queryResults = view.state === "querying" ? view.results : [];
  const matches = queryResults.filter((item) => item.pin !== "last");
  const pinned = queryResults.filter((item) => item.pin === "last");

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatus(view, loading)}
      </div>

      {view.state === "actions" ? (
        <button type="button" tabIndex={-1} className={styles.backHeader} onClick={controller.back}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{view.item.title}</span>
        </button>
      ) : null}

      <div
        id={LAUNCHER_LISTBOX_ID}
        role="listbox"
        aria-label="Results"
        className={styles.list}
        aria-busy={loading || undefined}
      >
        {view.state === "resting"
          ? view.groups.map((group) => {
              const headingId = `launcher-group-${group.sectionId}`;
              return (
                <section key={group.sectionId} className={styles.section}>
                  <h3 id={headingId} className={styles.sectionTitle}>
                    {group.label}
                  </h3>
                  <div role="group" aria-labelledby={headingId}>
                    {group.items.map((item) => (
                      <LauncherRow
                        key={item.id}
                        item={item}
                        selected={item.id === activeId}
                        onSelect={controller.select}
                        onDrill={controller.drill}
                        onTrailing={controller.trailing}
                        onHover={controller.setActiveId}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          : null}

        {view.state === "querying" ? (
          <>
            {loading ? <div className={styles.status}>Searching…</div> : null}
            {!loading && matches.length === 0 ? (
              <div className={styles.status}>No matches</div>
            ) : null}
            {matches.map((item) => (
              <LauncherRow
                key={item.id}
                item={item}
                selected={item.id === activeId}
                onSelect={controller.select}
                onDrill={controller.drill}
                onTrailing={controller.trailing}
                onHover={controller.setActiveId}
              />
            ))}
            {pinned.length > 0 ? (
              <div role="group" aria-label="Suggestions" className={styles.pinnedGroup}>
                {pinned.map((item) => (
                  <LauncherRow
                    key={item.id}
                    item={item}
                    selected={item.id === activeId}
                    onSelect={controller.select}
                    onDrill={controller.drill}
                    onTrailing={controller.trailing}
                    onHover={controller.setActiveId}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {view.state === "actions"
          ? view.actions.map((action) => {
              const Icon = action.icon;
              const selected = action.id === activeId;
              return (
                <div
                  key={action.id}
                  id={`${LAUNCHER_OPTION_ID_PREFIX}${action.id}`}
                  role="option"
                  aria-selected={selected}
                  aria-label={[action.label, action.shortcutLabel].filter(Boolean).join(" ")}
                  className={styles.option}
                  data-active={selected || undefined}
                  onMouseMove={() => controller.setActiveId(action.id)}
                  onClick={() => controller.runAction(action)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>{action.label}</span>
                  </span>
                  {action.shortcutLabel ? (
                    <span className={styles.keycap}>{action.shortcutLabel}</span>
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </>
  );
}
