"use client";

// Choose named libraries to file into: a paged, ranked search over the libraries
// the viewer administers, the chosen ones kept on top, and Create where the
// caller offers it, plus the trigger that discloses it. Controlled: the caller
// owns the chosen list and the transport (the web api, or the extension's
// background), so this module carries no app state. One read at a time: a new
// query aborts the read in flight, so a page always answers the query it was
// asked for, and closing leaves nothing running. For several items at once the
// caller also passes the libraries only some of them are in; the chooser then
// shows checkboxes in place (a partial one indeterminate), and each toggle adds
// or removes one library: onChange gets the chosen list plus or minus it.

import { forwardRef, useEffect, useId, useRef, useState, type MouseEventHandler } from "react";
import { ChevronDown } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooser from "@/components/libraries/LibraryChooser";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import type { ListPage } from "@/lib/api/useServerList";
import type { LibraryDestination } from "@/lib/libraries/api";
import { RESERVED_NAME, isReservedName } from "@/lib/libraries/views";
import styles from "./DestinationChooser.module.css";

export type DestinationSearch = (
  q: string,
  cursor: string | null,
  signal: AbortSignal,
) => Promise<ListPage<LibraryDestination>>;

interface Results {
  readonly q: string;
  readonly items: readonly LibraryDestination[];
  readonly cursor: string | null;
}

export interface DestinationSource {
  readonly search: DestinationSearch;
  /** A failure's copy; null when there is nothing to show. */
  readonly describe: (error: unknown, title: string) => FeedbackContent | null;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

export const DestinationTrigger = forwardRef<
  HTMLButtonElement,
  {
    readonly label: string;
    /** The accessible name's prefix when the visible label is not enough. */
    readonly accessibleLabel?: string;
    readonly emptyLabel: string;
    readonly chosen: readonly LibraryDestination[];
    readonly expanded: boolean;
    readonly disabled: boolean;
    readonly onToggle: MouseEventHandler<HTMLButtonElement>;
    /** What it opens: a chooser dialog, or an inline region by id. */
    readonly controls: { readonly kind: "dialog" } | { readonly kind: "region"; readonly id: string };
  }
>(function DestinationTrigger(props, ref) {
  const names = props.chosen.map((library) => library.name).sort(byName);
  const summary =
    names.length === 0
      ? props.emptyLabel
      : names.length <= 2
        ? names.join(", ")
        : `${names[0]}, ${names[1]} +${names.length - 2}`;
  return (
    <button
      ref={ref}
      type="button"
      className={styles.trigger}
      aria-expanded={props.expanded}
      aria-haspopup={props.controls.kind === "dialog" ? "dialog" : undefined}
      aria-controls={props.controls.kind === "region" ? props.controls.id : undefined}
      aria-label={`${props.accessibleLabel ?? props.label}: ${names.length === 0 ? props.emptyLabel : names.join(", ")}`}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      <span className={styles.label}>{props.label}</span>
      <span className={styles.summary}>{summary}</span>
      <ChevronDown size={15} aria-hidden="true" data-open={props.expanded || undefined} />
    </button>
  );
});

export default function DestinationChooser({
  chosen,
  partial,
  onChange,
  source,
  onCreate,
  disabled,
  emptyLabel,
}: {
  readonly chosen: readonly LibraryDestination[];
  /** Libraries some but not all of several items are in (checkbox mode). */
  readonly partial?: readonly LibraryDestination[];
  readonly onChange: (next: readonly LibraryDestination[]) => void;
  readonly source: DestinationSource;
  /** Null where creating is not offered. */
  readonly onCreate: ((name: string) => Promise<LibraryDestination>) | null;
  readonly disabled: boolean;
  readonly emptyLabel: string;
}) {
  const { search, describe } = source;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [reading, setReading] = useState<"First" | "More" | null>(null);
  const [failure, setFailure] = useState<{
    readonly content: FeedbackContent;
    readonly retry: () => void;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const baseId = useId();
  const flight = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const read = (asked: string, after: Results | null) => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setReading(after ? "More" : "First");
    setFailure(null);
    search(asked, after?.cursor ?? null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setResults({
          q: asked,
          items: [...(after?.items ?? []), ...page.items],
          cursor: page.next_cursor,
        });
        setReading(null);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setReading(null);
        const content = describe(error, "Libraries couldn’t be loaded");
        if (content) setFailure({ content, retry: () => read(asked, after) });
      },
    );
  };
  // A typed query waits for a pause; the first read and an empty query do not.
  useEffect(() => {
    const timer = window.setTimeout(() => read(q, null), q === "" ? 0 : 180);
    return () => {
      window.clearTimeout(timer);
      flight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: `read` closes over this render's `search`; the query alone starts a read.
  }, [q]);

  const chosenIds = new Set(chosen.map((library) => library.id));
  const current = results?.q === q ? results : null;
  const name = query.trim();
  const reserved = isReservedName(name);
  const canCreate =
    onCreate !== null &&
    name.length > 0 &&
    name.length <= 100 &&
    !reserved &&
    current?.cursor === null &&
    ![...chosen, ...(partial ?? []), ...current.items].some(
      (library) => library.name.trim().toLowerCase() === q,
    );
  const rows = [
    ...chosen,
    ...(current?.items ?? []).filter((library) => !chosenIds.has(library.id)),
  ].map((library) => ({
    id: library.id,
    name: library.name,
    chosen: chosenIds.has(library.id),
    readOnly: null,
  }));

  const create = async () => {
    if (onCreate === null) return;
    setCreating(true);
    setFailure(null);
    try {
      onChange([...chosen, await onCreate(name)]);
      setQuery("");
    } catch (error) {
      const content = describe(error, "Library wasn’t created");
      if (content) setFailure({ content, retry: () => void create() });
    } finally {
      setCreating(false);
    }
  };

  // Checkbox rows keep their place when toggled: the listed ones the search
  // did not return first, then the results in their order.
  const found = new Set(current?.items.map((library) => library.id));
  const boxes = [...chosen, ...(partial ?? [])]
    .filter((library) => !found.has(library.id))
    .concat(current?.items ?? []);
  const count = partial ? boxes.length : rows.length;
  const busy = disabled || creating;
  const status = creating
    ? "Creating library…"
    : reading
      ? "Loading libraries…"
      : reserved
        ? RESERVED_NAME
        : `${count} ${count === 1 ? "library" : "libraries"}`;
  const empty =
    reading || current === null
      ? null
      : reserved
        ? RESERVED_NAME
        : q === ""
          ? emptyLabel
          : "No libraries match your search.";
  const more = current?.cursor ? () => read(q, current) : null;

  if (partial) {
    const partialIds = new Set(partial.map((library) => library.id));
    // Focus the search before the pressed control leaves the list.
    const keepFocus = () => searchRef.current?.focus({ preventScroll: true });
    return (
      <div className={styles.mixed}>
        <div className={styles.searchHeader}>
          <Input
            ref={searchRef}
            bare
            className={styles.search}
            aria-label="Search or create a library"
            aria-describedby={`${baseId}-status`}
            value={query}
            readOnly={busy}
            placeholder="Search or create"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div id={`${baseId}-status`} role="status" className="sr-only">
          {failure ? "" : status}
        </div>
        {failure ? (
          <FeedbackNotice
            content={failure.content}
            announcement="Assertive"
            actions={busy ? undefined : [{ label: "Retry", onClick: failure.retry }]}
          />
        ) : null}
        <div
          role="group"
          aria-label="Library options"
          aria-busy={busy || reading !== null || undefined}
          className={styles.choices}
        >
          {boxes.map((library) => {
            const all = chosenIds.has(library.id);
            return (
              <label key={library.id} className={styles.choice}>
                <input
                  type="checkbox"
                  checked={all}
                  ref={(box) => {
                    if (box) box.indeterminate = partialIds.has(library.id);
                  }}
                  disabled={busy}
                  onChange={() => {
                    if (all && !found.has(library.id)) keepFocus();
                    onChange(
                      all
                        ? chosen.filter((other) => other.id !== library.id)
                        : [...chosen, library],
                    );
                  }}
                />
                <span className={styles.name}>{library.name}</span>
              </label>
            );
          })}
          {canCreate ? (
            <Button
              variant="ghost"
              className={styles.action}
              disabled={busy}
              loading={creating}
              onClick={() => {
                keepFocus();
                void create();
              }}
            >
              Create “{name}”
            </Button>
          ) : null}
          {more ? (
            <Button
              variant="ghost"
              className={styles.action}
              disabled={busy}
              loading={reading === "More"}
              onClick={() => {
                keepFocus();
                more();
              }}
            >
              {reading === "More" ? "Loading more libraries…" : "Load more libraries"}
            </Button>
          ) : null}
          {empty !== null && boxes.length === 0 && !failure && !canCreate ? (
            <p className={styles.empty}>{empty}</p>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <LibraryChooser
      query={query}
      onQueryChange={setQuery}
      label={onCreate ? "Search or create a library" : "Search libraries"}
      placeholder={onCreate ? "Search or create" : "Search libraries"}
      chosenLabel="Selected"
      rows={rows}
      onToggle={(row) =>
        onChange(
          row.chosen
            ? chosen.filter((library) => library.id !== row.id)
            : [...chosen, { id: row.id, name: row.name }],
        )
      }
      busy={busy}
      loading={reading !== null}
      status={status}
      empty={empty}
      error={failure}
      create={canCreate ? { name, run: () => void create() } : null}
      more={more ? { loading: reading === "More", run: more } : null}
    />
  );
}
