"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import Input from "@/components/ui/Input";
import { useContributorSearch } from "@/lib/contributors/useContributorSearch";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import styles from "./AuthorSearchField.module.css";

/**
 * `AuthorSearchField` is the single-select author combobox used inside the
 * edit-authors dialog (content spec §2.3 / §7.1). It clones the
 * `LibraryDestinationPicker` interaction contract — labelled ARIA
 * combobox/listbox/options, `aria-activedescendant`, composition-safe input,
 * Arrow/Home/End/Enter — but drops multi-select (no `aria-multiselectable`, no
 * chips) and rides the shared explicit-state controller `useContributorSearch`
 * (D-34: `idle | loading | ready | empty | error`, AbortController + monotonic
 * stale-response suppression). Request failures surface as a visible retryable
 * error, never as an empty list.
 *
 * The field is the single Escape owner while it is mounted: the first Escape
 * closes the listbox (and `stopPropagation`s so the Dialog/MobileSheet dismiss
 * owner does not also fire); a further Escape past the listbox-close abandons the
 * search with no selection (`onDismiss`).
 */

export const MAX_AUTHOR_NAME_CODE_POINTS = 200;

/**
 * Client-side normalized name key (content spec §2.4 / S5): a deliberate
 * approximation of the server canonical key (`toNFKC_Casefold`). It gates only
 * the create-row affordances and the editor's new-row dedup — it is not a
 * correctness gate (the server enforces distinctness). Never hand-roll full
 * casefold / default-ignorable removal here.
 */
export function normalizedNameKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function workCountLabel(n: number): string {
  return n === 1 ? "1 work" : `${formatCount(n)} works`;
}

type Option =
  | { kind: "result"; id: string; item: ContributorSearchItem; disabled: boolean }
  | { kind: "create-primary"; id: string; disabled: boolean }
  | { kind: "create-distinct"; id: string };

function optionDisabled(option: Option): boolean {
  return option.kind === "create-distinct" ? false : option.disabled;
}

export interface AuthorSearchFieldProps {
  /** Seed query — "" when adding a row, the canonical display name when Changing. */
  initialQuery: string;
  /** Select-all the seed on mount so typing replaces it (Change flow). */
  selectInitial?: boolean;
  /**
   * Handles already bound in the editor (excluding the row under Change, N3):
   * their result rows render disabled ("Already added"), never hidden.
   */
  takenHandles: ReadonlySet<string>;
  /** Normalized display keys of new-binding rows: suppress a duplicate create. */
  takenNewNameKeys: ReadonlySet<string>;
  /** Bind an existing contributor result. */
  onSelectExisting: (item: ContributorSearchItem) => void;
  /** Create a new author from the trimmed query (both create rows land here). */
  onCreateNew: (displayName: string) => void;
  /** Abandon the combobox with no selection (Escape-past-listbox-close). */
  onDismiss: () => void;
}

export default function AuthorSearchField({
  initialQuery,
  selectInitial = false,
  takenHandles,
  takenNewNameKeys,
  onSelectExisting,
  onCreateNew,
  onDismiss,
}: AuthorSearchFieldProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const politeId = `${id}-status`;
  const optionId = (rowId: string) => `${id}-option-${rowId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const trimmed = query.trim();
  const codePoints = [...trimmed].length;
  const overLength = codePoints > MAX_AUTHOR_NAME_CODE_POINTS;
  const nonBlank = trimmed.length >= 1;
  // Over-length queries never hit the server (blank query → idle). "Try again"
  // bumps `retryTick`, which re-runs the same query via the controller's
  // `reloadToken` — an honest re-fetch, not a whitespace perturbation.
  const state = useContributorSearch(overLength ? "" : query, { reloadToken: retryTick });

  // Autofocus on mount; select-all for the Change prefill.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectInitial) el.select();
    // Only on mount — the field is remounted per Add/Change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = useMemo<Option[]>(() => {
    const list: Option[] = [];
    const items = state.status === "ready" ? state.items : [];
    for (const item of items) {
      list.push({
        kind: "result",
        id: `result-${item.handle}`,
        item,
        disabled: takenHandles.has(item.handle),
      });
    }
    const settled =
      (state.status === "ready" || state.status === "empty") && state.query === trimmed;
    if (settled && nonBlank && !overLength) {
      const queryKey = normalizedNameKey(trimmed);
      const matchesExistingNewRow = takenNewNameKeys.has(queryKey);
      const sameNameInResults = items.some(
        (item) => normalizedNameKey(item.displayName) === queryKey,
      );
      // "Same name exists" (§2.4 / S5) compares the query against both server
      // results AND already-present new-binding rows — so a second, deliberately
      // distinct same-name author can still be created when the only match so far
      // is a local new row (its primary create is disabled below as a duplicate).
      const sameNameExists = sameNameInResults || matchesExistingNewRow;
      list.push({ kind: "create-primary", id: "create-primary", disabled: matchesExistingNewRow });
      if (sameNameExists) {
        list.push({ kind: "create-distinct", id: "create-distinct" });
      }
    }
    return list;
  }, [state, takenHandles, takenNewNameKeys, trimmed, nonBlank, overLength]);

  // Effective active option, derived during render (never via an effect) so a
  // stale "initialize" effect can never clobber an in-flight Arrow move: an
  // explicit `activeId` wins while it still points at a live option, otherwise
  // the first option is active by default.
  const effectiveActiveId =
    activeId && options.some((option) => option.id === activeId)
      ? activeId
      : (options[0]?.id ?? null);

  const listboxVisible = open && (overLength || state.status !== "idle");
  const truncated = state.status === "ready" && state.nextCursor !== null;

  const politeStatus = overLength
    ? "A name can be up to 200 characters."
    : state.status === "loading"
      ? "Searching…"
      : state.status === "ready"
        ? truncated
          ? `Showing the first ${formatCount(state.items.length)} authors — keep typing to narrow.`
          : state.items.length === 1
            ? "1 author found"
            : `${formatCount(state.items.length)} authors found`
        : state.status === "empty"
          ? "No matching authors"
          : "";
  const assertiveStatus = !overLength && state.status === "error" ? "Couldn't load authors" : "";

  function retry() {
    setRetryTick((tick) => tick + 1);
  }

  function activate(option: Option) {
    if (optionDisabled(option)) return;
    if (option.kind === "result") {
      onSelectExisting(option.item);
      return;
    }
    onCreateNew(trimmed);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      setOpen(true);
      if (options.length === 0) return;
      const current = options.findIndex((option) => option.id === effectiveActiveId);
      const start = current >= 0 ? current : 0;
      const last = options.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveId(options[next]!.id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!overLength && state.status === "error") {
        retry();
        return;
      }
      const option =
        options.find((candidate) => candidate.id === effectiveActiveId) ?? options[0];
      if (option) activate(option);
      return;
    }
    if (event.key === "Escape") {
      // Single Escape owner while mounted: consume the event either way. React's
      // synthetic `stopPropagation` stops parent React handlers and native
      // ancestors, but the Dialog/MobileSheet install `useEscapeKey` as a raw
      // document listener. When React is rooted at `document` (Next App Router),
      // that owner sits on the same node and a synthetic stop can't reach it — so
      // also `stopImmediatePropagation` on the native event to keep exactly one
      // Escape owner (content spec §7.4).
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (listboxVisible) {
        setOpen(false);
      } else {
        onDismiss();
      }
    }
  }

  return (
    <div className={styles.root}>
      <label className={styles.srOnly} htmlFor={`${id}-input`}>
        Search authors
      </label>
      <Input
        ref={inputRef}
        id={`${id}-input`}
        className={styles.input}
        role="combobox"
        aria-expanded={listboxVisible}
        aria-controls={listboxVisible ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          listboxVisible && effectiveActiveId ? optionId(effectiveActiveId) : undefined
        }
        aria-describedby={politeId}
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
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={onKeyDown}
      />
      <div id={politeId} className={styles.srOnly} role="status" aria-live="polite">
        {politeStatus}
      </div>
      <div className={styles.srOnly} role="alert" aria-live="assertive">
        {assertiveStatus}
      </div>
      {listboxVisible ? (
        <div id={listboxId} role="listbox" aria-label="Authors" className={styles.list}>
          {overLength ? (
            <div className={styles.status}>A name can be up to 200 characters.</div>
          ) : state.status === "loading" ? (
            <div className={styles.status}>Searching…</div>
          ) : state.status === "error" ? (
            <div className={styles.errorRow}>
              <span className={styles.errorText}>{"Couldn't load authors"}</span>
              <button
                type="button"
                className={styles.tryAgain}
                // Not a listbox tab stop: keyboard retry is Enter-on-input
                // (the combobox owns focus); the button stays mouse-clickable.
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={retry}
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              {options
                .filter((option) => option.kind === "result")
                .map((option) => {
                  const result = option as Extract<Option, { kind: "result" }>;
                  return (
                    <div
                      key={result.id}
                      id={optionId(result.id)}
                      role="option"
                      aria-selected={result.id === effectiveActiveId}
                      aria-disabled={result.disabled || undefined}
                      className={styles.option}
                      data-active={result.id === effectiveActiveId || undefined}
                      data-disabled={result.disabled || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActiveId(result.id)}
                      onClick={() => activate(result)}
                    >
                      <span className={styles.name} dir="auto">
                        {result.item.displayName}
                      </span>
                      <span className={styles.meta}>
                        {workCountLabel(result.item.workCount)}
                        {result.item.workExamples.length > 0 ? (
                          <>
                            {" · "}
                            {result.item.workExamples.slice(0, 2).map((example, index) => (
                              <Fragment key={`${example.href}-${index}`}>
                                {index > 0 ? ", " : null}
                                <span dir="auto">{example.title}</span>
                              </Fragment>
                            ))}
                          </>
                        ) : null}
                      </span>
                      {result.item.matchedAlias ? (
                        <span className={styles.alias}>
                          also known as <span dir="auto">{result.item.matchedAlias}</span>
                        </span>
                      ) : null}
                      {result.disabled ? (
                        <span className={styles.addedNote}>Already added</span>
                      ) : null}
                    </div>
                  );
                })}
              {state.status === "empty" ? (
                <div className={styles.status}>No matching authors</div>
              ) : null}
              {truncated ? (
                <div className={styles.hint}>Keep typing to narrow results.</div>
              ) : null}
              {options
                .filter((option) => option.kind !== "result")
                .map((option) =>
                  option.kind === "create-primary" ? (
                    <div
                      key={option.id}
                      id={optionId(option.id)}
                      role="option"
                      aria-selected={option.id === effectiveActiveId}
                      aria-disabled={option.disabled || undefined}
                      className={styles.createOption}
                      data-active={option.id === effectiveActiveId || undefined}
                      data-disabled={option.disabled || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActiveId(option.id)}
                      onClick={() => activate(option)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span className={styles.createText}>
                        Create “<span dir="auto">{trimmed}</span>” as a new author
                      </span>
                      {option.disabled ? (
                        <span className={styles.addedNote}>Already added</span>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      key={option.id}
                      id={optionId(option.id)}
                      role="option"
                      aria-selected={option.id === effectiveActiveId}
                      className={styles.createOption}
                      data-active={option.id === effectiveActiveId || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActiveId(option.id)}
                      onClick={() => activate(option)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span className={styles.createText}>
                        Create a different author with this name
                      </span>
                    </div>
                  ),
                )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
