"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, Loader2, Lock, Minus, Plus } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import { isReservedName, RESERVED_NAME } from "@/lib/libraries/views";
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

function membership(value: Membership | null): string {
  if (value === null) return "membership unknown";
  if (value.total === 1) return value.included === 1 ? "included" : "not included";
  return `in ${value.included} of ${value.total} items`;
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

/** One action list. Membership is descriptive; selection means the active suggestion. */
export default function LibraryChooser({
  rows, onToggle, loading, summary, status, error, create, empty,
  label = create === null ? "search libraries" : "search or create a library",
}: {
  readonly rows: readonly ChooserRow[];
  readonly onToggle: (change: { id: string; included: boolean }) => boolean;
  readonly loading: boolean;
  readonly summary: string;
  readonly status?: string;
  readonly error: ChooserError | null;
  readonly create: ChooserCreation | null;
  readonly empty: string;
  readonly label?: string;
}) {
  const base = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; sequence: number } | null>(null);
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
  const reserved = create !== null && isReservedName(name);
  const tooLong = [...name].length > 100;
  const canCreate = create?.available === true && name !== "" && !reserved && !tooLong
    && !rows.some(row => row.name.trim().toLowerCase() === q)
    && !create.pendingNames.some(pending => pending.trim().toLowerCase() === q);
  const options = matching.map(row => ({ id: `${base}-row-${row.id}`, row }));
  const createId = `${base}-create`;
  const ids = [...options.map(option => option.id), ...(canCreate ? [createId] : [])];
  const current = active !== null && ids.includes(active) ? active : null;

  useLayoutEffect(() => {
    if (active !== current) setActive(current);
    const option = current === null ? null : document.getElementById(current);
    const box = list.current;
    if (!option || !box?.contains(option)) return;
    const bounds = box.getBoundingClientRect();
    const top = bounds.top + box.clientTop;
    const bottom = top + box.clientHeight;
    const rect = option.getBoundingClientRect();
    if (rect.top < top) box.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) box.scrollTop += rect.bottom - bottom;
  }, [active, current, matching, canCreate]);

  function announce(text: string) {
    setAnnouncement(previous => ({ text, sequence: (previous?.sequence ?? 0) + 1 }));
  }
  function accept(id: string) {
    let accepted: boolean;
    if (id === createId && canCreate && create !== null) {
      accepted = create.onCreate(name);
      if (accepted) announce(`creating “${name}”`);
    } else {
      const row = options.find(option => option.id === id)?.row;
      if (!row) return;
      if (row.action.kind === "Blocked") { announce(row.action.reason); return; }
      accepted = onToggle({ id: row.id, included: row.action.included });
      if (accepted) announce(`${row.name}: ${row.action.label}`);
    }
    if (!accepted) return;
    setQuery("");
    setActive(null);
    input.current?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          ref={input}
          bare
          className={styles.search}
          role="combobox"
          aria-label={label}
          aria-controls={`${base}-listbox`}
          aria-expanded={true}
          aria-activedescendant={current ?? undefined}
          aria-autocomplete="list"
          value={query}
          placeholder={label}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={event => { setQuery(event.target.value); setActive(null); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat && current !== null) accept(current);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            event.stopPropagation();
            if (ids.length === 0) return;
            const index = current === null ? -1 : ids.indexOf(current);
            const next = current === null ? event.key === "ArrowDown" ? 0 : ids.length - 1
              : Math.max(0, Math.min(ids.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
            setActive(ids[next]);
          }}
        />
      </div>
      <p className={styles.summary}>{summary}</p>
      {status ? <p className={styles.status} role="status">{status}</p> : null}
      {error ? <FeedbackNotice content={error.content} announcement="Assertive"
        actions={error.retry ? [{ label: "retry", onClick: error.retry }] : undefined} /> : null}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement ? <span key={announcement.sequence}>{announcement.text}</span> : null}
      </div>
      <div ref={list} id={`${base}-listbox`} role="listbox" aria-label="library options"
        aria-busy={loading || undefined} className={styles.list}>
        {options.map(({ id, row }) => {
          const blocked = row.action.kind === "Blocked";
          const description = [membership(row.confirmed), progress(row), row.note,
            row.action.kind === "Set" ? row.action.label : row.action.reason].filter(Boolean).join(" · ");
          return <div key={id} id={id} role="option" aria-selected={current === id}
            aria-disabled={blocked || undefined} aria-labelledby={`${id}-name`} aria-describedby={`${id}-description`}
            className={styles.option} data-active={current === id || undefined}
            onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(id)} onClick={() => accept(id)}>
            <span className={styles.text}>
              <span id={`${id}-name`} className={styles.name}>{row.name}</span>
              <span id={`${id}-description`} className={styles.note}>{description}</span>
            </span>
            {row.progress === "Pending" || row.progress === "Reconciling" ? <Loader2 className={styles.spinner} size={16} aria-hidden="true" />
              : row.progress === "Uncertain" ? <CircleAlert size={16} aria-hidden="true" />
              : blocked ? <Lock size={16} aria-hidden="true" />
                : row.intended?.included === row.intended?.total && row.intended !== null ? <Check className={styles.check} size={16} aria-hidden="true" />
                  : row.intended && row.intended.included > 0 ? <Minus className={styles.check} size={16} aria-hidden="true" /> : null}
          </div>;
        })}
        {canCreate ? <div id={createId} role="option" aria-selected={current === createId}
          aria-label={`create “${name}”`} className={styles.option} data-action="Create" data-active={current === createId || undefined}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(createId)} onClick={() => accept(createId)}>
          <Plus size={16} aria-hidden="true" /><span className={styles.name}>create “{name}”</span>
        </div> : null}
        {loading && rows.length === 0 ? <p className={styles.empty}>loading libraries…</p>
          : matching.length === 0 && !canCreate ? <p className={styles.empty}>{reserved ? RESERVED_NAME
            : create !== null && tooLong ? "use 100 characters or fewer" : q === "" ? empty : "no libraries match"}</p> : null}
      </div>
    </div>
  );
}
