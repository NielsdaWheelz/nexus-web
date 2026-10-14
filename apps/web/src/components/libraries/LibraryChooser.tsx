"use client";

// The library listbox every chooser renders: a search combobox over two groups
// (chosen, then the rest), a row toggled by click or Enter, a read-only row
// saying why, then an optional Create row and Load more row. It owns only the
// active option; the caller owns the query, the rows and what a toggle does.

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, Loader2, Lock, Plus } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import styles from "./LibraryChooser.module.css";

export interface ChooserRow {
  readonly id: string;
  readonly name: string;
  readonly chosen: boolean;
  /** Why the row cannot be toggled; null when it can. */
  readonly readOnly: string | null;
  readonly note?: string | null;
  readonly pending?: boolean;
}

type Option =
  | { readonly key: string; readonly kind: "Row"; readonly row: ChooserRow }
  | { readonly key: "create"; readonly kind: "Create" }
  | { readonly key: "more"; readonly kind: "More" };

export default function LibraryChooser(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly chosenLabel: string;
  readonly rows: readonly ChooserRow[];
  readonly onToggle: (row: ChooserRow) => void;
  /** A write is in flight: nothing can be chosen. */
  readonly busy: boolean;
  /** A read is in flight. */
  readonly loading: boolean;
  readonly status: string;
  readonly empty: string | null;
  readonly error: {
    readonly content: FeedbackContent;
    readonly retry: (() => void) | null;
  } | null;
  readonly create: { readonly name: string; readonly run: () => void } | null;
  readonly more: { readonly loading: boolean; readonly run: () => void } | null;
}) {
  const { rows, busy, create, more } = props;
  const base = useId();
  const composing = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const chosen = rows.filter((row) => row.chosen);
  const other = rows.filter((row) => !row.chosen);
  const options: Option[] = [
    ...[...chosen, ...other].map((row) => ({
      key: `row-${row.id}`,
      kind: "Row" as const,
      row,
    })),
    ...(create ? [{ key: "create" as const, kind: "Create" as const }] : []),
    ...(more ? [{ key: "more" as const, kind: "More" as const }] : []),
  ];
  const current = options.find((option) => option.key === active) ?? options[0] ?? null;
  const domId = (key: string) => `${base}-${key}`;
  const list = useRef<HTMLDivElement>(null);
  // Keep the active option in view by scrolling the list alone: scrollIntoView
  // would also scroll whatever task holds the chooser.
  useLayoutEffect(() => {
    const option = current && document.getElementById(domId(current.key));
    if (!list.current || !option || !list.current.contains(option)) return;
    const box = list.current.getBoundingClientRect();
    const top = box.top + list.current.clientTop;
    const bottom = top + list.current.clientHeight;
    const { top: optionTop, bottom: optionBottom } = option.getBoundingClientRect();
    if (optionTop < top) list.current.scrollTop += optionTop - top;
    else if (optionBottom > bottom) list.current.scrollTop += optionBottom - bottom;
  });

  const activate = (option: Option) => {
    if (busy) return;
    if (option.kind === "Create") create?.run();
    else if (option.kind === "More") {
      if (!more?.loading) more?.run();
    } else if (option.row.readOnly === null && !option.row.pending) {
      props.onToggle(option.row);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || current === null) return;
    const index = options.indexOf(current);
    const last = options.length - 1;
    const next = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined && event.key !== "Enter") return;
    // Escape and every other key stay with the browser and the surface.
    event.preventDefault();
    event.stopPropagation();
    if (next === undefined) activate(current);
    else setActive(options[next]!.key);
  };

  const option = (item: Option, content: ReactNode) => (
    <div
      key={item.key}
      id={domId(item.key)}
      role="option"
      aria-selected={item.kind === "Row" && item.row.chosen}
      aria-disabled={(item.kind === "Row" && item.row.readOnly !== null) || undefined}
      aria-busy={
        (item.kind === "Row" && item.row.pending) ||
        (item.kind === "More" && more?.loading) ||
        undefined
      }
      className={styles.option}
      data-action={item.kind === "Row" ? undefined : item.kind}
      data-active={item === current || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => setActive(item.key)}
      onClick={() => activate(item)}
    >
      {content}
    </div>
  );
  const rowOption = (row: ChooserRow) => {
    const note = [row.note, row.readOnly].filter(Boolean).join(" · ");
    return option(
      { key: `row-${row.id}`, kind: "Row", row },
      <>
        <span className={styles.text}>
          <span className={styles.name}>{row.name}</span>
          {note ? <span className={styles.note}>{note}</span> : null}
        </span>
        {row.pending ? (
          <Loader2 className={styles.spinner} size={16} aria-hidden="true" />
        ) : row.readOnly !== null ? (
          <Lock size={16} aria-hidden="true" />
        ) : row.chosen ? (
          <Check className={styles.check} size={16} aria-hidden="true" />
        ) : null}
      </>,
    );
  };
  const group = (key: string, label: string, items: readonly ChooserRow[]) =>
    items.length === 0 ? null : (
      <div role="group" aria-labelledby={domId(key)}>
        <div id={domId(key)} className={styles.groupHeader}>
          {label}
        </div>
        {items.map(rowOption)}
      </div>
    );

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          bare
          className={styles.search}
          role="combobox"
          aria-label={props.label}
          aria-controls={domId("listbox")}
          aria-expanded={true}
          aria-activedescendant={current ? domId(current.key) : undefined}
          aria-describedby={domId("status")}
          aria-autocomplete="list"
          value={props.query}
          readOnly={busy}
          placeholder={props.placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={domId("status")} role="status" className="sr-only">
        {props.error ? "" : props.status}
      </div>
      {props.error ? (
        <FeedbackNotice
          content={props.error.content}
          announcement="Assertive"
          actions={
            props.error.retry && !busy
              ? [{ label: "Retry", onClick: props.error.retry }]
              : undefined
          }
        />
      ) : null}
      <div
        ref={list}
        id={domId("listbox")}
        role="listbox"
        aria-label="Library options"
        aria-multiselectable="true"
        aria-busy={busy || props.loading || undefined}
        className={styles.list}
      >
        {group("chosen", props.chosenLabel, chosen)}
        {group("other", "Other libraries", other)}
        {create
          ? option(
              { key: "create", kind: "Create" },
              <>
                <Plus size={16} aria-hidden="true" />
                <span className={styles.name}>Create “{create.name}”</span>
              </>,
            )
          : null}
        {more
          ? option(
              { key: "more", kind: "More" },
              <>
                {more.loading ? (
                  <Loader2 className={styles.spinner} size={16} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                <span className={styles.name}>
                  {more.loading ? "Loading more libraries…" : "Load more libraries"}
                </span>
              </>,
            )
          : null}
        {rows.length === 0 && !create && props.empty ? (
          <div className={styles.empty}>{props.empty}</div>
        ) : null}
      </div>
    </div>
  );
}
