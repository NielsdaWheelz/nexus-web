"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { useListBox, useListBoxSection, useOption } from "react-aria/useListBox";
import { Item } from "react-stately/Item";
import { Section } from "react-stately/Section";
import { useListState, type ListState } from "react-stately/useListState";
import PickerSurface from "@/components/ui/PickerSurface";
import collection from "@/components/ui/Collection.module.css";
import { dimensionWord, orderWord, type CollationDimension, type CollationOption, type CollationOrder, type PaneCollation } from "@/lib/panes/collation";
import { revealCollectionItem } from "@/lib/ui/collection";
import * as Icon from "@/lib/ui/icons";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./CollationLine.module.css";

type Choice = Omit<CollationOption, "value"> & { id: string; name: string; value: string | null; selected: boolean };
type Group = { id: string; label: string | null; choices: Choice[] };
const restId = "rest";
const optionId = (value: string) => `value:${value}`;
const truncate = (word: string) => { const chars = Array.from(word); return chars.length > 24 ? `${chars.slice(0, 23).join("")}…` : word; };

/** The shell paints the published dimensions; the body owns their meaning. */
export default function CollationLine({ collation }: { readonly collation: PaneCollation }) {
  const pane = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const previous = useRef<CollationDimension | null>(null);
  const focusRow = useCallback(() => {
    const row = pane.current?.querySelector<HTMLElement>("[data-collation-row]");
    (row?.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"]), a[href]') ?? pane.current?.querySelector<HTMLElement>("[data-pane-chrome-focus]") ?? pane.current)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => () => {
    if (previous.current && previous.current.kind !== "Span") previous.current.onOpenChange?.(false);
  }, []);
  const selected = collation.dimensions.find(d => d.id === open) ?? null;
  useLayoutEffect(() => {
    if (open === null || (open === "order" ? collation.order !== null : selected !== null)) return;
    if (previous.current && previous.current.kind !== "Span") previous.current.onOpenChange?.(false);
    previous.current = null;
    setOpen(null);
    focusRow();
  }, [open, selected, collation.order, focusRow]);
  const changeOpen = (id: string, next: boolean, dimension?: CollationDimension) => {
    if (dimension && dimension.kind !== "Span") dimension.onOpenChange?.(next);
    previous.current = next && dimension ? dimension : null;
    setOpen(next ? id : null);
  };
  return <div ref={node => { if (node) pane.current = node.closest<HTMLElement>("[data-pane-shell]"); }} className={styles.words}>
    {collation.dimensions.map(dimension => dimension.kind === "Span"
      ? <Span key={dimension.id} dimension={dimension} />
      : <ChoiceWord key={dimension.id} dimension={dimension} open={open === dimension.id}
          onOpenChange={next => changeOpen(dimension.id, next, dimension)} focusRow={focusRow} />)}
    {collation.order ? <OrderWord order={collation.order} open={open === "order"}
      onOpenChange={next => changeOpen("order", next)} focusRow={focusRow} /> : null}
    {collation.reset ? <button type="button" className={styles.word} onClick={() => {
      collation.reset?.(); requestAnimationFrame(focusRow);
    }}>reset</button> : null}
  </div>;
}

function ChoiceWord({ dimension, open, onOpenChange, focusRow }: {
  dimension: Exclude<CollationDimension, { kind: "Span" }>; open: boolean; onOpenChange: (open: boolean) => void; focusRow: () => void;
}) {
  const selected = dimension.kind === "One" ? dimension.value === null ? [] : [dimension.value] : dimension.values;
  const groups: Group[] = [{ id: "options", label: null, choices: [
    { id: restId, name: dimension.rest, label: dimension.rest, value: null, sign: null, count: dimension.restCount ?? null, reason: null, selected: selected.length === 0 },
    ...dimension.options.map(option => ({ ...option, id: optionId(option.value), name: option.label, selected: selected.includes(option.value) })),
  ] }];
  return <Picker label={dimension.label} word={dimensionWord(dimension)} lit={selected.length > 0} groups={groups}
    multiple={dimension.kind === "Many"} open={open} onOpenChange={onOpenChange} focusRow={focusRow} aside={dimension.aside}
    choose={choice => {
      const value = choice.value;
      if (dimension.kind === "One") {
        if (dimension.value !== value) dimension.onChange(value);
        onOpenChange(false);
      } else if (value === null) dimension.onChange([]);
      else dimension.onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
    }} />;
}
function OrderWord({ order, open, onOpenChange, focusRow }: { order: CollationOrder; open: boolean; onOpenChange: (open: boolean) => void; focusRow: () => void }) {
  const groups: Group[] = [{ id: "rest", label: null, choices: [{ id: restId, name: order.rest, label: order.rest, value: null, sign: null, count: null, reason: null, selected: order.value === null }] },
    ...order.keys.map((key, i) => ({ id: `group:${i}`, label: key.label,
      choices: key.ways.map(way => ({ id: optionId(way.value), name: way.label === null ? way.word : `${key.label}, ${way.label}`,
        value: way.value, label: way.label ?? way.word, sign: null, count: null, reason: null, selected: order.value === way.value })) }))];
  return <Picker label="order" word={orderWord(order)} lit={order.value !== null} groups={groups} multiple={false} open={open}
    onOpenChange={onOpenChange} focusRow={focusRow} aside={order.note ? <p className={styles.note}>{order.note}</p> : null}
    choose={choice => { const value = choice.value; if (value !== order.value) order.onChange(value); onOpenChange(false); }} />;
}
function Picker({ label, word, lit, groups, multiple, open, onOpenChange, focusRow, aside, choose }: {
  label: string; word: string; lit: boolean; groups: Group[]; multiple: boolean; open: boolean;
  onOpenChange: (open: boolean) => void; focusRow: () => void; aside?: React.ReactNode; choose: (choice: Choice) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => {
    const previous = trigger.current;
    if (node === null && previous && document.activeElement === previous) requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === previous) focusRow();
    });
    trigger.current = node;
  }, [focusRow]);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const mobile = useIsMobileViewport();
  const choices = groups.flatMap(group => group.choices);
  const selected = choices.filter(choice => choice.selected).map(choice => choice.id);
  const state = useListState<Choice>({
    children: groups.flatMap(group => group.label === null
      ? group.choices.map(choice => <Item key={choice.id} textValue={choice.name}>{choice.name}</Item>)
      : [<Section key={group.id} title={group.label}>{group.choices.map(choice => <Item key={choice.id} textValue={choice.name}>{choice.name}</Item>)}</Section>]),
    selectionMode: multiple ? "multiple" : "single", selectionBehavior: "toggle", disallowEmptySelection: !multiple, allowDuplicateSelectionEvents: true,
    selectedKeys: selected, disabledKeys: choices.filter(choice => choice.reason && !(multiple && choice.selected)).map(choice => choice.id),
    onSelectionChange: keys => {
      if (keys === "all") return;
      const next = [...keys].map(String);
      const changed = multiple ? choices.find(choice => choice.selected !== next.includes(choice.id)) : choices.find(choice => next.includes(choice.id));
      if (changed) choose(changed);
    },
  });
  const { listBoxProps } = useListBox({ "aria-label": label, autoFocus: false, escapeKeyBehavior: "none", shouldSelectOnPressUp: true, shouldFocusOnHover: true }, state, list);
  const signs = choices.some(choice => choice.sign);
  return <>
    <button ref={setTrigger} type="button" className={styles.word} data-lit={lit || undefined} aria-label={`${label}: ${word}`}
      aria-haspopup={mobile ? "dialog" : "listbox"} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => onOpenChange(!open)}>{truncate(word)} <Icon.Choose size={12} aria-hidden="true" /></button>
    <PickerSurface active={open} onClose={() => onOpenChange(false)} anchor={() => trigger.current} returnFocusFallback={() => { focusRow(); return null; }}
      title={label} panelId={id} desktopRole={null} placement="below" align="end" slipContent={list}
      initialFocus={surface => {
        const target = choices.find(choice => choice.selected && (!choice.reason || multiple)) ?? choices.find(choice => !choice.reason);
        state.selectionManager.setFocused(true); state.selectionManager.setFocusedKey(target?.id ?? null);
        return [...surface.querySelectorAll<HTMLElement>("[data-choice-id]")].find(node => node.dataset.choiceId === target?.id) ?? list.current;
      }}>
      <ul {...listBoxProps} ref={list} className={collection.contentViewport} data-collection-viewport=""
        onKeyDown={event => { if (event.key !== "Tab") listBoxProps.onKeyDown?.(event); }}>
        {groups.map(group => group.label === null ? group.choices.map(choice => <Row key={choice.id} choice={choice} state={state} signs={signs} />)
          : <Rows key={group.id} group={group} state={state} signs={signs} />)}
      </ul>
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </PickerSurface>
  </>;
}
function Rows({ group, state, signs }: { group: Group; state: ListState<Choice>; signs: boolean }) {
  const { itemProps, headingProps, groupProps } = useListBoxSection({ heading: group.label });
  return <li {...itemProps}><div {...headingProps} className={styles.heading}>{group.label}</div><ul {...groupProps} className={styles.group}>
    {group.choices.map(choice => <Row key={choice.id} choice={choice} state={state} signs={signs} />)}</ul></li>;
}
function Row({ choice, state, signs }: { choice: Choice; state: ListState<Choice>; signs: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const { optionProps, labelProps, descriptionProps, isFocused, isSelected } = useOption({ key: choice.id }, state, ref);
  useLayoutEffect(() => { const item = ref.current; const viewport = item?.closest<HTMLElement>("[data-collection-viewport]"); if (isFocused && item && viewport) revealCollectionItem(viewport, item); }, [isFocused]);
  const Sign = choice.sign;
  return <li {...optionProps} ref={ref} data-choice-id={choice.id} data-active={isFocused || undefined} data-selected={isSelected || undefined} className={collection.row}
    onKeyDown={event => { optionProps.onKeyDown?.(event); if (event.key === "Enter" || event.key === " ") event.preventDefault(); }}>
    <span className={`${collection.adornment} ${styles.slot}`}>{isSelected ? <Icon.Check size={16} aria-hidden="true" /> : null}</span>
    {signs ? <span className={styles.slot}>{Sign ? <Sign size={16} aria-hidden="true" /> : null}</span> : null}
    <span className={collection.content}><span {...labelProps}><span className="sr-only">{choice.name}</span><span aria-hidden="true" className={choice.count === 0 ? styles.zero : undefined}>{choice.label}</span></span>
      {(choice.reason !== null || choice.count !== null) ? <span {...descriptionProps} className={choice.reason ? collection.detail : "sr-only"}>
        {choice.reason}{choice.count !== null ? <span className="sr-only"> {choice.count.toLocaleString()} items</span> : null}
      </span> : null}</span>
    {choice.count !== null ? <span aria-hidden="true" className={styles.count}>{choice.count.toLocaleString()}</span> : null}
  </li>;
}
function Span({ dimension }: { dimension: Extract<CollationDimension, { kind: "Span" }> }) {
  const date = useRef<HTMLInputElement>(null);
  return <span className={styles.span}>
    <button type="button" className={styles.step} aria-label={`previous ${dimension.unit}`} aria-disabled={!dimension.backward || undefined}
      onClick={() => { if (dimension.backward) dimension.onStep(-1); }}><Icon.Left size={16} /></button>
    {dimension.pick ? <span className={styles.date}><button type="button" className={styles.word} data-lit={dimension.now !== null || undefined}
      aria-label={`${dimension.label}: ${dimension.value}`} onClick={() => date.current?.showPicker()}>{truncate(dimension.value)}</button>
      <input ref={date} type="date" tabIndex={-1} aria-label={dimension.label} value={dimension.pick.value} max={dimension.pick.max}
        onChange={event => dimension.pick?.onPick(event.currentTarget.value)} /></span>
      : <span className={styles.word} data-lit={dimension.now !== null || undefined}>{truncate(dimension.value)}</span>}
    <button type="button" className={styles.step} aria-label={`next ${dimension.unit}`} aria-disabled={!dimension.forward || undefined}
      onClick={() => { if (dimension.forward) dimension.onStep(1); }}><Icon.Right size={16} /></button>
    {dimension.now ? <button type="button" className={styles.word} onClick={dimension.now.go}>{dimension.now.label}</button> : null}
  </span>;
}
