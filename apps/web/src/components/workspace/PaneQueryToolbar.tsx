"use client";

import { useId, useRef, useState, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import AppliedFilters, { type AppliedFilterChip } from "@/components/ui/AppliedFilters";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import styles from "./PaneQueryToolbar.module.css";

/** Presentation only: domains own the query, constraints, timing and results. */
export default function PaneQueryToolbar({
  inputRef, input, submit, options, sort, chips, status, actions, onReset,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly input: {
    readonly label: string;
    readonly placeholder: string;
    readonly value: string;
    readonly appliedValue: string;
    readonly onChange: (value: string) => void;
    readonly onClear: () => void;
    readonly disabled?: boolean;
    readonly error?: string;
    readonly maxLength?: number;
    readonly keyShortcuts?: string;
    readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  };
  readonly submit?: { readonly onSubmit: () => void; readonly disabled?: boolean };
  readonly options?: {
    readonly label: string;
    readonly activeCount: number;
    readonly content: ReactNode;
    readonly onClear?: () => void;
  };
  readonly sort?: {
    readonly label: string;
    readonly value: string;
    readonly choices: readonly { readonly value: string; readonly label: string }[];
    readonly onChange: (value: string) => void;
  };
  readonly chips?: {
    readonly items: readonly AppliedFilterChip[];
    readonly onRemove: (id: string) => void;
  };
  readonly status: { readonly id: string; readonly content: ReactNode };
  readonly actions?: ReactNode;
  readonly onReset?: () => void;
}) {
  const id = useId();
  const optionsId = `${id}-options`;
  const errorId = `${id}-error`;
  const [expanded, setExpanded] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clear = () => {
    inputRef.current?.focus({ preventScroll: true });
    input.onClear();
  };
  const collapse = () => {
    if (optionsRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    setExpanded(false);
  };
  const primary = (
    <>
      <div className={styles.search}>
        <Input
          ref={inputRef}
          className={styles.input}
          type="search"
          size="sm"
          aria-label={input.label}
          aria-describedby={[status.id, input.error ? errorId : null].filter(Boolean).join(" ")}
          aria-invalid={input.error ? true : undefined}
          aria-keyshortcuts={input.keyShortcuts ?? (submit ? "Enter Escape" : "Escape")}
          placeholder={input.placeholder}
          value={input.value}
          disabled={input.disabled}
          maxLength={input.maxLength}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-pane-query-input="true"
          onChange={(event) => input.onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            input.onKeyDown?.(event);
            if (event.defaultPrevented || event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && (input.value || input.appliedValue)) {
              event.preventDefault();
              event.stopPropagation();
              clear();
            }
          }}
        />
        {input.value || input.appliedValue ? (
          <Button variant="ghost" size="sm" iconOnly aria-label="Clear text" title="Clear text" disabled={input.disabled} onClick={clear}>
            <X size={15} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {submit ? <Button type="submit" size="sm" disabled={submit.disabled || input.disabled}>Search</Button> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {options ? (
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={optionsId}
          leadingIcon={<SlidersHorizontal size={15} aria-hidden="true" />}
          onClick={() => expanded ? collapse() : setExpanded(true)}
        >
          {options.label}{options.activeCount > 0 ? ` (${options.activeCount})` : ""}
        </Button>
      ) : null}
      {sort ? (
        <SelectField layout="Inline" label={sort.label} size="sm" value={sort.value} onChange={(event) => sort.onChange(event.currentTarget.value)}>
          {sort.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </SelectField>
      ) : null}
    </>
  );
  return (
    <div className={styles.toolbar}>
      {submit ? (
        <form className={styles.primary} role="search" aria-label={input.label} onSubmit={(event) => {
          event.preventDefault();
          if (!submit.disabled && !input.disabled) submit.onSubmit();
        }}>{primary}</form>
      ) : <div className={styles.primary} role="group" aria-label={input.label}>{primary}</div>}
      <div className={styles.refinements} data-pane-query-refinements="true" tabIndex={status.content || chips?.items.length || expanded || onReset ? 0 : undefined} role="group" aria-label="Query details">
        {input.appliedValue && input.appliedValue !== input.value ? <span>Results for: {input.appliedValue}</span> : null}
        {chips ? <AppliedFilters chips={chips.items} onRemove={chips.onRemove} returnFocusTo={inputRef} /> : null}
        {input.error ? <p id={errorId} className={styles.error}>{input.error}</p> : null}
        {status.content}
        {options ? (
          <div
            ref={optionsRef}
            id={optionsId}
            className={styles.options}
            hidden={!expanded}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              collapse();
            }}
          >
            {options.content}
            {options.onClear && options.activeCount > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => {
                triggerRef.current?.focus({ preventScroll: true });
                options.onClear?.();
              }}>Clear filters</Button>
            ) : null}
          </div>
        ) : null}
        {onReset ? <Button variant="ghost" size="sm" onClick={() => {
          inputRef.current?.focus({ preventScroll: true });
          onReset();
        }}>Reset view</Button> : null}
      </div>
    </div>
  );
}
