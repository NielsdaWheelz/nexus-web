"use client";

// One mobile task: a keyboard-down workspace index, or explicitly entered search.
import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import { ArrowLeft, ChevronDown, Search, X } from "lucide-react";
import { FeedbackRecoveryControl } from "@/components/feedback/Feedback";
import AccountMenu from "@/components/appnav/AccountMenu";
import { isAccountDestinationId } from "@/components/appnav/navModel";
import { NexusRowBody, NexusRowEvidence, NexusRowMenu, NexusSearchStatus, NexusTitleFailure } from "@/components/nexus/NexusRow";
import NexusPages from "@/components/nexus/NexusPages";
import type { NexusController } from "@/components/nexus/useNexusController";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import MobileFullScreenTask from "@/components/ui/MobileFullScreenTask";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts, rowName } from "@/lib/nexus/rows";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useCollectionLayout } from "@/lib/ui/collection";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import styles from "@/components/nexus/Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

export default function SwitchboardTask({ controller }: { controller: NexusController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useCollectionLayout(bodyRef, controller.open && controller.page.kind === "Root");
  const composing = useRef(false);
  const markSearchInteraction = controller.interact;
  const refreshRevision = useRef(controller.searchRefreshRevision);
  useLayoutEffect(() => {
    if (refreshRevision.current === controller.searchRefreshRevision) return;
    refreshRevision.current = controller.searchRefreshRevision;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [controller.searchRefreshRevision]);
  const taskPointerId = useRef<number | null>(null);
  useEffect(() => {
    if (!controller.open || controller.page.kind !== "Root") return;
    const selected = () => {
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed && (listRef.current?.contains(selection.anchorNode) || listRef.current?.contains(selection.focusNode))) markSearchInteraction();
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [controller.open, controller.page.kind, markSearchInteraction]);
  const previousQuery = useRef(controller.query);
  const picker = controller.rootMode === "NewPane";
  const searching = controller.rootMode !== "Overview";
  useLayoutEffect(() => { if (picker && controller.page.kind === "Root") inputRef.current?.select(); }, [picker, controller.page.kind]);
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

  const root = (
    <div ref={bodyRef} className={`${styles.page} ${styles.searchPage}`}>
      <header className={styles.header}>
        {searching && !picker ? <Button iconOnly icon={<ArrowLeft />} className={styles.iconButton} aria-label="back to workspace" onClick={controller.escape} /> : null}
        <h2 ref={headingRef} tabIndex={-1} data-switchboard-heading>{picker ? "open in new pane" : searching ? "search" : "workspace"}</h2>
        <div className={styles.headerActions}>
          <FeedbackRecoveryControl />
          {picker ? <button type="button" className={styles.allPanes} onClick={controller.escape}>cancel</button> : <><AccountMenu
            activeId={accountId}
            placement="below"
            align="end"
            renderTrigger={(trigger, accountMark) => (
              <Button {...trigger} iconOnly icon={accountMark} className={styles.iconButton} aria-current={accountId === null ? undefined : "page"} />
            )}
            onNavigate={(event, destination) => {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind === "Unowned") return "unhandled";
              event.preventDefault();
              if (activation.kind === "Consume") return "consumed";
              if (!controller.openTarget({ kind: "InternalHref", href: destination.href, labelHint: destination.label }, activation.intent === "new_pane" ? { disposition: { kind: "Fork" } } : undefined)) return "consumed";
              return "handled-destination-focus";
            }}
          />
          <Button iconOnly icon={<X />} className={styles.iconButton} aria-label="close nexus" onClick={controller.close} /></>}
        </div>
      </header>
      <div className={styles.searchInput}>
        <div className={styles.searchField}>
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="search"
            aria-describedby={searching && controller.lookupGuidance !== null ? "mobile-nexus-guidance" : undefined}
            value={controller.query}
            placeholder="find anything…"
            autoComplete="off"
            enterKeyHint={controller.explicitIntent ? "go" : "search"}
            data-mobile-nexus-search
            data-nexus-control="Search"
            onFocus={controller.enterSearch}
            onChange={(event) => controller.setQuery(event.currentTarget.value)}
            onCompositionStart={() => { composing.current = true; controller.setComposing(true); }}
            onCompositionEnd={() => { composing.current = false; controller.setComposing(false); }}
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
                if (activation.kind === "Open") controller.submitInput({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
              }
            }}
          />
          {controller.query ? <Button iconOnly icon={<X />} className={styles.iconButton} aria-label="clear search" onClick={() => { controller.setQuery(""); inputRef.current?.focus(); }} /> : null}
        </div>
        {picker && controller.announcement ? <p className={styles.empty}>{controller.announcement}</p> : null}
        {searching ? <NexusSearchStatus controller={controller} returnFocus={() => inputRef.current} /> : null}
        {searching && controller.lookupGuidance !== null ? <p id="mobile-nexus-guidance" className={styles.empty}>{controller.lookupGuidance}</p> : null}
      </div>
      <div ref={listRef} className={`${collection.fillViewport} ${styles.searchScroll}`} data-collection-viewport="" aria-busy={controller.busy || undefined} data-mode={controller.rootMode} onPointerDownCapture={controller.interact} onFocusCapture={controller.interact} onWheelCapture={controller.interact} onTouchMoveCapture={controller.interact} onKeyDownCapture={controller.interact}>
        <NexusTitleFailure returnFocus={() => searching ? inputRef.current : headingRef.current} />
        {controller.groups.map((group) => (
          <section key={group.id} className={styles.section} data-group={group.id} aria-labelledby={group.label ? `mobile-nexus-group-${group.id}` : undefined}>
            {group.label ? <div className={styles.sectionHeading}><h3 id={`mobile-nexus-group-${group.id}`}>{group.label}</h3>{group.id === "Open" && !searching ? <button type="button" className={styles.allPanes} data-nexus-control="NewPane" onClick={controller.enterNewPane}>new pane…</button> : null}</div> : null}
            <ul className={styles.rows}>
              {group.rows.map((row) => {
                const unavailable = row.action.kind === "Unavailable" ? row.action.reason : null;
                const name = rowName([row.label, rowFacts(row, false), unavailable]);
                const body = row.item?.preview.body;
                const hasEvidence = row.matchingPassage || (body && ((body.kind !== "named" && body.kind !== "media") || (row.match && row.match.excerpt.text !== (body.kind === "media" ? body.media_summary.title : body.kind === "named" ? body.title : null))));
                return (
                  <li key={row.key} className={styles.row} data-current={row.state === "Current" || undefined} data-nested={row.parent ? true : undefined} onPointerDown={() => controller.setActive(row.key)}>
                    <button
                      type="button"
                      className={`${collection.row} ${styles.rowMain}`}
                      data-selected={row.state === "Current" || undefined}
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
                    {row.action.kind === "Available" && row.action.target.kind === "PaneOpen" && row.secondary?.kind === "ClosePane" ? (
                      <Button iconOnly className={styles.rowMenu} aria-label={`close ${row.label}`}
                        onKeyDown={(event) => { if (event.repeat && event.key === "Enter") event.preventDefault(); }}
                        onClick={() => { if (row.secondary?.kind === "ClosePane") controller.closePane(row.secondary.paneId); }}
                        icon={<X size={18} aria-hidden="true" />} />
                    ) : row.secondary?.kind === "TargetMenu" || (picker && row.matchingPassage) ? (
                      <NexusRowMenu row={row} activate={controller.activate} closePane={controller.closePane} destinationHref={controller.destinationHref} mobile picker={picker} menuProps={{
                        label: `more actions for ${row.label}`,
                        align: "end",
                        onOpenChange: (open) => { if (open) controller.setActive(row.key); },
                        renderTrigger: (trigger) => <OverflowMenuButton {...trigger} className={styles.rowMenu} />,
                      }} />
                    ) : null}
                    <NexusRowEvidence row={row} />
                  </li>
                );
              })}
            </ul>
            {group.id === "Open" && !searching ? <button type="button" className={styles.allPanes} data-nexus-control="AllPanes" aria-label={`all ${controller.panes.length} ${controller.panes.length === 1 ? "pane" : "panes"}`} onClick={controller.managePanes}>all panes <span aria-hidden="true">· {controller.panes.length}</span></button> : null}
          </section>
        ))}
        {searching && typed && controller.textActions.length > 0 ? (
          <ActionMenu label="use this text…" align="start" triggerAttributes={{ "data-nexus-control": "UseText" }}
            source={{ kind: "Immediate", subjectKey: `nexus-text:${controller.query}`, title: controller.query, content: { sections: [{ id: "Text", label: null, options: controller.textActions.map((row) => ({ kind: "command", id: row.key, label: row.label, icon: <row.icon size={16} aria-hidden="true" />, onSelect: ({ openIntent }) => controller.activate(row.action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }, row) })) }] } }}
            renderTrigger={(trigger) => <button {...trigger} className={styles.useText}>use this text… <ChevronDown size={16} aria-hidden="true" /></button>}
          />
        ) : null}
        {searching && !typed && controller.groups.length === 0 ? <p className={styles.empty}>search your panes, library and commands.</p> : null}
      </div>
      <div className="sr-only" role="status" aria-label="search status" aria-live="polite" aria-atomic="true">
        {[controller.announcement || (searching ? controller.lookupGuidance : null), searching ? controller.searchProgress.text : null, searching && typed && !controller.pending ? `${results} results shown.` : null].filter(Boolean).join(" ")}
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
