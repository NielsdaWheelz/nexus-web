"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useListBox, useOption } from "react-aria/useListBox";
import { Item } from "react-stately/Item";
import { useListState, type ListState } from "react-stately/useListState";
import PickerSurface from "./PickerSurface";
import styles from "./ChoicePicker.module.css";
import collection from "./Collection.module.css";
import { revealCollectionItem } from "@/lib/ui/collection";

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly unavailable_reason: string | null;
}

/** A controlled exclusive choice; navigating never changes its value. */
export default function ChoicePicker({ label, value, options, disabled, footer, onOpen, onChange }: {
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly ChoiceOption[];
  readonly disabled: boolean;
  readonly footer: ReactNode | null;
  readonly onOpen: () => void;
  readonly onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const disabledKeys = useMemo(() => options.filter(option => option.unavailable_reason !== null).map(option => option.id), [options]);
  const selectedKeys = useMemo(() => value === null ? [] : [value], [value]);
  const state = useListState<ChoiceOption>({
    items: options,
    children: option => <Item key={option.id} textValue={option.label}>{option.label}</Item>,
    selectionMode: "single",
    selectionBehavior: "toggle",
    disallowEmptySelection: true,
    allowDuplicateSelectionEvents: true,
    selectedKeys,
    disabledKeys,
    onSelectionChange: keys => {
      if (disabled || keys === "all") return;
      const key = keys.values().next().value;
      if (typeof key !== "string") return;
      setOpen(false);
      if (key !== value) onChange(key);
    },
  });
  const { listBoxProps } = useListBox({
    id,
    "aria-label": label,
    autoFocus: false,
    escapeKeyBehavior: "none",
    shouldSelectOnPressUp: true,
    shouldFocusOnHover: true,
  }, state, list);

  // The collection's default is to focus a neighbour when a row disappears.
  // A refreshed catalog must instead require a new navigation gesture.
  useLayoutEffect(() => {
    const key = state.selectionManager.focusedKey;
    if (key === null || options.some(option => option.id === key && option.unavailable_reason === null)) return;
    const ownedFocus = state.selectionManager.isFocused;
    state.selectionManager.setFocusedKey(null);
    if (ownedFocus) list.current?.focus();
  });
  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const current = options.find(option => option.id === value);
  const text = current?.label ?? `choose ${label}`;
  const show = () => {
    if (disabled || open) return;
    setOpen(true);
    onOpen();
  };
  return <>
    <button
      ref={trigger}
      type="button"
      className={styles.trigger}
      aria-label={`${label}: ${text}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      disabled={disabled}
      data-unavailable={current?.unavailable_reason !== null && current !== undefined || undefined}
      onClick={event => {
        event.stopPropagation();
        if (open) setOpen(false);
        else show();
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.repeat && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          show();
        }
      }}
    >
      <span className={styles.value}>{text}</span>
      <ChevronDown size={14} aria-hidden="true" className={styles.chevron} />
    </button>
    <PickerSurface
      active={open}
      onClose={() => setOpen(false)}
      anchor={() => trigger.current}
      title={label}
      placement="above"
      desktopRole={null}
      className={styles.panel}
      initialFocus={panel => {
        const target = current?.unavailable_reason === null ? current : options.find(option => option.unavailable_reason === null);
        state.selectionManager.setFocused(true);
        state.selectionManager.setFocusedKey(target?.id ?? null);
        return [...panel.querySelectorAll<HTMLElement>("[data-choice-id]")].find(element => element.dataset.choiceId === target?.id) ?? list.current ?? panel;
      }}
    >
      <ul
        {...listBoxProps}
        ref={list}
        className={collection.compactViewport}
        data-collection-viewport=""
        onKeyDown={event => {
          // The overlay continues Tab from the actual focused control; the
          // collection's Tab handler would first move it to the list root.
          if (event.key !== "Tab") listBoxProps.onKeyDown?.(event);
        }}
        onKeyDownCapture={event => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Tab")) {
            event.stopPropagation();
            return;
          }
          if (event.repeat && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {options.map(option => <ChoiceRow key={option.id} option={option} state={state} />)}
      </ul>
      {footer === null ? null : <div className={styles.footer}>{footer}</div>}
    </PickerSurface>
  </>;
}

function ChoiceRow({ option, state }: { readonly option: ChoiceOption; readonly state: ListState<ChoiceOption> }) {
  const ref = useRef<HTMLLIElement>(null);
  const { optionProps, labelProps, descriptionProps, isFocused, isSelected } = useOption({ key: option.id }, state, ref);
  const detail = [option.detail, option.unavailable_reason].filter(Boolean).join(" · ");
  useLayoutEffect(() => {
    const item = ref.current;
    if (isFocused && item?.parentElement) revealCollectionItem(item.parentElement, item);
  }, [isFocused]);
  return <li {...optionProps} ref={ref} data-choice-id={option.id} data-active={isFocused || undefined} data-selected={isSelected || undefined} className={collection.row}
    onKeyDown={event => {
      optionProps.onKeyDown?.(event);
      // Selection restores the trigger before the browser's default activation.
      // Do not let that same Enter/Space reopen it.
      if (event.key === "Enter" || event.key === " ") event.preventDefault();
    }}
  >
    <span className={collection.content}>
      <span {...labelProps}>{option.label}</span>
      {detail ? <span {...descriptionProps} className={collection.detail}>{detail}</span> : null}
    </span>
    {isSelected ? <Check size={15} aria-hidden="true" className={collection.adornment} /> : null}
  </li>;
}
