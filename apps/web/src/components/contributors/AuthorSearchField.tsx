"use client";

// The single-select author combobox of the authors editor: a labelled
// combobox/listbox with aria-activedescendant, composition-safe keys
// (Arrow/Home/End/Enter) and polite/assertive status. Escape closes the list
// first, then abandons the search; it applies only while focus is inside.

import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import Input from "@/components/ui/Input";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import {
  searchContributors,
  type ContributorSearchItem,
} from "@/lib/contributors/api";
import { contributorNameKey } from "@/lib/contributors/credits";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useContainingModalLayer } from "@/lib/ui/useModalLayer";
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
  const [attempt, setAttempt] = useState(0);
  const modalToken = useContainingModalLayer();
  const trimmed = query.trim();
  const overLength = [...trimmed].length > MAX_NAME_CODE_POINTS;
  const searchable = trimmed !== "" && !overLength;
  const search = useDebouncedFetch(
    searchable ? `${trimmed}#${attempt}` : null,
    (signal) => searchContributors(trimmed, signal),
    { debounceMs: 180, identity: searchable ? trimmed : null },
  );
  const page = search.dataIdentity === trimmed ? search.data : null;
  const failed = search.error !== null && search.errorIdentity === trimmed;
  const items = page?.contributors ?? [];

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
  if (page !== null && searchable) {
    const key = contributorNameKey(trimmed);
    const duplicate = takenNewKeys.has(key);
    options.push({ id: "create", kind: "Create", disabled: duplicate });
    // A person by this name exists here or in results: offer a second one.
    if (
      duplicate ||
      items.some((item) => contributorNameKey(item.displayName) === key)
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
  const truncated = page?.nextCursor != null;
  const status = overLength
    ? "A name can be up to 200 characters."
    : !searchable || failed
      ? ""
      : page === null
        ? "Searching…"
        : items.length === 0
          ? "No matching authors"
          : truncated
            ? `Showing the first ${count(items.length, "author")} — keep typing to narrow.`
            : `${count(items.length, "author")} found`;
  const results = options.filter((option) => option.kind === "Existing");
  const creates = options.filter((option) => option.kind !== "Existing");

  function choose(option: Option | null) {
    if (option === null || option.disabled) return;
    if (option.kind === "Existing") onSelectExisting(option.item);
    else onCreateNew(trimmed);
  }

  useEscapeKey(
    true,
    () => {
      if (composing.current) return;
      if (listVisible) setOpen(false);
      else onDismiss();
    },
    {
      layer: "transient",
      modalToken,
      isEligible: () =>
        rootRef.current?.contains(document.activeElement) ?? false,
    },
  );

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
      if (failed) setAttempt((n) => n + 1);
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
          setOpen(true);
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={onKeyDown}
      />
      <div
        id={`${id}-status`}
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {status}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {failed ? "Couldn't load authors" : ""}
      </div>
      {listVisible ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Authors"
          className={styles.list}
        >
          {failed ? (
            <div className={styles.status}>
              {"Couldn't load authors "}
              <button
                type="button"
                className={styles.textButton}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </button>
            </div>
          ) : status && (overLength || items.length === 0) ? (
            <div className={styles.status}>{status}</div>
          ) : null}
          {failed ? null : (
            <>
              {results.map((option) =>
                option.kind === "Existing" ? (
                  <div
                    key={option.id}
                    className={styles.option}
                    {...optionProps(option)}
                  >
                    <span className={styles.name} dir="auto">
                      {option.item.displayName}
                    </span>
                    <span className={styles.meta}>
                      {count(option.item.workCount, "work")}
                      {option.item.workExamples.map((example, index) => (
                        <span key={example.href} dir="auto">
                          {index === 0 ? " · " : ", "}
                          {example.title}
                        </span>
                      ))}
                    </span>
                    {option.item.matchedAlias ? (
                      <span className={styles.meta}>
                        also known as{" "}
                        <span dir="auto">{option.item.matchedAlias}</span>
                      </span>
                    ) : null}
                    {option.disabled ? (
                      <span className={styles.meta}>Already added</span>
                    ) : null}
                  </div>
                ) : null,
              )}
              {truncated ? (
                <div className={styles.status}>
                  Keep typing to narrow results.
                </div>
              ) : null}
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
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
