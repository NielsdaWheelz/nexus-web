"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, Loader2, Lock, Minus, Plus } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import collection from "@/components/ui/Collection.module.css";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import { libraryNameError } from "@/lib/libraries/views";
import styles from "./LibraryChooser.module.css";

type Membership = { readonly included: number; readonly total: number };
export interface ChooserRow {
  readonly id: string;
  readonly name: string;
  readonly confirmed: Membership | null;
  readonly intended: Membership | null;
  readonly progress: "Settled" | "Pending" | "Uncertain" | "Reconciling";
  readonly note?: string;
  readonly action:
    | { readonly kind: "Set"; readonly included: boolean; readonly label: string }
    | { readonly kind: "Blocked"; readonly reason: string };
}
export interface ChooserError {
  readonly content: FeedbackContent;
  readonly retry: (() => void) | null;
  readonly retryLabel?: string;
  readonly busy?: boolean;
  readonly commandKey?: string;
}
export interface ChooserCreation {
  readonly available: boolean;
  readonly pendingNames: readonly string[];
  readonly onCreate: (name: string) => boolean;
}

export function compareLibraryNames(a: { id: string; name: string }, b: { id: string; name: string }) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id));
}

function membership(value: Membership | null, kind: "Confirmed" | "Chosen"): string {
  if (value === null) return kind === "Confirmed" ? "membership unknown" : "destination unknown";
  if (value.total === 1) return kind === "Confirmed"
    ? value.included === 1 ? "included" : "not included"
    : value.included === 1 ? "chosen destination" : "not chosen";
  return `${kind === "Chosen" ? "chosen for " : "in "}${value.included} of ${value.total} items`;
}
function progress(row: ChooserRow): string | null {
  switch (row.progress) {
    case "Settled": return null;
    case "Uncertain": return "change not confirmed";
    case "Reconciling": return "checking membership…";
    case "Pending": {
      if (row.confirmed === null || row.intended === null) return "updating…";
      const difference = row.intended.included - row.confirmed.included;
      return difference > 0 ? "adding…" : difference < 0 ? "removing…" : "updating…";
    }
  }
}

/** Search actions retain their query. Checks show confirmed membership or an explicitly chosen draft destination; highlight is the current suggestion. */
export default function LibraryChooser({
  context, membershipKind, rows, onToggle, loading, summary, status, error, create, empty,
  label = create === null ? "search libraries" : "search or create a library",
}: {
  readonly context: string;
  readonly membershipKind: "Confirmed" | "Chosen";
  readonly rows: readonly ChooserRow[];
  readonly onToggle: (change: { id: string; included: boolean }) => boolean;
  readonly loading: boolean;
  readonly summary: string | null;
  readonly status?: string;
  readonly error: ChooserError | null;
  readonly create: ChooserCreation | null;
  readonly empty: string;
  readonly label?: string;
}) {
  const base = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SearchActive>(null);
  const name = query.trim();
  const q = name.toLowerCase();
  const matching = useMemo(() => {
    const rank = (row: ChooserRow) => {
      const candidate = row.name.trim().toLowerCase();
      return candidate === q ? 0 : candidate.startsWith(q) ? 1 : 2;
    };
    return rows.filter(row => row.name.trim().toLowerCase().includes(q))
      .toSorted((a, b) => rank(a) - rank(b) || compareLibraryNames(a, b));
  }, [rows, q]);
  const invalid = create === null || name === "" ? null : libraryNameError(name);
  const canCreate = create?.available === true && name !== "" && invalid === null
    && !rows.some(row => row.name.trim().toLowerCase() === q)
    && !create.pendingNames.some(pending => pending.trim().toLowerCase() === q);
  const createKey = `create:${name}`;
  const options = [
    ...matching.map(row => ({ key: row.id, disabledReason: row.action.kind === "Blocked" ? row.action.reason : null })),
    ...(canCreate ? [{ key: createKey, disabledReason: null }] : []),
  ];
  const searchContext = JSON.stringify([context, query]);
  const current = reconcileSearchActive({
    context: searchContext, admitted: true, options,
    firstExistingKey: matching.find(row => row.action.kind === "Set")?.id ?? null, active,
  });
  if (current !== active) setActive(current);
  const navigation = useSearchOptions({
    listId: `${base}-listbox`, label: "library options", open: true, options,
    activeKey: current?.key ?? null,
    onActiveChange: key => setActive({ context: searchContext, key }),
    onActivate: key => {
      if (key === createKey && canCreate && create !== null) {
        create.onCreate(name);
        return;
      }
      const row = matching.find(row => row.id === key);
      if (row?.action.kind === "Set") onToggle({ id: row.id, included: row.action.included });
    },
  });

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          ref={input}
          bare
          className={collection.search}
          {...navigation.inputProps}
          aria-label={label}
          value={query}
          placeholder={label}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (!navigation.handleKey(event.nativeEvent, composing.current)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </div>
      {summary !== null ? <p className={`${styles.summary} ${collection.detail}`}>{summary}</p> : null}
      {status ? <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="Polite" /> : null}
      {error ? <FeedbackNotice content={error.content} announcement="Assertive"
        returnFocus={() => input.current}
        actions={error.retry ? [{ label: error.retryLabel ?? "retry", onClick: error.retry, busy: error.busy ?? loading, commandKey: error.commandKey }] : undefined} /> : null}
      <div ref={navigation.listRef} {...navigation.listProps}
        aria-busy={loading || undefined} className={collection.compactViewport}>
        {matching.map(row => {
          const binding = navigation.optionProps(row.id);
          const count = membershipKind === "Confirmed" ? row.confirmed : row.intended;
          const blocked = row.action.kind === "Blocked";
          const changing = progress(row);
          const description = [membership(count, membershipKind), changing, row.note,
            row.action.kind === "Set" ? row.action.label : row.action.reason].filter(Boolean).join(" · ");
          const detail = [count !== null && count.total > 1 ? membership(count, membershipKind) : null,
            changing, row.note].filter(Boolean).join(" · ");
          return <div key={row.id} {...binding}
            aria-labelledby={`${binding.id}-name`} aria-describedby={`${binding.id}-description`}
            className={collection.row} data-selected={count !== null && count.total > 0 && count.included === count.total || undefined}>
            <span className={collection.content}>
              <span id={`${binding.id}-name`}>{row.name}</span>
              {detail ? <span className={collection.detail} aria-hidden="true">{detail}</span> : null}
              <span id={`${binding.id}-description`} className="sr-only">{description}</span>
            </span>
            <span className={`${collection.adornment} ${styles.marks}`} aria-hidden="true">
              <span>{row.progress === "Pending" || row.progress === "Reconciling" ? <Loader2 size={16} />
                : row.progress === "Uncertain" ? <CircleAlert size={16} /> : null}</span>
              <span>{blocked ? <Lock size={16} /> : null}</span>
              <span>{count === null ? "?" : count.total > 0 && count.included === count.total ? <Check size={16} />
                : count.included > 0 ? <Minus size={16} /> : null}</span>
            </span>
          </div>;
        })}
        {canCreate ? <div {...navigation.optionProps(createKey)}
          aria-label={`create “${name}”`} className={collection.row} data-tone="accent">
          <Plus className={collection.adornment} size={16} aria-hidden="true" />
          <span className={collection.content}>create “{name}”</span>
        </div> : null}
      </div>
      {loading && rows.length === 0 ? <div className={styles.empty}><FeedbackStatus content={{ tone: "Neutral", title: "loading libraries…" }} announcement="None" /></div>
        : matching.length === 0 && !canCreate ? <div className={styles.empty}><FeedbackStatus content={{ tone: "Neutral", title: invalid
          ?? (q === "" ? empty : "no libraries match") }} announcement="None" /></div> : null}
    </div>
  );
}
