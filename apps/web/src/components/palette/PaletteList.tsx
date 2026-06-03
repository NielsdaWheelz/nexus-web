"use client";

import { ArrowLeft } from "lucide-react";
import { PALETTE_LISTBOX_ID, PALETTE_OPTION_ID_PREFIX, type PaletteView } from "./paletteModel";
import type { PaletteController } from "./usePaletteController";
import PaletteRow from "./PaletteRow";
import styles from "./palette.module.css";

// Text announced to assistive tech via the persistent role=status region — a
// result count while typing, "Searching…" mid-fetch, "No matches" when empty.
function liveStatus(view: PaletteView, searchLoading: boolean): string {
  if (view.state !== "querying") return "";
  if (searchLoading) return "Searching…";
  const matches = view.results.filter((item) => item.pin !== "last");
  return matches.length === 0 ? "No matches" : `${matches.length} results`;
}

export default function PaletteList({ controller }: { controller: PaletteController }) {
  const { view, activeId, searchLoading } = controller;

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatus(view, searchLoading)}
      </div>

      {view.state === "actions" ? (
        <button type="button" tabIndex={-1} className={styles.backHeader} onClick={controller.back}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{view.item.title}</span>
        </button>
      ) : null}

      <div
        id={PALETTE_LISTBOX_ID}
        role="listbox"
        aria-label="Results"
        className={styles.list}
        aria-busy={searchLoading || undefined}
      >
        {view.state === "resting"
          ? view.groups.map((group) => {
              const headingId = `palette-group-${group.sectionId}`;
              return (
                <section key={group.sectionId} className={styles.section}>
                  <h3 id={headingId} className={styles.sectionTitle}>
                    {group.label}
                  </h3>
                  <div role="group" aria-labelledby={headingId}>
                    {group.items.map((item) => (
                      <PaletteRow
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
            {searchLoading ? <div className={styles.status}>Searching…</div> : null}
            {!searchLoading && view.results.every((item) => item.pin === "last") ? (
              <div className={styles.status}>No matches</div>
            ) : null}
            {view.results.map((item) => (
              <PaletteRow
                key={item.id}
                item={item}
                selected={item.id === activeId}
                onSelect={controller.select}
                onDrill={controller.drill}
                onTrailing={controller.trailing}
                onHover={controller.setActiveId}
              />
            ))}
          </>
        ) : null}

        {view.state === "actions"
          ? view.actions.map((action) => {
              const Icon = action.icon;
              const selected = action.id === activeId;
              return (
                <div
                  key={action.id}
                  id={`${PALETTE_OPTION_ID_PREFIX}${action.id}`}
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
