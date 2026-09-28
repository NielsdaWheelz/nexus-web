"use client";

// The mobile Nexus: a full-screen task whose Root is a search field over sections of button rows.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId, NAV_IMPORTS } from "@/components/appnav/navModel";
import { NexusRowBody, NexusRowMenu, NexusSourceFailures, useNexusRowMenus } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import type { NexusController } from "@/components/nexus/useNexusController";
import MobileFullScreenTask from "@/components/ui/MobileFullScreenTask";
import type { NexusRow } from "@/lib/nexus/model";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import { pointerModality } from "@/lib/ui/pointerModality";
import styles from "@/components/nexus/Nexus.module.css";

export default function SwitchboardTask({
  controller,
  returnFocusTo,
}: {
  controller: NexusController;
  returnFocusTo: () => HTMLElement | null;
}) {
  const active = controller.open;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const taskPointerId = useRef<number | null>(null);
  const registerMenu = useNexusRowMenus(controller.menuRequest);
  useLayoutEffect(() => {
    taskPointerId.current = null;
  }, [active]);
  // Focus inside the opening tap, so the soft keyboard rises with the switchboard.
  useLayoutEffect(() => {
    if (active) inputRef.current?.focus({ preventScroll: true });
  }, [active, controller.focusKey]);
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [controller.activeKey]);

  const rows = controller.groups.flatMap((group) => group.rows);
  const index = rows.findIndex((row) => row.key === controller.activeKey);
  const typed = controller.query.trim().length > 0;
  const results = controller.groups.find((group) => group.id === "Results")?.rows.length ?? 0;
  const activeHref = controller.panes.find((pane) => pane.current)?.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountId = isAccountDestinationId(section) ? section : null;
  const activate = (row: NexusRow, fork: boolean, modality: "Keyboard" | "Pointer", origin: HTMLElement) => {
    controller.setActive(row.key);
    controller.activate(row.action, { disposition: { kind: fork ? "Fork" : "Follow" }, modality }, origin, row);
  };
  // A pointer click counts only if its pointerdown began inside the open task; keyboard clicks always count.
  const admitClick = (event: MouseEvent<HTMLDivElement>) => {
    const pointerId = "pointerId" in event.nativeEvent ? (event.nativeEvent.pointerId as number) : null;
    const admitted = event.detail === 0 || (pointerId !== null && taskPointerId.current === pointerId);
    taskPointerId.current = null;
    if (admitted) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const root = (
    <div className={`${styles.page} ${styles.searchPage}`}>
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          Nexus
        </h2>
        <div className={styles.headerActions}>
          <AccountMenu
            activeId={accountId}
            importsActive={section === NAV_IMPORTS.id}
            placement="below"
            align="end"
            renderTrigger={(trigger) => (
              <button {...trigger} type="button" className={styles.textButton} aria-current={accountId === null ? undefined : "page"}>
                Account
              </button>
            )}
            onNavigate={(event, destination) => {
              event.preventDefault();
              controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label });
              return "handled-destination-focus";
            }}
          />
          <button type="button" className={styles.textButton} onClick={controller.close}>
            Done
          </button>
        </div>
      </header>
      <label className={styles.searchInput}>
        <span className="sr-only">Find anything…</span>
        <input
          ref={inputRef}
          type="search"
          value={controller.query}
          placeholder="Find anything…"
          autoComplete="off"
          enterKeyHint="search"
          data-mobile-nexus-search
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.key === "Process") return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              controller.escape();
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
              controller.setActive(rows[index < 0 ? (step === 1 ? 0 : rows.length - 1) : (index + step) % rows.length]!.key);
            } else if (event.key === "Enter" && index >= 0) {
              event.preventDefault();
              activate(rows[index]!, event.shiftKey, "Keyboard", event.currentTarget);
            }
          }}
        />
      </label>
      <div ref={listRef} className={styles.searchScroll} aria-busy={controller.busy || undefined}>
        <NexusSourceFailures failures={controller.failures} retry={controller.retry} />
        {controller.groups.map((group) => (
          <section key={group.id} className={styles.section} aria-labelledby={`mobile-nexus-group-${group.id}`}>
            <h3 id={`mobile-nexus-group-${group.id}`}>{group.label}</h3>
            <ul className={styles.rows}>
              {group.rows.map((row) => {
                const unavailable = row.action.kind === "Unavailable" ? row.action.reason : null;
                return (
                  <li
                    key={row.key}
                    className={styles.row}
                    data-active={row.key === controller.activeKey || undefined}
                    data-nested={row.parent ? true : undefined}
                  >
                    <button
                      type="button"
                      className={styles.rowMain}
                      aria-current={row.state === "Current" ? "page" : undefined}
                      aria-disabled={unavailable !== null || undefined}
                      aria-label={unavailable === null ? undefined : `${row.label}. Unavailable. ${unavailable}`}
                      onClick={(event) => activate(row, event.shiftKey, pointerModality(event), event.currentTarget)}
                    >
                      <NexusRowBody row={row} desktop={false} />
                    </button>
                    <NexusRowMenu
                      row={row}
                      closePane={controller.closePane}
                      menuProps={{
                        label: `Actions for ${row.label}`,
                        align: "end",
                        triggerRef: registerMenu(row.key),
                        onOpenChange: (open) => open && controller.setActive(row.key),
                        renderTrigger: (trigger) => (
                          <button {...trigger} type="button" className={styles.rowMenu}>
                            <MoreHorizontal size={18} aria-hidden="true" />
                          </button>
                        ),
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {typed && results === 0 && !controller.pending ? (
          <p className={styles.empty}>No results for “{controller.query.trim()}”</p>
        ) : null}
      </div>
      <div className="sr-only" role="status" aria-label="Nexus status" aria-live="polite">
        {controller.announcement ||
          [
            index >= 0 ? `${rows[index]!.label}. ${index + 1} of ${rows.length}.` : null,
            controller.busy ? "Searching…" : typed ? `${results} ${results === 1 ? "result" : "results"}` : null,
          ]
            .filter(Boolean)
            .join(" ")}
      </div>
    </div>
  );

  return (
    <MobileFullScreenTask
      active={active}
      onDismiss={controller.dismissAccepted}
      onDismissRequest={controller.guardClose}
      ariaLabel={controller.addDefect ? "Add needs attention" : controller.dialogLabel}
      initialFocus={controller.initialFocus}
      returnFocusTo={returnFocusTo}
      skipReturnFocus={controller.suppressReturnFocus}
      focusKey={controller.focusKey}
    >
      <div
        className={styles.admission}
        onPointerDownCapture={(event) => {
          taskPointerId.current = event.pointerId;
        }}
        onPointerCancelCapture={(event) => {
          if (taskPointerId.current === event.pointerId) taskPointerId.current = null;
        }}
        onClickCapture={admitClick}
      >
        {controller.page.kind === "Root" ? root : <NexusPages controller={controller} mobile />}
      </div>
    </MobileFullScreenTask>
  );
}
