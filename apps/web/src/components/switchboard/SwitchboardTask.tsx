"use client";

// One mobile task: a keyboard-down workspace index, or explicitly entered search.
import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { ArrowLeft, ChevronDown, Search, X } from "lucide-react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId, NAV_IMPORTS } from "@/components/appnav/navModel";
import { NEXUS_SOURCE_FAILURES, NexusRowBody, NexusRowMenu, NexusSourceFailures, NexusTitleFailure } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import type { NexusController } from "@/components/nexus/useNexusController";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import MobileFullScreenTask from "@/components/ui/MobileFullScreenTask";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import styles from "@/components/nexus/Nexus.module.css";

export default function SwitchboardTask({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const taskPointerId = useRef<number | null>(null);
  const previousQuery = useRef(controller.query);
  const searching = controller.rootMode === "Search";
  useLayoutEffect(() => { taskPointerId.current = null; }, [controller.open]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!controller.open || controller.page.kind !== "Root" || !list) return;
    const mode = controller.rootMode;
    const positions = controller.rootScroll.current;
    if (previousQuery.current !== controller.query) positions.Search = 0;
    previousQuery.current = controller.query;
    list.scrollTop = positions[mode];
    return () => { positions[mode] = list.scrollTop; };
  }, [controller.open, controller.page.kind, controller.rootMode, controller.query, controller.rootScroll]);

  const typed = controller.query.trim().length > 0;
  const results = controller.groups.filter((group) => group.id !== "QuickActions").reduce((count, group) => count + group.rows.length, 0);
  const activeHref = controller.panes.find((pane) => pane.current)?.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountId = isAccountDestinationId(section) ? section : null;
  const activate = (row: NexusRow, event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    controller.setActive(row.key);
    controller.activate(row.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, row);
  };
  // Admit only gestures begun inside this task; the opening pointer-up is not a row click.
  const admitClick = (event: MouseEvent<HTMLDivElement>) => {
    const pointerId = "pointerId" in event.nativeEvent && typeof event.nativeEvent.pointerId === "number" ? event.nativeEvent.pointerId : null;
    const admitted = event.detail === 0 || (pointerId !== null && taskPointerId.current === pointerId);
    taskPointerId.current = null;
    if (admitted) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const failures = [...controller.failures].map((source) => NEXUS_SOURCE_FAILURES[source]);
  if (controller.semanticUnavailable) failures.push("related matches are unavailable; showing text matches");
  const textLabels = ["ask nexus", "add to today", "browse…", "create…"];

  const root = (
    <div className={`${styles.page} ${styles.searchPage}`}>
      <header className={styles.header}>
        {searching ? <button type="button" className={styles.iconButton} aria-label="back to workspace" onClick={controller.escape}><ArrowLeft size={20} aria-hidden="true" /></button> : null}
        <h2 ref={headingRef} tabIndex={-1} data-switchboard-heading>{searching ? "search" : "workspace"}</h2>
        <div className={styles.headerActions}>
          <AccountMenu
            activeId={accountId}
            importsActive={section === NAV_IMPORTS.id}
            placement="below"
            align="end"
            renderTrigger={(trigger) => (
              <button {...trigger} type="button" className={styles.textButton} aria-current={accountId === null ? undefined : "page"}>account</button>
            )}
            onNavigate={(event, destination) => {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return "unhandled";
              event.preventDefault();
              if (activation.kind === "Consume") return "consumed";
              controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label }, activation.intent === "new_pane" ? { disposition: { kind: "Fork" } } : undefined);
              return "handled-destination-focus";
            }}
          />
          <button type="button" className={styles.textButton} onClick={controller.close}>done</button>
        </div>
      </header>
      <div className={styles.searchInput}>
        <div className={styles.searchField}>
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="search"
            value={controller.query}
            placeholder="find anything…"
            autoComplete="off"
            enterKeyHint={controller.explicitIntent ? "go" : "search"}
            data-mobile-nexus-search
            data-nexus-control="Search"
            onFocus={controller.enterSearch}
            onChange={(event) => controller.setQuery(event.currentTarget.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") {
                event.stopPropagation();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                controller.escape();
              } else if (event.key === "Enter") {
                const activation = workspaceTargetActivationIntent(event, "activate");
                if (activation.kind === "Unowned") return;
                event.preventDefault();
                if (activation.kind === "Open") controller.submitSearch({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
              }
            }}
          />
          {controller.query ? <button type="button" className={styles.iconButton} aria-label="clear search" onClick={() => { controller.setQuery(""); inputRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button> : null}
        </div>
        {searching ? <div className={styles.searchStatus}>{controller.busy ? "searching…" : "\u00a0"}</div> : null}
      </div>
      <div ref={listRef} className={styles.searchScroll} aria-busy={controller.busy || undefined} data-mode={controller.rootMode}>
        {searching ? <NexusSourceFailures failures={controller.failures} semanticUnavailable={controller.semanticUnavailable} retry={controller.retry} retrying={controller.retrying} returnFocus={() => inputRef.current} announce={false} /> : null}
        <NexusTitleFailure failed={controller.titlesFailed} retry={controller.retryTitles} returnFocus={() => searching ? inputRef.current : headingRef.current} announce={false} />
        {controller.groups.map((group) => (
          <section key={group.id} className={styles.section} data-group={group.id} aria-labelledby={group.label ? `mobile-nexus-group-${group.id}` : undefined}>
            {group.label ? <h3 id={`mobile-nexus-group-${group.id}`}>{group.label}</h3> : null}
            <ul className={styles.rows}>
              {group.rows.map((row) => {
                const unavailable = row.action.kind === "Unavailable" ? row.action.reason : null;
                const name = [row.label, rowFacts(row, false), unavailable].filter(Boolean).join(". ");
                const body = row.item?.preview.body;
                const hasEvidence = row.matchingPassage || (body && (body.kind !== "named" || (row.match && row.match.excerpt.text !== body.title)));
                return (
                  <li key={row.key} className={styles.row} data-current={row.state === "Current" || undefined} data-nested={row.parent ? true : undefined} onPointerDown={() => controller.setActive(row.key)}>
                    <button
                      type="button"
                      className={styles.rowMain}
                      data-nexus-control={row.key === "QuickAction:New" ? "New" : row.key}
                      aria-current={row.state === "Current" ? "page" : undefined}
                      aria-disabled={unavailable !== null || undefined}
                      aria-label={name}
                      aria-describedby={hasEvidence ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined}
                      onFocus={() => controller.setActive(row.key)}
                      onClick={(event) => activate(row, event)}
                      onKeyDown={(event) => activate(row, event)}
                    >
                      <NexusRowBody row={row} desktop={false} />
                    </button>
                    {row.secondary?.kind === "CloseTab" ? (
                      <Button variant="ghost" size="sm" iconOnly className={styles.rowMenu} aria-label={`close ${row.label}`} title={`close ${row.label}`}
                        onKeyDown={(event) => { if (event.repeat && event.key === "Enter") event.preventDefault(); }}
                        onClick={() => { if (row.secondary?.kind === "CloseTab") controller.closePane(row.secondary.paneId); }}>
                        <X size={18} aria-hidden="true" />
                      </Button>
                    ) : row.secondary?.kind === "ResourceMenu" ? (
                      <NexusRowMenu row={row} activate={controller.activate} closePane={controller.closePane} menuProps={{
                        label: `more actions for ${row.label}`,
                        align: "end",
                        onOpenChange: (open) => { if (open) controller.setActive(row.key); },
                        renderTrigger: (trigger) => <OverflowMenuButton {...trigger} className={styles.rowMenu} />,
                      }} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {group.id === "Open" && !searching ? <button type="button" className={styles.allTabs} data-nexus-control="AllTabs" aria-label={`all ${controller.panes.length} tabs`} onClick={controller.manageTabs}>all tabs <span aria-hidden="true">· {controller.panes.length}</span></button> : null}
          </section>
        ))}
        {searching && typed ? (
          <ActionMenu label="use this text…" align="start" triggerAttributes={{ "data-nexus-control": "UseText" }}
            options={controller.textActions.map((row, index) => ({ kind: "command", id: row.key, label: textLabels[index]!, icon: <row.icon size={16} aria-hidden="true" />, onSelect: ({ openIntent }) => controller.activate(row.action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }, row) }))}
            renderTrigger={(trigger) => <button {...trigger} className={styles.useText}>use this text… <ChevronDown size={16} aria-hidden="true" /></button>}
          />
        ) : null}
        {searching && typed && results === 0 && !controller.pending && controller.failures.size === 0 ? <p className={styles.empty}>no results.</p> : null}
        {searching && !typed && controller.groups.length === 0 ? <p className={styles.empty}>search your tabs, library and commands.</p> : null}
      </div>
      <div className="sr-only" role="status" aria-label="search status" aria-live="polite" aria-atomic="true">
        {[controller.announcement, controller.titlesFailed ? "couldn’t refresh tab titles." : null, ...(searching ? failures : []), searching && typed && !controller.pending ? `${results} results shown.` : null].filter(Boolean).join(" ")}
      </div>
    </div>
  );

  return (
    <MobileFullScreenTask interactionLayer={controller.interactionLayer} active={controller.open} scope="Nexus" onDismiss={controller.dismissAccepted} onDismissRequest={controller.guardClose}
      ariaLabel={controller.addDefect ? "Add needs attention" : controller.dialogLabel} initialFocus={controller.initialFocus}
      returnFocusTo={controller.returnFocusTo} returnFocusFallback={controller.returnFocusFallback} skipReturnFocus={controller.suppressReturnFocus} focusKey={controller.focusKey}>
      <div className={`${styles.admission} ${styles.mobile}`}
        onPointerDownCapture={(event) => { taskPointerId.current = event.pointerId; }}
        onPointerCancelCapture={(event) => { if (taskPointerId.current === event.pointerId) taskPointerId.current = null; }}
        onClickCapture={admitClick}>
        {controller.page.kind === "Root" ? root : <NexusPages controller={controller} mobile />}
      </div>
    </MobileFullScreenTask>
  );
}
