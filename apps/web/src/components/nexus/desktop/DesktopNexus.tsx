"use client";

// One fixed page: the query and commands, a scrollable block, the apparatus, and the search catchword.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import AsterismMark from "@/components/AsterismMark";
import { ExcerptDialog } from "@/components/resources/ExcerptDisclosure";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import Input from "@/components/ui/Input";
import ModalFrame from "@/components/ui/ModalFrame";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { ContextualActionsInput } from "@/lib/actions/useContextualActions";
import type { NexusCommandId, NexusRow } from "@/lib/nexus/model";
import { ARRIVAL_ONSET_MS, PASSAGE_CAP, RULING_DELAY_MS, STAR_GRACE_MS, STAR_ONSET_MS } from "@/lib/nexus/policy";
import { flattenedPaste, NEXUS_COMMANDS, TODAY_ALIAS } from "@/lib/nexus/query";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ResourceItem } from "@/lib/resources/items";
import { formatShortcut, SHORTCUTS, shortcutAriaKeys, usesMeta } from "@/lib/shortcuts";
import { revealCollectionItem } from "@/lib/ui/collection";
import { isTopmostInteractionOwner } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { NexusNotices, nexusRowAlias, nexusRowName, nexusRowVerbs, typedSideHead } from "../NexusRow";
import NexusPages from "../NexusPages";
import type { NexusController } from "../useNexusController";
import HeadwordRow from "./HeadwordRow";
import styles from "./Headword.module.css";

const GRID_ID = "desktop-nexus-results";
const APPARATUS_ID = "desktop-nexus-apparatus";
const SEARCH_ID = "desktop-nexus-search";
const NOTICE_ID = "desktop-nexus-notices";
const HELP_ID = "desktop-nexus-help";
type EnterChord = "Follow" | "Fork" | "Nexus.Ask" | "Nexus.Keep" | "Nexus.KeepOpen";
const LEGEND: readonly { word: string; id: NexusCommandId | "today" }[] = [
  { word: "note", id: "Nexus.Quick.Note" }, { word: "ask", id: "Nexus.Quick.Chat" },
  { word: "import", id: "Nexus.Quick.Import" }, { word: "today", id: "today" },
  { word: "page", id: "Nexus.Quick.Page" }, { word: "library", id: "Nexus.Quick.Library" },
  { word: "browse", id: "Nexus.Quick.Browse" },
];

function candidateId(key: string): string { return `desktop-nexus-candidate-${encodeURIComponent(key)}`; }

export default function DesktopNexus({ controller }: { controller: NexusController }) {
  const { platform } = useRenderEnvironment();
  const inputRef = useRef<HTMLInputElement>(null);
  const workflowRef = useRef<HTMLDivElement>(null);
  const importBody = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const composing = useRef(false);
  const caret = useRef<{ start: number; end: number; direction: "forward" | "backward" | "none" } | null>(null);
  const [excerpt, setExcerpt] = useState<ResourceItem | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [legendWord, setLegendWord] = useState<NexusCommandId | "today" | null>(null);
  const [chord, setChord] = useState<EnterChord | null>("Follow");
  if (!controller.open && excerpt !== null) setExcerpt(null);
  const typed = controller.rootMode === "Typed";
  const { intent, text } = controller.parsed;
  const argument = controller.commandArgument;
  const lookup = intent.kind === "CommandLookup";
  const results = controller.groups.find(group => group.id === "Results")?.rows ?? [];
  const block = typed ? results.filter(row => row.class !== "Passage") : controller.groups.filter(group => group.id === "Continuations" || group.id === "Recent").flatMap(group => group.rows);
  const apparatus = typed ? results.filter(row => row.class === "Passage") : controller.groups.find(group => group.id === "Closed")?.rows ?? [];
  const catchword = typed ? controller.continuations[0] ?? null : null;
  const searchPrefix = lookup ? "search for" : "all results for";
  const rows = [...block, ...apparatus, ...(catchword ? [catchword] : [])];
  const index = rows.findIndex(row => row.key === controller.selectedKey);
  const active = rows[index] ?? null;
  const withdrawn = controller.list.selection.kind === "Withdrawn";
  const firstDown = block[0] ?? apparatus[0] ?? (lookup || withdrawn ? catchword : null);
  const held = new Set(controller.list.held);
  const listed = new Set(controller.list.rows.map(row => row.key));
  const verbs = active ? nexusRowVerbs(active, active.state === "Current", controller, setExcerpt) : null;
  const occurrence = verbs?.menu?.sections?.[0]?.actions ?? [];
  const menu: ContextualActionsInput | null = verbs?.menu && (verbs.menu.resourceRef !== undefined || occurrence.length > 0)
    ? { ...verbs.menu, sections: [{ id: "Occurrence", actions: [...verbs.pair, ...occurrence] }] } : null;
  const pointerPress = useRef<{ key: string; x: number; y: number; moved: boolean } | null>(null);
  const pointerRest = useRef<{ x: number; y: number } | "Travelled" | null>(null);

  useLayoutEffect(() => { pointerRest.current = null; }, [controller.open, controller.query, withdrawn]);
  useLayoutEffect(() => {
    const port = listRef.current;
    if (!controller.open || controller.page.kind !== "Root" || !port) return;
    port.scrollTop = controller.rootScroll.current[controller.rootMode];
  }, [controller.open, controller.page.kind, controller.rootMode, controller.query, controller.rootScroll]);
  useLayoutEffect(() => {
    const port = listRef.current;
    const item = controller.selectedKey === null ? null : document.getElementById(candidateId(controller.selectedKey));
    if (port && item && port.contains(item)) revealCollectionItem(port, item);
  }, [controller.open, controller.page.kind, controller.selectedKey, index]);
  useEffect(() => {
    const change = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        const primary = usesMeta(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        setChord(primary && !event.shiftKey && !event.altKey ? "Nexus.Ask" : null);
      } else if (event.altKey) setChord(event.shiftKey ? "Nexus.KeepOpen" : "Nexus.Keep");
      else setChord(event.shiftKey ? "Fork" : "Follow");
    };
    const clear = () => setChord("Follow");
    document.addEventListener("keydown", change, true);
    document.addEventListener("keyup", change, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      document.removeEventListener("keydown", change, true);
      document.removeEventListener("keyup", change, true);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [platform]);

  function movePointer(key: string, event: PointerEvent<HTMLDivElement>) {
    const press = pointerPress.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
    if (event.pointerType === "touch") return;
    const rest = pointerRest.current;
    if (rest === null) { pointerRest.current = { x: event.clientX, y: event.clientY }; return; }
    if (rest !== "Travelled") {
      if (Math.hypot(event.clientX - rest.x, event.clientY - rest.y) < 8) return;
      pointerRest.current = "Travelled";
    }
    if (document.activeElement === inputRef.current) controller.selectRow(key);
  }

  function openMenu() {
    const input = inputRef.current;
    caret.current = input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0, direction: input.selectionDirection ?? "none" } : null;
    triggerRef.current?.click();
  }
  const { submitRow } = controller;
  const shortcutWord = chord === "Nexus.Ask" ? "Nexus.Quick.Chat" : chord === "Nexus.Keep" || chord === "Nexus.KeepOpen" ? "Nexus.Quick.Note" : null;
  const command = shortcutWord ?? legendWord;
  const target = submitRow?.action.kind === "Available" ? submitRow.action.target : null;
  const reason = command === null && submitRow?.action.kind === "Unavailable" ? submitRow.action.reason : null;
  const fork = command !== null ? command !== "Nexus.Quick.Import" : target !== null && target.kind !== "OpenImport" && target.kind !== "RestorePane";
  const searchAction = catchword !== null && submitRow?.key === catchword.key;
  const searchCue = searchAction && inputFocused && command === null && chord !== null && reason === null;
  const enterKey = chord === "Follow" ? "↵" : chord === "Fork" ? "⇧↵" : chord === null ? null
    : formatShortcut(SHORTCUTS[chord], platform).replace(/enter/i, "↵").toLowerCase();
  let verb = reason ?? (submitRow === null || searchAction ? null : target?.kind === "RestorePane" ? "reopen"
    : /^(QuickAction|Intent):/.test(submitRow.key) ? "run" : submitRow.key.startsWith("Import:") ? "import"
    : submitRow.class === "Passage" ? "open at this passage" : submitRow.key === "Continuation:UseText" ? "use this text" : "open");
  if (command !== null) {
    const legendVerbs: Record<NexusCommandId | "today", string> = {
      "Nexus.Quick.Note": argument ? "save to today" : "open today at a new line",
      "Nexus.Quick.Chat": argument ? "ask the librarian" : "open the librarian",
      "Nexus.Quick.Import": "open import", today: "open today",
      "Nexus.Quick.Page": argument ? "new page with this title" : "new page",
      "Nexus.Quick.Library": argument ? "new library with this name" : "new library", "Nexus.Quick.Browse": "browse…",
    };
    verb = legendVerbs[command];
  }
  if (fork && verb && (chord === "Fork" || chord === "Nexus.KeepOpen")) {
    verb = command === "Nexus.Quick.Note" && argument ? "save and open today in a new pane" : `${verb} in a new pane`;
  }
  const browseHint = active || !firstDown ? null : firstDown === catchword ? lookup ? "literal search" : "all results"
    : typed ? firstDown.class === "Passage" ? "first passage" : "first result"
    : firstDown.key === "Continuation:UseText" ? "selection" : firstDown.key.startsWith("Closed:") ? "closed" : "recent";

  const renderRow = (row: NexusRow, sideHead: string) => {
    const selected = row.key === controller.selectedKey;
    const locator = row.state === "Current" ? "here" : row.action.kind === "Available" && row.action.target.kind === "RestorePane" ? "closed" : nexusRowAlias(row, true);
    return <div key={row.key} role="row" aria-selected={selected} className={styles.line} data-active={selected || undefined}
      data-band={listed.has(row.key) && !held.has(row.key) ? "arriving" : undefined}>
      <div id={candidateId(row.key)} role="gridcell" aria-label={nexusRowName(row, row.state === "Current", null)} className={styles.cell}
        onPointerMove={event => movePointer(row.key, event)}>
        <div className={styles.primary} aria-disabled={row.action.kind === "Unavailable" || undefined}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0) return;
            pointerPress.current = { key: row.key, x: event.clientX, y: event.clientY, moved: false };
            if (event.pointerType !== "touch") event.preventDefault();
          }}
          onPointerCancel={() => { pointerPress.current = null; }}
          onClick={event => {
            const press = pointerPress.current;
            pointerPress.current = null;
            if (event.detail !== 0 && (!press || press.key !== row.key || press.moved)) return;
            const activation = workspaceTargetActivationIntent(event);
            if (activation.kind === "Unowned") return;
            event.preventDefault();
            if (activation.kind === "Consume") return;
            controller.selectRow(row.key);
            controller.activate(row.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, row);
          }}>
          <HeadwordRow row={row} query={controller.query} sideHead={sideHead} />
        </div>
        <span className={styles.locator}>
          {locator}
          {selected && menu ? <ContextualActionMenu {...menu} label={`options for ${row.label}`} triggerAttributes={{ tabIndex: -1 }}
            renderTrigger={props => <OverflowMenuButton {...props} onClickCapture={() => controller.selectRow(row.key)}
              onKeyDown={event => {
                const arrow = !event.defaultPrevented && (event.key === "ArrowUp" || event.key === "ArrowDown");
                props.onKeyDown(event);
                if (arrow && event.defaultPrevented) controller.selectRow(row.key);
              }} />}
            triggerRef={node => { triggerRef.current = node; }} returnFocusTo={() => inputRef.current}
            onOpenChange={open => {
              const input = inputRef.current;
              if (open) {
                caret.current = input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0, direction: input.selectionDirection ?? "none" } : null;
                return;
              }
              const saved = caret.current;
              if (input && saved) input.setSelectionRange(saved.start, saved.end, saved.direction);
            }} /> : null}
        </span>
      </div>
    </div>;
  };
  const bands: { label: string; sideHead: string; rows: NexusRow[] }[] = [];
  for (const row of block) {
    const sideHead = typed ? typedSideHead(row, controller.list.first)
      : row.key === "Continuation:UseText" ? "selection" : "recent";
    const label = sideHead || "first";
    const last = bands.at(-1);
    if (last?.label === label) last.rows.push(row);
    else bands.push({ label, sideHead, rows: [row] });
  }

  return <ModalFrame open={controller.open} interactionLayer={controller.interactionLayer} scope="Nexus" onDismiss={controller.escape}
    label={controller.dialogLabel} slipContent={controller.page.kind === "Root" ? listRef : controller.page.kind === "Import" ? importBody : workflowRef}
    initialFocus={controller.initialFocus} skipReturnFocus={controller.suppressReturnFocus} returnFocusTo={controller.returnFocusTo}
    returnFocusFallback={controller.returnFocusFallback} focusKey={controller.focusKey} backdropClassName={styles.backdrop} className={styles.page}>
    {controller.page.kind !== "Root" ? <div ref={workflowRef} className={styles.workflow}><NexusPages scrollRef={importBody} controller={controller} mobile={false} /></div> : <>
      <h2 className="sr-only" tabIndex={-1} data-switchboard-heading>Nexus</h2>
      <div className={styles.query}>
        <span className={styles.star} aria-hidden="true" style={{ "--star-grace": `${STAR_GRACE_MS}ms`, "--star-onset": `${STAR_ONSET_MS}ms` } as CSSProperties}>
          <AsterismMark size="1.25rem" lit={[
            controller.sources.device === "Idle" || controller.sources.device === "Answered",
            controller.sources.names === "Idle" || controller.sources.names === "Answered",
            controller.sources.texts === "Idle" || controller.sources.texts === "Answered",
          ]} />
        </span>
        <Input ref={inputRef} bare role="combobox" aria-label="find anything…" aria-autocomplete="list" aria-haspopup="grid" aria-controls={GRID_ID}
          aria-expanded="true" aria-activedescendant={inputFocused && active ? candidateId(active.key) : undefined}
          aria-describedby={lookup ? `${HELP_ID} ${NOTICE_ID}-guidance` : HELP_ID} className={styles.input}
          value={controller.query} placeholder="find anything…" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onFocus={() => { setInputFocused(true); setLegendWord(null); }} onBlur={() => setInputFocused(false)}
          onChange={event => controller.setQuery(event.currentTarget.value)}
          onPaste={event => { const value = flattenedPaste(event); if (value !== null) controller.setQuery(value); }}
          onCompositionStart={() => { composing.current = true; controller.setComposing(true); }}
          onCompositionEnd={() => { composing.current = false; controller.setComposing(false); }}
          onKeyDown={event => {
            pointerRest.current = null;
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
            if (event.defaultPrevented || !isTopmostInteractionOwner("Nexus")) return;
            const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
            const input = event.currentTarget;
            const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            if (event.key === "Tab") { event.preventDefault(); if (plain && menu) openMenu(); }
            else if (plain && event.key === "ArrowRight" && atEnd && menu) { event.preventDefault(); openMenu(); }
            else if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              if (event.key === "ArrowUp" && index <= 0) { legendRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); return; }
              const next = index < 0 ? firstDown : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
              if (next) controller.selectRow(next.key);
            } else if (event.key === "Enter") {
              const activation = workspaceTargetActivationIntent(event, "activate");
              if (activation.kind === "Unowned") return;
              event.preventDefault();
              if (activation.kind === "Open") controller.submit({ disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
            } else if (event.key === "Escape") { event.preventDefault(); controller.escape(); }
          }} />
      </div>
      <div ref={legendRef} role="toolbar" aria-label="commands" aria-orientation="horizontal" className={styles.legend}
        onKeyDownCapture={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
          if (event.defaultPrevented || !isTopmostInteractionOwner("Nexus") || event.altKey || event.ctrlKey || event.metaKey) return;
          const claim = () => { event.preventDefault(); event.stopPropagation(); };
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const at = buttons.findIndex(button => button === document.activeElement);
          if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
            claim();
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowLeft" ? -1 : 1)));
            buttons[next]?.focus({ preventScroll: true });
          } else if (event.key === "ArrowDown" || event.key === "Escape") { claim(); inputRef.current?.focus({ preventScroll: true }); }
          else if (event.key === "Tab" || event.key === "ArrowUp") claim();
          else if (event.key === "Backspace" || event.key.length === 1) {
            claim();
            controller.setQuery(event.key === "Backspace" ? Array.from(controller.query).slice(0, -1).join("") : controller.query + event.key);
            inputRef.current?.focus({ preventScroll: true });
          } else if (event.key === "Enter") {
            const activation = workspaceTargetActivationIntent(event, "activate");
            claim();
            const word = LEGEND[at];
            if (word && activation.kind === "Open") controller.runLegend(word.id, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
          }
        }} onKeyUpCapture={event => { if (event.key === " ") event.preventDefault(); }}>
        {LEGEND.map(({ word, id }) => {
          const alias = id === "today" ? TODAY_ALIAS : NEXUS_COMMANDS[id].aliases[0];
          const shortcut = id === "Nexus.Quick.Note" ? SHORTCUTS["Nexus.Keep"] : id === "Nexus.Quick.Chat" ? SHORTCUTS["Nexus.Ask"] : null;
          const key = lookup ? alias : shortcut ? usesMeta(platform) ? id === "Nexus.Quick.Note" ? "⌥↵" : "⌘↵" : id === "Nexus.Quick.Note" ? "alt+↵" : "ctrl+↵" : alias;
          const lit = lookup || intent.kind === "Command" && intent.id === id || intent.kind === "Destination" && intent.id === "today" && id === "today"
            || intent.kind === "ImportLinks" && id === "Nexus.Quick.Import" || shortcutWord === id;
          return <button key={id} type="button" tabIndex={-1} className={styles.word} data-lit={lit || undefined}
            aria-keyshortcuts={shortcut ? shortcutAriaKeys(shortcut, platform) : undefined} onFocus={() => setLegendWord(id)}
            onBlur={() => setLegendWord(null)} onClick={event => {
              const activation = workspaceTargetActivationIntent(event);
              if (activation.kind !== "Open") return;
              event.preventDefault();
              controller.runLegend(id, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } });
            }}>{word}{id === "Nexus.Quick.Import" && controller.importing > 0 ? ` · ${controller.importing}` : ""}<span className={styles.key} aria-hidden="true">{key}</span></button>;
        })}
      </div>
      <div ref={listRef} className={styles.block} aria-busy={controller.busy || undefined}
        onScroll={event => { controller.rootScroll.current[controller.rootMode] = event.currentTarget.scrollTop; }}>
        <div id={GRID_ID} role="grid" aria-label={typed ? "find results" : "nexus options"} aria-colcount={1}
          aria-owns={`${APPARATUS_ID}${catchword ? ` ${SEARCH_ID}` : ""}`} style={{ "--arrival-onset": `${ARRIVAL_ONSET_MS}ms` } as CSSProperties}>
          {bands.map(band => <div key={band.label} role="rowgroup" aria-label={band.label}>{band.rows.map((row, at) => renderRow(row, at === 0 ? band.sideHead : ""))}</div>)}
        </div>
        {typed && intent.kind === "Search" && block.length === 0 && controller.sources.device !== "Waiting" && controller.sources.names !== "Waiting" ? <p className={styles.empty}>nothing by that name.</p> : null}
        <NexusNotices controller={controller} id={NOTICE_ID} set="Block" returnFocus={() => inputRef.current} />
      </div>
      <div className={styles.apparatus} style={{ "--arrival-onset": `${ARRIVAL_ONSET_MS}ms`, "--ruling-delay": `${RULING_DELAY_MS}ms` } as CSSProperties}>
        <div id={APPARATUS_ID} role="rowgroup" aria-label={typed ? "passages" : "closed"}>{apparatus.map((row, at) => renderRow(row, at === 0 ? typed ? "passages" : "closed" : ""))}</div>
        <NexusNotices controller={controller} id={`${NOTICE_ID}-apparatus`} set="Apparatus" returnFocus={() => inputRef.current} />
        {controller.sources.texts === "Waiting" ? Array.from({ length: PASSAGE_CAP - apparatus.length }, (_, at) => <div key={at} className={styles.waiting} aria-hidden="true" />) : null}
      </div>
      <div className={styles.foot}>
        <span className={styles.hints} aria-hidden="true">
          {inputFocused && chord === "Follow" && browseHint ? <span>↓ {browseHint}</span> : null}
          {inputFocused && chord === "Follow" && !active && (!typed || !browseHint) && !reason ? <span>↑ commands</span> : null}
          {(inputFocused || legendWord !== null) && verb && (enterKey || reason) ? <span>{reason ? null : `${enterKey} `}<span className={styles.verb}>{verb}</span></span> : null}
          {(inputFocused || legendWord !== null) && fork && chord === "Follow" ? <span>⇧↵ new pane</span> : null}
          {inputFocused && menu && chord === "Follow" ? <span>⇥ more</span> : null}
        </span>
        {catchword ? <div id={SEARCH_ID} role="rowgroup" aria-label="search" className={styles.search}>
          <div role="row" aria-selected={catchword.key === controller.selectedKey} data-active={catchword.key === controller.selectedKey || undefined}>
            <div id={candidateId(catchword.key)} role="gridcell" aria-label={`${searchPrefix} “${text}”`}
              aria-disabled={catchword.action.kind === "Unavailable" || undefined}
              onPointerMove={event => movePointer(catchword.key, event)} onPointerDown={event => event.preventDefault()}
              onClick={event => {
                const activation = workspaceTargetActivationIntent(event);
                if (activation.kind !== "Open") return;
                event.preventDefault(); controller.selectRow(catchword.key);
                controller.activate(catchword.action, { disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" } }, catchword);
              }}>
              {searchCue ? <span className={styles.verb}>{enterKey}{chord === "Fork" ? " new pane ·" : ""}</span> : null}
              <span>{searchPrefix}</span><span className={styles.searchQuery}>“{text}”</span>
            </div>
          </div>
        </div> : null}
      </div>
      <span id={HELP_ID} className="sr-only">
        {submitRow?.action.kind === "Unavailable" ? `${submitRow.action.reason}. ` : searchAction ? "enter opens all results for this query. " : active ? "enter activates the selected result. " : null}
        arrows select. shift plus enter opens in a new pane where available. up from the first result reaches commands. tab shows the selected result’s options.
      </span>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{controller.pending ? null : typed ? `${block.length} results. ${apparatus.length} passages.` : `${controller.groups.find(group => group.id === "Recent")?.rows.length ?? 0} recent.`}</div>
      {excerpt ? <ExcerptDialog item={excerpt} onClose={() => setExcerpt(null)} returnFocusTo={() => inputRef.current} /> : null}
    </>}
  </ModalFrame>;
}
