"use client";

// The verb rail: one row's verbs as an inline toolbar, on both surfaces. A projection over the row's
// menu source (`useContextualActions`) plus the palette's own verbs: the fixed pair, the first read
// verbs `RAIL_VERBS` names until RAIL_CHIPS, `close pane` where the row is a pane, then `more`, which
// opens the existing contextual menu over the same input. Typing filters, arrows and tab move, enter
// runs the focused verb once through `activateDescriptor`; it owns no verb and reads only on open. The
// rail and the menu each own their read, so opening the menu never unsettles the rail's verbs.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Ellipsis } from "lucide-react";
import { ControlContents } from "@/components/ui/control";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import selection from "@/components/ui/Selection.module.css";
import Tooltip from "@/components/ui/Tooltip";
import { useContextualActions, type ContextualActionsInput } from "@/lib/actions/useContextualActions";
import type { Rail } from "@/lib/nexus/model";
import { RAIL_CHIPS, RAIL_VERBS } from "@/lib/nexus/policy";
import { nameTier } from "@/lib/nexus/rank";
import { activateDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import type { NexusRowVerbs, NexusVerb } from "./NexusRow";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

const MORE = "more";
const NO_MENU: ContextualActionsInput = { title: "", subjectKey: "nexus:none", sections: [], navigation: null };

/** A filter keeps a verb whose label it names exactly or by prefix or token (the rows' matcher). */
function named(filter: string, label: string): boolean {
  const tier = nameTier(filter, label, []);
  return tier === "Exact" || tier === "PrefixOrToken";
}

export default function NexusVerbRail({ id, label, verbs, rail, controller, mobile, className, onClose, returnFocusTo }: {
  /** The toolbar's id, which the row's `…` controls. */
  readonly id: string;
  /** The `…`'s name. */
  readonly label: string;
  readonly verbs: NexusRowVerbs;
  readonly rail: NonNullable<Rail>;
  readonly controller: Pick<NexusController, "focusRail" | "filterRail" | "announce">;
  readonly mobile: boolean;
  readonly className?: string;
  /** Close the rail; `restoreFocus` returns to where it was opened from. */
  readonly onClose: (restoreFocus: boolean) => void;
  readonly returnFocusTo: () => HTMLElement | null;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const source = useContextualActions(verbs.menu ?? NO_MENU);
  const prepare = verbs.read && source.kind === "Prepared" ? source.prepare : null;
  useEffect(() => {
    if (prepare === null) return;
    const request = new AbortController();
    prepare(request.signal);
    return () => request.abort();
  }, [prepare]);
  const sections = source.kind === "Immediate" ? source.content.sections : [
    ...source.initial.sections,
    ...(source.state?.kind === "Ready" ? source.state.content.sections : []),
    ...(source.trailing?.kind === "Ready" ? [{ id: "Trailing", label: null, options: source.trailing.options }] : []),
  ];
  const busy = verbs.read && source.kind === "Prepared" && (source.state === null || source.state.kind === "Loading" || source.trailing?.kind === "Loading");
  const options = sections.flatMap(section => section.options);
  // `more`'s menu is anchored to `more`, so while it is open the rail holds the read verbs it shows: a
  // read settling behind the menu would move its anchor and invalidate it. The rail closes with the menu.
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  // Danger never takes a slot; a slot keeps its verb when it is unavailable.
  const reads = verbs.read ? RAIL_VERBS.filter(verbId => held === null || held.has(verbId)).flatMap(verbId => options.filter((option): option is NexusVerb =>
    (option.kind === "command" || option.kind === "link") && option.id === verbId && option.tone !== "danger").slice(0, 1))
    .slice(0, RAIL_CHIPS - verbs.pair.length - (verbs.close ? 1 : 0)) : [];
  // The sheet's row is its own `open`.
  const pair = mobile ? verbs.pair.filter(verb => verb.id !== "Nexus.Open") : verbs.pair;
  const chips = [...pair, ...reads, ...(verbs.close ? [verbs.close.verb] : [])];
  const fixed = new Set(pair.map(verb => verb.id));
  const visibleFor = (filter: string) => [...chips.filter(verb => fixed.has(verb.id) || filter === "" || named(filter, verb.label)).map(verb => verb.id), ...(verbs.menu ? [MORE] : [])];
  const order = visibleFor(rail.filter);
  const initial = chips[pair.length]?.id ?? (verbs.menu ? MORE : chips[0]?.id ?? null);
  const focus = [rail.focus, initial].find(verbId => verbId !== null && order.includes(verbId)) ?? order[0] ?? null;
  const { focusRail, filterRail } = controller;
  // Initial focus is the first verb after the pair, pinned by id so a settling read never moves it.
  useLayoutEffect(() => { if (rail.focus === null && initial !== null) focusRail(initial); }, [rail.focus, initial, focusRail]);
  // Only moving the rail's focus takes the document's focus: a settling read must not pull it back
  // from `more`'s open menu.
  useLayoutEffect(() => {
    const element = focus === null ? null : toolbar.current?.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(focus)}"]`);
    if (element && element !== document.activeElement) element.focus({ preventScroll: true });
  }, [focus]);
  const shown = order.join("\n");
  useLayoutEffect(() => {
    const bar = toolbar.current;
    const element = focus === null ? null : bar?.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(focus)}"]`);
    if (!bar || !element) return;
    // Reveal the focused verb by scrolling the rail alone, also when a settling read inserts verbs
    // before it; the list never moves for it.
    const port = bar.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const start = port.left + bar.clientLeft;
    const end = start + bar.clientWidth;
    if (box.left < start) bar.scrollLeft -= start - box.left;
    else if (box.right > end) bar.scrollLeft += box.right - end;
  }, [focus, shown]);

  // A hint is a key that acts: the pair's enter keys, or a letter that leaves its verb alone.
  const hint = (verb: NexusVerb): string | null => {
    if (mobile) return null;
    if (verb.id === "Nexus.Open") return "↵";
    if (verb.id === "Nexus.OpenInNewPane") return "⇧↵";
    const letter = verb.label.charAt(0).toLowerCase();
    const others = [...chips.filter(other => other !== verb && !fixed.has(other.id)).map(other => other.label), ...(verbs.menu ? [MORE] : [])];
    return letter && others.every(other => !other.toLowerCase().split(/\s+/).some(word => word.startsWith(letter))) ? letter : null;
  };
  const filter = (next: string) => {
    const visible = visibleFor(next);
    // Typing focuses the first verb it leaves, else the pair verb it names.
    const typed = next === "" ? undefined : visible.find(verbId => verbId !== MORE && !fixed.has(verbId)) ?? pair.find(verb => named(next, verb.label))?.id;
    filterRail(next);
    focusRail(typed ?? (focus !== null && visible.includes(focus) ? focus : visible[0] ?? null));
  };
  const run = (verb: NexusVerb, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if ("key" in event) {
      if (event.key !== "Enter") return;
      if (event.repeat) { event.preventDefault(); return; }
    }
    if (verb.disabled || verb.busy) {
      event.preventDefault();
      if ("key" in event && verb.disabledReason) controller.announce(verb.disabledReason);
      return;
    }
    const result = activateDescriptor(verb, event, event.currentTarget, onClose);
    if (result === "selected" || result === "consumed" || (result === "unhandled" && "key" in event)) return;
    onClose(result === "unhandled" && verb.restoreFocusOnClose !== false);
  };

  const chip = (verb: NexusVerb, index: number) => {
    const focused = verb.id === focus;
    const reason = verb.disabled && verb.disabledReason ? `${id}-reason-${index}` : undefined;
    const key = hint(verb);
    const attributes = {
      "data-action-id": verb.id,
      "data-action-availability": verb.disabled ? "Blocked" : "Available",
      tabIndex: focused ? 0 : -1,
      className: cx(selection.surface, selection.target, styles.verb, focused && selection.selected),
      "aria-label": verbs.close?.verb === verb ? verbs.close.name : undefined,
      "aria-keyshortcuts": mobile ? undefined : verb.id === "Nexus.Open" ? "Enter" : verb.id === "Nexus.OpenInNewPane" ? "Shift+Enter" : undefined,
      "aria-disabled": verb.disabled || undefined,
      "aria-busy": verb.busy || undefined,
      "aria-haspopup": verb.hasPopup,
      "aria-describedby": reason,
      onFocus: () => { if (!focused) focusRail(verb.id); },
      onClick: (event: MouseEvent<HTMLElement>) => run(verb, event),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => run(verb, event),
    };
    const body = <>
      {verb.label}
      {key ? <kbd className={styles.kbd} aria-hidden="true">{key}</kbd> : null}
      {reason ? <span id={reason} className="sr-only">{verb.disabledReason}</span> : null}
    </>;
    if (verb.kind === "link" && !verb.disabled) return <a key={verb.id} {...attributes} href={verb.href ?? undefined} target={verb.target}
      data-workspace-rich-target={verb.onActivate ? "true" : undefined}>{body}</a>;
    if (!reason || mobile) return <button key={verb.id} type="button" {...attributes}>{body}</button>;
    return <Tooltip key={verb.id} text={verb.disabledReason ?? ""} renderTrigger={help => <button type="button" {...help} {...attributes}
      onFocus={event => { help.onFocus(event); attributes.onFocus(); }}>{body}</button>} />;
  };

  return <div ref={toolbar} id={id} role="toolbar" aria-orientation="horizontal" aria-label={label}
    aria-describedby={mobile ? undefined : `${id}-help`} aria-busy={busy || undefined} className={cx(styles.rail, className)}
    onKeyDownCapture={event => {
      // `more`'s menu is a portal under this toolbar in the react tree; its keys are its own.
      if (!(event.target instanceof Node && event.currentTarget.contains(event.target))) return;
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.key === "Enter") return;
      const claim = () => { event.preventDefault(); event.stopPropagation(); };
      const move = (by: number) => { const at = focus === null ? -1 : order.indexOf(focus); focusRail(order[(at + by + order.length) % order.length] ?? null); };
      if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) { claim(); move(1); }
      else if (event.key === "Tab") { claim(); move(-1); }
      else if (event.key === "ArrowLeft" || event.key === "Escape") { claim(); onClose(true); }
      else if (["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) claim();
      else if (event.key === "Backspace") { claim(); if (rail.filter) filter(rail.filter.slice(0, -1)); }
      else if (event.key.length === 1) { claim(); filter(rail.filter + event.key); }
    }}
    onKeyUpCapture={event => { if (event.key === " " && event.target instanceof Node && event.currentTarget.contains(event.target)) event.preventDefault(); }}>
    {chips.filter(verb => order.includes(verb.id)).map(chip)}
    {verbs.menu ? <ContextualActionMenu {...verbs.menu} label={MORE} align="end" returnFocusTo={returnFocusTo}
      onOpenChange={open => { if (open) setHeld(new Set(reads.map(verb => verb.id))); else onClose(false); }} renderTrigger={trigger =>
        <button {...trigger} data-action-id={MORE} tabIndex={focus === MORE ? 0 : -1}
          className={cx(selection.surface, selection.target, styles.verb, focus === MORE && selection.selected)}
          onFocus={() => { if (focus !== MORE) focusRail(MORE); }}><span className={styles.glyph}><Ellipsis size={16} aria-hidden="true" /></span>{MORE}</button>} /> : null}
    <span className={styles.railBusy} aria-hidden="true"><ControlContents reserveIcon busy={busy} busyKey={id} /></span>
    {mobile ? null : <span id={`${id}-help`} className="sr-only">type to filter. enter runs the focused option. left or escape returns to the query.</span>}
  </div>;
}
