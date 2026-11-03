"use client";
import * as Icon from "@/lib/ui/icons";

import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { ControlContents } from "@/components/ui/control";
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
  readonly progress: "Settled" | "Pending" | "Uncertain";
  /** A visible lane note on the row's second line. */
  readonly note?: string;
  /** `Blocked` waits, and says why to a screen reader alone, or nothing when the list's own failure
   * says it; `Locked` is durable, says why on the row and carries the lock mark. */
  readonly action:
    | { readonly kind: "Set"; readonly included: boolean; readonly label: string }
    | { readonly kind: "Blocked"; readonly reason: string | null }
    | { readonly kind: "Locked"; readonly reason: string };
}
/** Only for callers outside this lane until they pass `failure`; L7 deletes it. */
export interface ChooserError {
  readonly occurrence: object;
  readonly content: FeedbackContent;
  readonly retry: (() => void) | null;
  readonly retryLabel?: string;
  readonly busy?: boolean;
  readonly commandKey?: string;
}
export interface ChooserCreation {
  readonly available: boolean;
  /** Why creation waits, said on its row while unavailable; without it the row is not offered. */
  readonly gate?: string;
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
    case "Uncertain": return "not sure that saved";
    case "Pending": {
      if (row.confirmed === null || row.intended === null) return "updating…";
      const difference = row.intended.included - row.confirmed.included;
      return difference > 0 ? "adding…" : difference < 0 ? "removing…" : "updating…";
    }
  }
}

/** Search actions retain their query. Each row carries two marks: its status (spinner, alert or
 * lock) and its membership (check, minus, or `?` while unknown). The only failure in the list region
 * is the owner's read; a command's outcome speaks where its owner raises it. A create row its owner
 * gates stands disabled with the reason. */
export default function LibraryChooser({
  context, membershipKind, rows, onToggle, loading, summary, failure, error, create, empty, scrollRef,
  label = create === null ? "search libraries" : "search or create a library",
}: {
  readonly context: string;
  readonly scrollRef?: RefObject<HTMLDivElement | null>;
  readonly membershipKind: "Confirmed" | "Chosen";
  readonly rows: readonly ChooserRow[];
  readonly onToggle: (change: { id: string; included: boolean }) => boolean;
  readonly loading: boolean;
  readonly summary: string | null;
  /** The owner's read failure: its `Failed`, or a domain `Fact`. */
  readonly failure?: ReactNode;
  readonly error?: ChooserError | null;
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
  const named = create !== null && name !== "" && invalid === null
    && !rows.some(row => row.name.trim().toLowerCase() === q)
    && !create.pendingNames.some(pending => pending.trim().toLowerCase() === q);
  const canCreate = named && create?.available === true;
  const createGate = named && create?.available === false ? create.gate ?? null : null;
  const createKey = `create:${name}`;
  const options = [
    // A blocked row with nothing to say is still disabled: an empty reason.
    ...matching.map(row => ({ key: row.id, disabledReason: row.action.kind === "Set" ? null : row.action.reason ?? "" })),
    ...(canCreate || createGate !== null ? [{ key: createKey, disabledReason: createGate }] : []),
  ];
  const searchContext = JSON.stringify([context, query]);
  const current = reconcileSearchActive({
    context: searchContext, admitted: true, options,
    initialKey: matching.find(row => row.action.kind === "Set")?.id ?? null, active,
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
  const legacy = error ? <Fact line={{ fact: error.content.title, reason: error.content.message }}
    verbs={error.retry ? [{ label: error.retryLabel ?? "retry", commandKey: error.commandKey ?? "library-read", run: error.retry, busy: error.busy ?? loading }] : undefined} /> : null;
  const shownFailure = failure ?? legacy;
  const invalidId = `${base}-invalid`;
  const nothing = !loading && !shownFailure && matching.length === 0 && !canCreate && createGate === null;
  const refused = nothing && invalid !== null;

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          ref={input}
          bare
          className={collection.search}
          {...navigation.inputProps}
          aria-label={label}
          aria-describedby={refused ? invalidId : undefined}
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
      <div ref={scrollRef} className={styles.body}>
      {summary !== null ? <p className={`${styles.summary} ${collection.detail}`}>{summary}</p> : null}
      {shownFailure ? <div className={styles.region}>{shownFailure}</div> : null}
      {loading && rows.length === 0 && !shownFailure ? <div className={styles.ruling}><Ruling /></div> : null}
      <div ref={navigation.listRef} {...navigation.listProps} className={collection.compactViewport}>
        {matching.map(row => {
          const binding = navigation.optionProps(row.id);
          const count = membershipKind === "Confirmed" ? row.confirmed : row.intended;
          const description = [membership(count, membershipKind), progress(row), row.note,
            row.action.kind === "Set" ? row.action.label : row.action.reason].filter(Boolean).join(" · ");
          const detail = [count !== null && count.total > 1 ? membership(count, membershipKind) : null,
            row.note, row.action.kind === "Locked" ? row.action.reason : null].filter(Boolean).join(" · ");
          return <div key={row.id} {...binding}
            aria-labelledby={`${binding.id}-name`} aria-describedby={`${binding.id}-description`}
            className={collection.row} aria-busy={row.progress === "Pending" || undefined}
            data-selected={count !== null && count.total > 0 && count.included === count.total || undefined}>
            <span className={collection.content}>
              <span id={`${binding.id}-name`}>{row.name}</span>
              {detail ? <span className={collection.detail} aria-hidden="true">{detail}</span> : null}
              <span id={`${binding.id}-description`} className="sr-only">{description}</span>
            </span>
            <span className={`${collection.adornment} ${styles.marks}`} aria-hidden="true">
              <ControlContents busy={row.progress === "Pending"}
                icon={row.progress === "Uncertain" ? <Icon.Warning /> : row.action.kind === "Locked" ? <Icon.Blocked /> : undefined} />
              <span className={styles.mark}>{count === null ? "?" : count.total > 0 && count.included === count.total ? <Icon.Check size={16} />
                : count.included > 0 ? <Icon.Remove size={16} /> : null}</span>
            </span>
          </div>;
        })}
        {canCreate || createGate !== null ? <div {...navigation.optionProps(createKey)}
          aria-label={`create “${name}”`} aria-describedby={createGate === null ? undefined : `${base}-create-gate`}
          className={collection.row} data-tone="accent">
          <Icon.Add className={collection.adornment} size={16} aria-hidden="true" />
          <span className={collection.content}>
            <span>create “{name}”</span>
            {createGate === null ? null : <span id={`${base}-create-gate`} className={collection.detail}>{createGate}</span>}
          </span>
        </div> : null}
      </div>
      {nothing ? <div className={styles.region}>{refused
        ? <Field id={invalidId} line={{ fact: invalid }} />
        : <Fact line={{ fact: q === "" ? empty : "no libraries match." }} />}</div> : null}
      </div>
    </div>
  );
}
