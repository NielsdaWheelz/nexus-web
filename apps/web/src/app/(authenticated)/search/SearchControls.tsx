"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import ContributorFilter, {
  useContributorFilterLabels,
} from "@/components/contributors/ContributorFilter";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import {
  MEDIA_FORMAT_LABELS,
  MEDIA_FORMATS,
  SEARCH_KIND_LABELS,
  SEARCH_KINDS,
  disabledKinds,
  type SearchKind,
} from "@/lib/search/kinds";
import { settleSearchBox } from "@/lib/search/parseSearchInput";
import {
  applyParsedInput,
  emptySearchQuery,
  type SearchQuery,
} from "@/lib/search/query";
import { searchHref } from "@/lib/search/searchParams";
import styles from "./page.module.css";

const SETTLE_MS = 200;

/**
 * What to find: the box, the inline filter options and the applied chips. The
 * url owns the query; the box is a draft whose text and completed operators
 * become the query 200 ms after typing stops (the operator at the caret waits),
 * or at once on Enter. `commit` replaces the pane url.
 */
export default function SearchControls(props: {
  readonly query: SearchQuery;
  readonly commit: (next: SearchQuery) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly status: { readonly text: string; readonly announce: boolean };
}) {
  const { query, commit, inputRef, status } = props;
  const [draft, setDraft] = useState(query.text);
  const written = useRef(query.text);
  const statusId = useId();
  const { labels, remember } = useContributorFilterLabels(query.authors);

  const write = useCallback(
    (next: SearchQuery) => {
      written.current = next.text;
      commit(next);
    },
    [commit],
  );
  // the caret of the last edit: its operator is still being typed (null after Enter)
  const caret = useRef<number | null>(null);
  const apply = useCallback(
    (enter: boolean) => {
      if (enter) caret.current = null;
      const settled = settleSearchBox(draft, caret.current);
      if (settled.box !== draft) {
        if (caret.current !== null) caret.current = settled.caret;
        // render the new box now, so the caret can be placed in it
        flushSync(() => setDraft(settled.box));
        const input = inputRef.current;
        if (input !== null && input === document.activeElement)
          input.setSelectionRange(settled.caret, settled.caret);
      }
      const next = applyParsedInput(query, settled.parsed);
      if (searchHref(next) !== searchHref(query)) write(next);
    },
    [draft, inputRef, query, write],
  );
  // only edits settle: the url's own text is never mined for operators
  useEffect(() => {
    if (draft === written.current) return;
    const timer = setTimeout(() => apply(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [apply, draft]);
  // another writer (Nexus, pane history, a restored visit) replaces the box
  useEffect(() => {
    if (query.text === written.current) return;
    written.current = query.text;
    setDraft(query.text);
  }, [query.text]);

  const clearText = () => {
    setDraft("");
    if (query.text !== "") write({ ...query, text: "" });
  };
  const toggleKind = (kind: SearchKind) => {
    const active = new Set(query.requestedKinds ?? SEARCH_KINDS);
    if (!active.delete(kind)) active.add(kind);
    const all = active.size === SEARCH_KINDS.length;
    write({ ...query, requestedKinds: all ? null : active });
  };
  const { kinds: disabled, reason } = disabledKinds({
    hasFormatFilter: query.formats.length > 0,
    hasCreditFilter: query.authors.length + query.roles.length > 0,
  });
  const kinds = query.requestedKinds;
  const chip = (id: string, label: string, change: Partial<SearchQuery>) => ({
    id,
    label,
    next: { ...query, ...change },
  });
  const chips = [
    ...(kinds === null
      ? []
      : [
          chip(
            "kinds",
            kinds.size === 0
              ? "No content types"
              : `Content types: ${SEARCH_KINDS.filter((kind) => kinds.has(kind))
                  .map((kind) => SEARCH_KIND_LABELS[kind])
                  .join(", ")}`,
            { requestedKinds: null },
          ),
        ]),
    ...query.formats.map((format) =>
      chip(`format:${format}`, `Format: ${MEDIA_FORMAT_LABELS[format]}`, {
        formats: query.formats.filter((f) => f !== format),
      }),
    ),
    ...query.authors.map((handle) =>
      chip(`author:${handle}`, `Author: ${labels[handle] ?? handle}`, {
        authors: query.authors.filter((a) => a !== handle),
      }),
    ),
    ...query.roles.map((role) =>
      chip(`role:${role}`, `Role: ${role}`, {
        roles: query.roles.filter((r) => r !== role),
      }),
    ),
    ...(query.scope === "all"
      ? []
      : [chip("scope", `In: ${query.scope}`, { scope: "all" })]),
  ];

  return (
    <PaneQueryToolbar
      inputRef={inputRef}
      input={{
        label: "Search content",
        placeholder: "Search your Nexus",
        value: draft,
        appliedValue: query.text,
        onChange: (value) => {
          caret.current = inputRef.current?.selectionStart ?? null;
          setDraft(value);
        },
        onClear: clearText,
        keyShortcuts: "Enter Escape",
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) apply(true);
        },
      }}
      options={{
        label: "Filters",
        activeCount: chips.length,
        onClear: () => write({ ...emptySearchQuery(), text: query.text }),
        content: (
          <>
            <fieldset className={styles.optionGroup}>
              <legend>Content types</legend>
              <div className={styles.choices}>
                {SEARCH_KINDS.map((kind) => (
                  <ChoiceField
                    key={kind}
                    label={SEARCH_KIND_LABELS[kind]}
                    checked={(kinds?.has(kind) ?? true) && !disabled.has(kind)}
                    disabled={disabled.has(kind)}
                    description={disabled.has(kind) ? (reason ?? undefined) : undefined}
                    onChange={() => toggleKind(kind)}
                  />
                ))}
              </div>
            </fieldset>
            <fieldset className={styles.optionGroup}>
              <legend>Formats</legend>
              <div className={styles.choices}>
                {MEDIA_FORMATS.map((format) => {
                  const on = query.formats.includes(format);
                  return (
                    <ChoiceField
                      key={format}
                      label={MEDIA_FORMAT_LABELS[format]}
                      checked={on}
                      onChange={() =>
                        write({
                          ...query,
                          formats: on
                            ? query.formats.filter((f) => f !== format)
                            : [...query.formats, format],
                        })
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
            <ContributorFilter
              selectedHandles={query.authors}
              onAdd={(item) => {
                remember(item);
                if (!query.authors.includes(item.handle))
                  write({ ...query, authors: [...query.authors, item.handle] });
              }}
            />
            <p className={styles.hint}>
              Type format:pdf or author:le-guin in search, then a space or
              Enter.
            </p>
          </>
        ),
      }}
      chips={{
        items: chips,
        onRemove: (id) => {
          const chip = chips.find((candidate) => candidate.id === id);
          if (chip) write(chip.next);
        },
      }}
      status={{
        id: statusId,
        visible: true,
        content: (
          <>
            <span>Order: relevance</span>
            <span
              id={statusId}
              role={status.announce ? "status" : undefined}
              aria-live={status.announce ? "polite" : undefined}
              aria-atomic={status.announce ? true : undefined}
            >
              {status.text}
            </span>
          </>
        ),
      }}
      onReset={
        draft || query.text || chips.length > 0
          ? () => {
              setDraft("");
              write(emptySearchQuery());
            }
          : undefined
      }
    />
  );
}
