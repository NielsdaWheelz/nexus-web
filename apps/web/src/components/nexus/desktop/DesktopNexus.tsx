"use client";

// The desktop palette: a modal combobox whose popup is a two-column grid (row, ⋯ menu).
// DOM focus stays in the input; the active cell is virtual (aria-activedescendant).
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Input from "@/components/ui/Input";
import ModalFrame from "@/components/ui/ModalFrame";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import { NexusRowBody, NexusRowMenu, NexusSourceFailures, useNexusRowMenus } from "../NexusRow";
import NexusPages from "../NexusPages";
import type { NexusController } from "../useNexusController";
import styles from "../Nexus.module.css";

type Cell = "Primary" | "Actions";
const GRID_ID = "desktop-nexus-results";

function cellId(key: string, cell: Cell): string {
  return `desktop-nexus-${cell.toLowerCase()}-${encodeURIComponent(key)}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export default function DesktopNexus({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const openMenuKey = useRef<string | null>(null);
  const [cell, setCell] = useState<Cell>("Primary");
  const registerMenu = useNexusRowMenus(controller.menuRequest);
  const rows = controller.groups.flatMap((group) => group.rows);
  const index = rows.findIndex((row) => row.key === controller.activeKey);
  const active = rows[index];
  const activeCell = active?.menu ? cell : "Primary";

  useEffect(() => {
    if (controller.open) return;
    openMenuKey.current = null;
    setCell("Primary");
  }, [controller.open]);
  useEffect(() => {
    gridRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [controller.activeKey]);

  if (!controller.open) return null;

  const select = (row: NexusRow, next: Cell) => {
    controller.setActive(row.key);
    setCell(next);
  };
  const menuOpenChange = (key: string, open: boolean) => {
    if (open) {
      openMenuKey.current = key;
      setCell("Actions");
    } else if (openMenuKey.current === key) {
      openMenuKey.current = null;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };
  const typed = controller.query.trim().length > 0;
  const sized = (id: string) => controller.groups.find((group) => group.id === id)?.rows.length ?? 0;
  const status = typed
    ? `${count(sized("Results"), "result")}. ${count(sized("QuickActions"), "query action")}.`
    : `${count(rows.length, "item")} in ${count(controller.groups.length, "section")}`;

  const root = (
    <>
      <h2 className="sr-only">Nexus</h2>
      <label className={styles.inputRow}>
        <span className="sr-only">Find anything…</span>
        <Input
          ref={inputRef}
          variant="bare"
          role="combobox"
          aria-label="Find anything…"
          aria-autocomplete="list"
          aria-haspopup="grid"
          aria-controls={GRID_ID}
          aria-expanded="true"
          aria-activedescendant={active ? cellId(active.key, activeCell) : undefined}
          className={styles.input}
          value={controller.query}
          placeholder="Find anything…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setCell("Primary");
            controller.setQuery(event.currentTarget.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              // The modal's document-level Escape owner must not see an IME key.
              event.stopPropagation();
              return;
            }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
              event.preventDefault();
              const down = event.key === "ArrowDown";
              const next = rows[index < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]!;
              controller.setActive(next.key);
              if (!next.menu) setCell("Primary");
            } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active?.menu) {
              event.preventDefault();
              setCell(event.key === "ArrowRight" ? "Actions" : "Primary");
            } else if (event.key === "Enter" && active) {
              event.preventDefault();
              if (activeCell === "Actions") controller.openMenu(active.key);
              else {
                controller.activate(
                  active.action,
                  { disposition: { kind: event.shiftKey ? "Fork" : "Follow" } },
                  null,
                  active,
                );
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              setCell("Primary");
              if (controller.query) controller.setQuery("");
              else controller.escape();
            }
          }}
        />
      </label>
      <NexusSourceFailures failures={controller.failures} retry={controller.retry} />
      <div
        ref={gridRef}
        id={GRID_ID}
        role="grid"
        aria-label={typed ? "Find results" : "Nexus options"}
        aria-colcount={2}
        aria-busy={controller.busy || undefined}
        className={styles.grid}
      >
        {controller.groups.map((group) => (
          <div key={group.id} role="rowgroup" aria-labelledby={`desktop-nexus-section-${group.id}`} className={styles.group}>
            <div role="row" className={styles.headingRow}>
              <div role="gridcell" aria-colspan={2}>
                <h3 id={`desktop-nexus-section-${group.id}`}>{group.label}</h3>
              </div>
            </div>
            {group.rows.map((row) => {
              const selected = row.key === controller.activeKey;
              const snippet = row.snippet?.map((segment) => segment.text).join("");
              const reason = row.action.kind === "Unavailable" ? row.action.reason : undefined;
              return (
                <div
                  key={row.key}
                  role="row"
                  aria-selected={selected}
                  className={styles.gridRow}
                  data-selected={selected || undefined}
                  data-nested={row.parent ? true : undefined}
                >
                  <div
                    id={cellId(row.key, "Primary")}
                    role="gridcell"
                    aria-label={[row.label, row.shortcut, rowFacts(row, true), snippet, reason].filter(Boolean).join(". ")}
                    aria-disabled={reason ? true : undefined}
                    className={styles.primaryCell}
                    data-virtual-active={(selected && activeCell === "Primary") || undefined}
                    onPointerMove={() => select(row, "Primary")}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
                      select(row, "Primary");
                      controller.activate(
                        row.action,
                        { disposition: { kind: event.shiftKey ? "Fork" : "Follow" } },
                        null,
                        row,
                      );
                    }}
                  >
                    <NexusRowBody row={row} desktop />
                  </div>
                  <div
                    id={cellId(row.key, "Actions")}
                    role="gridcell"
                    aria-label={row.menu ? `Actions for ${row.label}. Shortcut ${controller.openShortcut}` : undefined}
                    className={styles.actionsCell}
                    data-virtual-active={(selected && activeCell === "Actions") || undefined}
                  >
                    <NexusRowMenu
                      row={row}
                      closePane={controller.closePane}
                      menuProps={{
                        label: `Actions for ${row.label}`,
                        align: "end",
                        triggerAttributes: { tabIndex: -1 },
                        triggerRef: registerMenu(row.key),
                        onOpenChange: (open) => menuOpenChange(row.key, open),
                        renderTrigger: (trigger) => (
                          <button
                            {...trigger}
                            type="button"
                            className={styles.actionsButton}
                            onPointerMove={() => select(row, "Actions")}
                            onKeyDown={(event) => {
                              select(row, "Actions");
                              trigger.onKeyDown(event);
                            }}
                            onClick={(event) => {
                              select(row, "Actions");
                              trigger.onClick(event);
                            }}
                          >
                            <kbd aria-hidden="true">{controller.openShortcut}</kbd>
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </button>
                        ),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {[controller.announcement, controller.busy ? "Searching…" : status].filter(Boolean).join(" ")}
      </div>
    </>
  );

  // Escape, Back and the scrim all take one step back: a page, the query, then the palette.
  return (
    <ModalFrame
      open
      onDismiss={controller.escape}
      label={controller.dialogLabel}
      initialFocus={controller.initialFocus}
      skipReturnFocus={controller.suppressReturnFocus}
      focusKey={controller.focusKey}
      backdropClassName={styles.backdrop}
      className={styles.surface}
    >
      {controller.page.kind === "Root" ? (
        root
      ) : (
        <div className={styles.workflow}>
          <NexusPages controller={controller} mobile={false} />
        </div>
      )}
    </ModalFrame>
  );
}
