"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import AppliedFilters, { type AppliedFilterChip } from "@/components/ui/AppliedFilters";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { cx } from "@/lib/ui/cx";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
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
    readonly keyShortcuts?: string;
    readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  };
  readonly submit?: { readonly onSubmit: () => void; readonly disabled?: boolean };
  readonly options?: {
    readonly label: string;
    readonly activeCount: number;
    readonly content: ReactNode;
    readonly onClear?: () => void;
    readonly onExpandedChange?: (expanded: boolean) => void;
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
  readonly status?: {
    readonly placement: "Inline" | "Details";
    readonly id: string;
    readonly content: ReactNode;
    readonly visible: boolean;
  };
  readonly actions?: ReactNode;
  readonly onReset?: () => void;
}) {
  const { paneId } = requirePaneRuntime(usePaneRuntime(), "PaneQueryToolbar");
  const id = useId();
  const optionsId = `${id}-options`;
  const errorId = `${id}-error`;
  const [expanded, setExpanded] = useState(false);
  const onExpandedChange = options?.onExpandedChange;
  useLayoutEffect(() => { onExpandedChange?.(expanded); }, [expanded, onExpandedChange]);
  useLayoutEffect(() => () => onExpandedChange?.(false), [onExpandedChange]);
  const refinementsRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refinementsOwnFocus = useRef(false);
  const appliedTextVisible = input.appliedValue.length > 0 && input.appliedValue !== input.value;
  const inlineStatusVisible = status?.placement === "Inline" && status.visible;
  const actionsVisible = inlineStatusVisible || Boolean(actions);
  const controlsVisible = actionsVisible || options !== undefined || sort !== undefined || onReset !== undefined;
  const summaryVisible = (status?.placement === "Details" && status.visible) || (chips?.items.length ?? 0) > 0 || appliedTextVisible;
  const detailsVisible = summaryVisible || input.error !== undefined || (options !== undefined && expanded);
  useLayoutEffect(() => {
    if (detailsVisible || !refinementsOwnFocus.current) return;
    refinementsOwnFocus.current = false;
    const active = document.activeElement;
    if (active !== document.body && !refinementsRef.current?.contains(active)) return;
    const field = inputRef.current;
    const target = field && !field.disabled
      ? field
      : findPaneChromeFocusTarget(paneId) ?? findPaneLandmarkFocusTarget(paneId);
    target?.focus({ preventScroll: true });
  }, [detailsVisible, inputRef, paneId]);
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
      <div className={cx(styles.entry, submit && styles.submitted)}>
        <div className={styles.search}>
          <Input
            ref={inputRef}
            className={styles.input}
            type="search"
            size="sm"
            aria-label={input.label}
            aria-describedby={[status?.id, input.error !== undefined ? errorId : null].filter(Boolean).join(" ") || undefined}
            aria-invalid={input.error !== undefined ? true : undefined}
            aria-keyshortcuts={input.keyShortcuts ?? (submit ? "Enter Escape" : "Escape")}
            placeholder={input.placeholder}
            value={input.value}
            disabled={input.disabled}
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
            <Button className={styles.clear} variant="ghost" size="sm" iconOnly aria-label="Clear text" title="Clear text" disabled={input.disabled} onClick={clear}>
              <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {submit ? <Button type="submit" size="sm" disabled={submit.disabled || input.disabled}>Search</Button> : null}
      </div>
      {status?.placement === "Inline" || actions || options || sort || onReset ? <div className={styles.controls} data-visible={controlsVisible}>
        {status?.placement === "Inline" || actions ? (
          <div className={styles.actions} data-visible={actionsVisible}>
            {status?.placement === "Inline" ? <div className={inlineStatusVisible ? styles.inlineStatus : "sr-only"}>{status.content}</div> : null}
            {actions}
          </div>
        ) : null}
        {options ? (
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={optionsId}
            leadingIcon={<SlidersHorizontal size={16} aria-hidden="true" />}
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
        {onReset ? <Button type="button" variant="ghost" size="sm" onClick={() => {
          inputRef.current?.focus({ preventScroll: true });
          onReset();
        }}>Reset view</Button> : null}
      </div> : null}
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
      {/* Visually suppressed collection status keeps its description/live region mounted. */}
      <div
        ref={refinementsRef}
        className={styles.refinements}
        data-pane-query-refinements="true"
        hidden={!detailsVisible && status?.placement !== "Details"}
        tabIndex={detailsVisible ? 0 : undefined}
        role="group"
        aria-label="Query details"
        onFocusCapture={() => { refinementsOwnFocus.current = true; }}
        onBlurCapture={(event) => {
          // Only hide/removal keeps ownership when the browser blurs to body.
          if (event.relatedTarget && event.relatedTarget !== document.body)
            refinementsOwnFocus.current = event.currentTarget.contains(event.relatedTarget);
          else if (event.target.isConnected && !event.target.closest("[hidden]"))
            refinementsOwnFocus.current = false;
        }}
      >
        <div className={styles.summary} data-visible={summaryVisible}>
          {appliedTextVisible ? <span>Results for: {input.appliedValue}</span> : null}
          {chips ? <AppliedFilters chips={chips.items} onRemove={chips.onRemove} returnFocusTo={inputRef} /> : null}
          {status?.placement === "Details" ? <div className={status.visible ? styles.status : "sr-only"}>{status.content}</div> : null}
        </div>
        {input.error !== undefined ? <p id={errorId} className={styles.error}>{input.error}</p> : null}
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
      </div>
    </div>
  );
}
