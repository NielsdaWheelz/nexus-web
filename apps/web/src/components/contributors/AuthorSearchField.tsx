"use client";

// The single-select author combobox of the authors editor: a labelled
// combobox/listbox with aria-activedescendant, composition-safe keys
// (Arrow/Home/End/Enter) and polite/assertive status. Escape closes the list
// first, then abandons the search; it applies only while focus is inside.

import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import Input from "@/components/ui/Input";
import { useSettled } from "@/lib/api/serverState";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import {
  searchContributors,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import { contributorNameKey } from "@/lib/contributors/credits";
import { useOverlay } from "@/lib/ui/overlay";
import styles from "./MediaAuthorsEditor.module.css";

const MAX_NAME_CODE_POINTS = 200;

type Option =
  | {
      readonly id: string;
      readonly kind: "Existing";
      readonly item: ContributorSearchItem;
      readonly disabled: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "Create" | "CreateDistinct";
      readonly disabled: boolean;
    };

const count = (n: number, unit: string) =>
  `${new Intl.NumberFormat().format(n)} ${n === 1 ? unit : `${unit}s`}`;

export default function AuthorSearchField({
  initialQuery,
  selectInitial,
  takenHandles,
  takenNewKeys,
  onSelectExisting,
  onCreateNew,
  onDismiss,
}: {
  /** "" for Add; the bound author's name for Change (selected, so typing replaces it). */
  readonly initialQuery: string;
  readonly selectInitial: boolean;
  /** Handles bound on other rows: their results show "Already added", disabled. */
  readonly takenHandles: ReadonlySet<string>;
  /** Name keys of new-author rows: a duplicate "Create" is disabled. */
  readonly takenNewKeys: ReadonlySet<string>;
  readonly onSelectExisting: (item: ContributorSearchItem) => void;
  readonly onCreateNew: (displayName: string) => void;
  readonly onDismiss: () => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const trimmed = query.trim();
  const overLength = [...trimmed].length > MAX_NAME_CODE_POINTS;
  const searchable = trimmed !== "" && !overLength;
  // Exact settled-query admission; shell-owned fields need their open lifetime, not a pane.
  const settled = useSettled(trimmed, 180);
  const live = searchable && settled === trimmed;
  const search = usePaneFreeServerList<ContributorSearchItem>({
    key: live ? trimmed : null,
    stale: "",
    pageSize: 10,
    active: open && live,
    id: (item) => item.handle,
    fetchPage: (cursor, limit, signal) => searchContributors({ q: trimmed, cursor, limit, signal }),
  });
  const current = live && search.current;
  const failed = live && search.failure !== null && search.failure.op !== "More";
  const items = current ? search.items : [];

  useEffect(() => {
    inputRef.current?.focus();
    if (selectInitial) inputRef.current?.select();
    // Mount only: the editor mounts one field per Add or Change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options: Option[] = items.map((item) => ({
    id: `result-${item.handle}`,
    kind: "Existing",
    item,
    disabled: takenHandles.has(item.handle),
  }));
  if (current && searchable) {
    const key = contributorNameKey(trimmed);
    const duplicate = takenNewKeys.has(key);
    options.push({ id: "create", kind: "Create", disabled: duplicate });
    // A person by this name exists here or in results: offer a second one.
    if (
      duplicate ||
      items.some((item) => contributorNameKey(item.display_name) === key)
    ) {
      options.push({
        id: "create-distinct",
        kind: "CreateDistinct",
        disabled: false,
      });
    }
  }
  const active =
    options.find((option) => option.id === activeId) ?? options[0] ?? null;
  const listVisible = open && (overLength || searchable);
  const status = overLength
    ? "A name can be up to 200 characters."
    : !searchable || failed
      ? ""
      : !current
        ? "searching…"
        : items.length === 0
          ? search.complete ? "no matching authors" : "no matching authors found so far"
          : search.complete ? `${count(items.length, "author")} found` : `${count(items.length, "author")} loaded; results incomplete`;
  const results = options.filter((option) => option.kind === "Existing");
  const creates = options.filter((option) => option.kind !== "Existing");

  function choose(option: Option | null) {
    if (option === null || option.disabled) return;
    if (option.kind === "Existing") onSelectExisting(option.item);
    else onCreateNew(trimmed);
  }

  // A transient of the editor: Escape and Back close the list, then abandon
  // the search, while focus is inside the field.
  useOverlay(true, {
    kind: "transient",
    eligible: () => rootRef.current?.contains(document.activeElement) ?? false,
    onDismiss: () => {
      if (composing.current) return;
      if (listVisible) setOpen(false);
      else onDismiss();
    },
  });

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composing.current) return;
    const index = active === null ? 0 : options.indexOf(active);
    const last = options.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: last,
    };
    if (event.key in moves) {
      event.preventDefault();
      setOpen(true);
      if (options.length > 0) setActiveId(options[moves[event.key]!]!.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (failed && !current) { if (search.running === null) search.retry(); }
      else choose(active);
    }
  }

  const optionProps = (option: Option) => ({
    id: `${id}-${option.id}`,
    role: "option",
    "aria-selected": option === active,
    "aria-disabled": option.disabled || undefined,
    "data-active": option === active || undefined,
    "data-disabled": option.disabled || undefined,
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onMouseMove: () => setActiveId(option.id),
    onClick: () => choose(option),
  });

  return (
    <div ref={rootRef} className={styles.search}>
      <label className="sr-only" htmlFor={`${id}-input`}>
        Search authors
      </label>
      <Input
        ref={inputRef}
        id={`${id}-input`}
        className={styles.input}
        role="combobox"
        aria-expanded={listVisible}
        aria-controls={listVisible ? `${id}-list` : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          listVisible && active ? `${id}-${active.id}` : undefined
        }
        aria-describedby={`${id}-status`}
        value={query}
        dir="auto"
        placeholder="Search authors by name"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(null);
          setOpen(true);
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={onKeyDown}
      />
      <div
        id={`${id}-status`}
        className="sr-only"
      >
        {status}
      </div>
      {listVisible && failed && search.failure !== null ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "couldn’t load authors", requestId: search.failure.error.requestId }}
          announcement={search.active ? "Assertive" : "None"}
          actions={[{ label: "try again", onClick: search.retry, busy: search.running !== null }]}
          returnFocus={() => inputRef.current}
        />
      ) : null}
      {listVisible && !failed && status && (overLength || items.length === 0) ? (
        <div className={styles.status}><FeedbackStatus content={{ tone: overLength ? "Warning" : "Neutral", title: status }} announcement={(open && overLength) || (search.active && !current) ? "Polite" : "None"} /></div>
      ) : null}
      {listVisible ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Authors"
          className={styles.list}
        >
          {results.map((option) =>
            option.kind === "Existing" ? (
              <div
                key={option.id}
                className={styles.option}
                {...optionProps(option)}
              >
                <span className={styles.name} dir="auto">
                  {option.item.display_name}
                </span>
                <span className={styles.meta}>
                  {count(option.item.work_count, "work")}
                  {option.item.work_examples.map((example, index) => (
                    <span key={example.href} dir="auto">
                      {index === 0 ? " · " : ", "}
                      {example.title}
                    </span>
                  ))}
                </span>
                {option.item.matched_alias ? (
                  <span className={styles.meta}>
                    also known as{" "}
                    <span dir="auto">{option.item.matched_alias}</span>
                  </span>
                ) : null}
                {option.disabled ? (
                  <span className={styles.meta}>Already added</span>
                ) : null}
              </div>
            ) : null,
          )}
          {creates.map((option) => (
            <div
              key={option.id}
              className={styles.create}
              {...optionProps(option)}
            >
              <Plus size={16} aria-hidden="true" />
              {option.kind === "Create" ? (
                <span>
                  Create “<span dir="auto">{trimmed}</span>” as a new author
                </span>
              ) : (
                <span>Create a different author with this name</span>
              )}
              {option.disabled ? (
                <span className={styles.meta}>Already added</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {listVisible ? <CollectionExhaustionNotice list={search} unit={{ singular: "author", plural: "authors" }} returnFocus={() => inputRef.current} /> : null}
    </div>
  );
}
