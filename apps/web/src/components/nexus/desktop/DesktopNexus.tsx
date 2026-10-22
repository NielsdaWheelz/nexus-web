"use client";

// The query edits text or browses candidates; native secondary buttons own their actions.
// A browsing-space press belongs to its initial menu trigger until release or cancellation.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ModalFrame from "@/components/ui/ModalFrame";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { assertNever } from "@/lib/assertNever";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { NexusRow } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { NexusRowBody, NexusRowMenu, NexusSourceFailures, NexusTitleFailure } from "../NexusRow";
import NexusPages from "../NexusPages";
import type { NexusController } from "../useNexusController";
import styles from "../Nexus.module.css";

type QueryMode = "Editing" | "Browsing";
type SpacePress = { target: { key: string; button: HTMLButtonElement } | null } | null;
const GRID_ID = "desktop-nexus-results";
const HELP_ID = "desktop-nexus-help";
const MENU_HELP_ID = "desktop-nexus-menu-help";
const CLOSE_HELP_ID = "desktop-nexus-close-help";

function candidateId(key: string): string {
  return `desktop-nexus-candidate-${encodeURIComponent(key)}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export default function DesktopNexus({ controller }: { controller: NexusController }) {
  const { platform } = useRenderEnvironment();
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const spacePress = useRef<SpacePress>(null);
  const focusedSecondary = useRef<HTMLButtonElement | null>(null);
  const [mode, setMode] = useState<QueryMode>("Editing");
  const [inputFocused, setInputFocused] = useState(false);
  const rows = controller.groups.flatMap((group) => group.rows);
  const index = rows.findIndex((row) => row.key === controller.activeKey);
  const active = rows[index];

  useLayoutEffect(() => {
    setMode("Editing");
    spacePress.current = null;
  }, [controller.open, controller.page.kind]);
  useLayoutEffect(() => {
    setMode("Editing");
    if (spacePress.current) spacePress.current.target = null;
  }, [controller.query]);
  useLayoutEffect(() => {
    if (spacePress.current) spacePress.current.target = null;
  }, [controller.activeKey]);
  useLayoutEffect(() => {
    const press = spacePress.current;
    if (press?.target && menus.current.get(press.target.key) !== press.target.button) press.target = null;
    const button = focusedSecondary.current;
    if (!button || button.isConnected) return;
    focusedSecondary.current = null;
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && focus !== document.body && focus.isConnected && !focus.closest("[hidden], [inert]")) return;
    if (isTopmostInteractionOwner("Nexus")) inputRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!controller.open || controller.page.kind !== "Root") return;
    const cancel = () => { if (spacePress.current) spacePress.current.target = null; };
    document.addEventListener("pointerdown", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      spacePress.current = null;
    };
  }, [controller.open, controller.page.kind]);
  useEffect(() => {
    gridRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [controller.activeKey]);

  const select = (row: NexusRow) => {
    if (row.key !== controller.activeKey && spacePress.current) spacePress.current.target = null;
    controller.setActive(row.key);
  };
  const closeTab = (paneId: string) => {
    if (controller.closePane(paneId) !== null) inputRef.current?.focus({ preventScroll: true });
  };
  const typed = controller.query.trim().length > 0;
  const queryActions = controller.groups.find((group) => group.id === "QuickActions")?.rows.length ?? 0;
  const status = typed
    ? `${count(rows.length - queryActions, "result")}. ${count(queryActions, "query action")}.`
    : `${count(rows.length, "item")} in ${count(controller.groups.length, "section")}`;
  const canSelect = active?.action.kind === "Available";
  let opensDestination = false;
  if (active?.action.kind === "Available") {
    const target = active.action.target;
    switch (target.kind) {
      case "Resource":
      case "InternalHref":
      case "PaneOpen":
      case "OpenAcceptedSource":
      case "OpenDailyPage":
      case "CreatePage":
      case "CreateLibrary":
      case "ChooseCreate":
      case "ChooseBrowse":
        opensDestination = true;
        break;
      case "ResumeCurrentPlayback":
      case "OpenAdd":
      case "ManageTabs":
        break;
      default: assertNever(target);
    }
  }
  const menuAvailable = mode === "Browsing" && active?.secondary?.kind === "ResourceMenu";
  const help = [rows.length > 0 ? "up/down browse" : null, canSelect ? opensDestination ? "enter open · shift+enter new tab" : "enter select" : null, menuAvailable ? "space options" : null].filter(Boolean).join(" · ");

  const root = (
    <>
      <h2 className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
      <label className={styles.inputRow}>
        <span className="sr-only">Find anything…</span>
        <Input
          ref={inputRef}
          bare
          role="combobox"
          aria-label="Find anything…"
          aria-autocomplete="list"
          aria-haspopup="grid"
          aria-controls={GRID_ID}
          aria-expanded="true"
          aria-activedescendant={mode === "Browsing" && inputFocused && active ? candidateId(active.key) : undefined}
          aria-describedby={HELP_ID}
          className={styles.input}
          value={controller.query}
          placeholder="Find anything…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setInputFocused(true)}
          onBlur={() => {
            setInputFocused(false);
            spacePress.current = null;
          }}
          onPointerDown={() => setMode("Editing")}
          onBeforeInput={() => {
            setMode("Editing");
            if (spacePress.current) spacePress.current.target = null;
          }}
          onChange={(event) => {
            setMode("Editing");
            if (spacePress.current) spacePress.current.target = null;
            controller.setQuery(event.currentTarget.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
            setMode("Editing");
            if (spacePress.current) spacePress.current.target = null;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== " " && spacePress.current) spacePress.current.target = null;
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              // The modal's document-level Escape owner must not see an IME key.
              event.stopPropagation();
              return;
            }
            if (event.defaultPrevented || !isTopmostInteractionOwner("Nexus")) return;
            if (event.key === " " && spacePress.current) {
              event.preventDefault();
              return;
            }
            const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            if (event.key === " " && plain && mode === "Browsing") {
              event.preventDefault();
              if (!event.repeat) {
                const button = active?.secondary?.kind === "ResourceMenu" ? menus.current.get(active.key) : null;
                spacePress.current = { target: button && active ? { key: active.key, button } : null };
              }
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && rows.length > 0) {
              event.preventDefault();
              const down = event.key === "ArrowDown";
              const next = rows[index < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (down ? 1 : -1)))]!;
              select(next);
              setMode("Browsing");
            } else if (event.key === "Enter") {
              const activation = workspaceTargetActivationIntent(event, "activate");
              if (activation.kind === "Unowned") return;
              event.preventDefault();
              if (activation.kind === "Consume") return;
              if (!active) {
                controller.submitSearch({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
                return;
              }
              controller.activate(
                active.action,
                { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } },
                active,
              );
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (controller.query) controller.setQuery("");
              else controller.escape();
            } else if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown", "Backspace", "Delete"].includes(event.key)
              || ((event.ctrlKey || event.metaKey) && ["a", "x", "v", "z", "y"].includes(event.key.toLowerCase()))
              || (platform === "mac" && event.ctrlKey && !event.altKey && !event.metaKey && ["b", "e", "f", "n", "p"].includes(event.key.toLowerCase()))) {
              setMode("Editing");
            }
          }}
          onKeyUp={(event) => {
            if (event.key !== " " || spacePress.current === null) return;
            const press = spacePress.current;
            spacePress.current = null;
            event.preventDefault();
            const target = press.target;
            if (target && target.key === controller.activeKey && menus.current.get(target.key) === target.button
              && target.button.isConnected && controller.open && controller.page.kind === "Root" && mode === "Browsing"
              && document.activeElement === event.currentTarget && isTopmostInteractionOwner("Nexus")) target.button.click();
          }}
        />
      </label>
      <div className={styles.help} aria-hidden="true">{help}</div>
      <span id={HELP_ID} className="sr-only">
        {rows.length > 0 ? "up and down arrows browse results. " : ""}
        {canSelect ? opensDestination ? "enter opens the selected result. shift plus enter opens in a new tab. " : "enter selects the highlighted action. " : ""}
        {menuAvailable ? "space opens options on release." : ""}
      </span>
      <span id={MENU_HELP_ID} className="sr-only">enter or space opens options. escape returns to the query.</span>
      <span id={CLOSE_HELP_ID} className="sr-only">enter or space closes this tab.</span>
      <NexusSourceFailures failures={controller.failures} semanticUnavailable={controller.semanticUnavailable} searchUnavailable={controller.searchUnavailable} retry={controller.retry} retrying={controller.retrying} returnFocus={() => inputRef.current} />
      <NexusTitleFailure failed={controller.titlesFailed} retry={controller.retryTitles} returnFocus={() => inputRef.current} />
      <div
        ref={gridRef}
        id={GRID_ID}
        role="grid"
        aria-label={typed ? "Find results" : "Nexus options"}
        aria-colcount={1}
        aria-busy={controller.busy || undefined}
        className={styles.grid}
      >
        {controller.groups.map((group) => (
          <div key={group.id} role="rowgroup" aria-labelledby={`desktop-nexus-section-${group.id}`} className={styles.group}>
            <div role="row" className={styles.headingRow}>
              <div role="gridcell">
                <h3 id={`desktop-nexus-section-${group.id}`}>{group.label}</h3>
              </div>
            </div>
            {group.rows.map((row) => {
              const selected = row.key === controller.activeKey;
              const ownExcerpt = row.match?.excerpt.text;
              const snippet = row.matchingPassage?.match?.excerpt.text
                ?? ((row.item?.preview.body.kind === "named" && ownExcerpt === row.item.preview.body.title) || (row.item?.preview.body.kind === "media" && ownExcerpt === row.item.preview.body.media_summary.title) ? undefined : ownExcerpt);
              const passageFacts = row.matchingPassage
                ? resourceMetadataText(row.matchingPassage.item, row.matchingPassage.match_method)
                : undefined;
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
                    id={candidateId(row.key)}
                    role="gridcell"
                    aria-label={[row.label, rowFacts(row, true), snippet, passageFacts, reason].filter(Boolean).join(". ")}
                    className={styles.candidateCell}
                    data-browsing-active={(selected && mode === "Browsing" && inputFocused) || undefined}
                    onPointerMove={() => { if (document.activeElement === inputRef.current) select(row); }}
                  >
                    <div
                      className={styles.primaryCell}
                      aria-disabled={reason ? true : undefined}
                      onPointerDown={() => select(row)}
                      onClick={(event) => {
                        const activation = workspaceTargetActivationIntent(event);
                        if (activation.kind === "Unowned") return;
                        event.preventDefault();
                        if (activation.kind === "Consume") return;
                        select(row);
                        controller.activate(
                          row.action,
                          { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } },
                          row,
                        );
                      }}
                    >
                      <NexusRowBody row={row} desktop />
                    </div>
                    {row.secondary?.kind === "CloseTab" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        tabIndex={selected ? 0 : -1}
                        className={styles.actionsButton}
                        aria-label={`close ${row.label}`}
                        aria-describedby={CLOSE_HELP_ID}
                        title={`close ${row.label}`}
                        onFocus={(event) => {
                          focusedSecondary.current = event.currentTarget;
                          select(row);
                        }}
                        onBlur={() => { focusedSecondary.current = null; }}
                        onKeyDown={(event) => {
                          if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
                        }}
                        onClick={() => {
                          select(row);
                          if (row.secondary?.kind === "CloseTab") closeTab(row.secondary.paneId);
                        }}
                      >
                        <X size={18} aria-hidden="true" />
                      </Button>
                    ) : row.secondary?.kind === "ResourceMenu" ? <NexusRowMenu
                      row={row}
                      activate={controller.activate}
                      closePane={controller.closePane}
                      menuProps={{
                        label: `options for ${row.label}`,
                        align: "end",
                        className: styles.rowMenu,
                        triggerAttributes: { tabIndex: selected ? 0 : -1 },
                        triggerRef: (button) => {
                          if (button) menus.current.set(row.key, button);
                          else menus.current.delete(row.key);
                        },
                        returnFocusTo: () => inputRef.current,
                        renderTrigger: (trigger) => (
                          <OverflowMenuButton
                            {...trigger}
                            aria-describedby={MENU_HELP_ID}
                            className={styles.actionsButton}
                            onFocus={(event) => {
                              focusedSecondary.current = event.currentTarget;
                              select(row);
                            }}
                            onBlur={() => { focusedSecondary.current = null; }}
                            onClick={(event) => {
                              select(row);
                              trigger.onClick(event);
                            }}
                          />
                        ),
                      }}
                    /> : null}
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
      open={controller.open}
      interactionLayer={controller.interactionLayer}
      scope="Nexus"
      onDismiss={controller.escape}
      label={controller.dialogLabel}
      initialFocus={controller.initialFocus}
      skipReturnFocus={controller.suppressReturnFocus}
      returnFocusTo={controller.returnFocusTo}
      returnFocusFallback={controller.returnFocusFallback}
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
