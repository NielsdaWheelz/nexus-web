"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import ContributorFilter, { useContributorFilterLabels } from "@/components/contributors/ContributorFilter";
import { CONTRIBUTOR_ROLES, contributorRoleLabel, type ContributorCredit } from "@/lib/contributors/credits";
import type { CollationDimension, CollationWords, PaneCollation } from "@/lib/panes/collation";
import { MEDIA_FORMAT_LABELS, MEDIA_FORMATS, SEARCH_KIND_LABELS, SEARCH_KINDS, disabledKinds } from "@/lib/search/kinds";
import { settleSearchBox } from "@/lib/search/parseSearchInput";
import { applyParsedInput, emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { searchHref } from "@/lib/search/searchParams";

const SETTLE_MS = 200;

/** Called above keyed results: edits, composition, caret and author labels survive a settle.
 * The url owns applied criteria; only edits are mined for completed operators. */
export function useSearchCollation({ query, commit, inputRef }: {
  readonly query: SearchQuery;
  readonly commit: (next: SearchQuery) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}): PaneCollation & { readonly words: CollationWords } {
  const [draft, setDraft] = useState(query.text);
  const [composing, setComposing] = useState(false);
  const [authorsOpen, setAuthorsOpen] = useState(false);
  const paneActive = usePaneIsActive();
  const written = useRef(query.text);
  const caret = useRef<number | null>(null);
  const { labels, remember } = useContributorFilterLabels(query.authors);
  const write = useCallback((next: SearchQuery) => {
    written.current = next.text;
    commit(next);
  }, [commit]);
  const apply = useCallback((enter: boolean) => {
    if (enter) caret.current = null;
    const settled = settleSearchBox(draft, caret.current);
    if (settled.box !== draft) {
      if (caret.current !== null) caret.current = settled.caret;
      flushSync(() => setDraft(settled.box));
      const input = inputRef.current;
      if (input !== null && input === document.activeElement)
        input.setSelectionRange(settled.caret, settled.caret);
    }
    const next = applyParsedInput(query, settled.parsed);
    if (searchHref(next) !== searchHref(query)) write(next);
  }, [draft, inputRef, query, write]);
  useEffect(() => {
    if (composing || draft === written.current) return;
    const timer = setTimeout(() => apply(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [apply, composing, draft]);
  // A different writer (Nexus, pane history or a restored visit) replaces the box.
  useEffect(() => {
    if (query.text === written.current) return;
    written.current = query.text;
    caret.current = null;
    setDraft(query.text);
  }, [query.text]);
  const clearText = () => {
    caret.current = null;
    written.current = "";
    setDraft("");
    if (query.text !== "") write({ ...query, text: "" });
  };
  const { kinds: disabled, reason } = disabledKinds({
    hasFormatFilter: query.formats.length > 0,
    hasCreditFilter: query.authors.length + query.roles.length > 0,
  });
  const dimensions: CollationDimension[] = [
    {
      kind: "Many", id: "kinds", label: "kind", rest: "any kind",
      values: SEARCH_KINDS.filter(kind => query.requestedKinds?.has(kind)),
      options: SEARCH_KINDS.map(value => ({ value, label: SEARCH_KIND_LABELS[value], sign: null, count: null, reason: disabled.has(value) ? reason : null })),
      onChange: values => {
        const kinds = SEARCH_KINDS.filter(kind => values.includes(kind));
        write({ ...query, requestedKinds: kinds.length === 0 || kinds.length === SEARCH_KINDS.length ? null : new Set(kinds) });
      },
    },
    {
      kind: "Many", id: "formats", label: "format", rest: "any format", values: query.formats,
      options: MEDIA_FORMATS.map(value => ({ value, label: MEDIA_FORMAT_LABELS[value], sign: null, count: null, reason: null })),
      onChange: values => write({ ...query, formats: MEDIA_FORMATS.filter(format => values.includes(format)) }),
    },
    {
      kind: "Many", id: "authors", label: "author", rest: "any author", values: query.authors,
      options: query.authors.map(value => ({ value, label: labels[value] ?? value, sign: null, count: null, reason: null })),
      onChange: values => write({ ...query, authors: [...values] }),
      onOpenChange: setAuthorsOpen,
      aside: <ContributorFilter active={paneActive && authorsOpen} selectedHandles={query.authors} onAdd={item => {
        remember(item);
        if (!query.authors.includes(item.handle)) write({ ...query, authors: [...query.authors, item.handle] });
      }} />,
    },
  ];
  if (query.roles.length > 0) dimensions.push({
    kind: "Many", id: "roles", label: "role", rest: "any role", values: query.roles,
    options: query.roles.map(value => {
      // justify-type-assertion: the shared role vocabulary guards its matching wire role union.
      const label = CONTRIBUTOR_ROLES.has(value) ? contributorRoleLabel(value as ContributorCredit["role"], 2).toLowerCase() : value;
      return { value, label, sign: null, count: null, reason: null };
    }),
    onChange: values => write({ ...query, roles: [...values] }),
  });
  if (query.scope !== "all") dimensions.push({
    kind: "One", id: "scope", label: "scope", rest: "everywhere", value: query.scope,
    options: [{ value: query.scope, label: query.scope, sign: null, count: null, reason: null }],
    onChange: value => write({ ...query, scope: value ?? "all" }),
  });
  return {
    words: {
      label: "search your nexus", value: draft, applied: query.text, input: inputRef,
      onChange: value => { caret.current = inputRef.current?.selectionStart ?? null; setDraft(value); },
      onClear: clearText, standing: true, onSubmit: null, rows: null, notice: null, verbs: [],
      field: {
        onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false),
        "aria-keyshortcuts": "Enter Escape",
        onKeyDown: event => {
          if (event.key === "Enter" && !event.repeat && !composing && !event.nativeEvent.isComposing) apply(true);
        },
      },
    },
    dimensions, order: null,
    reset: query.requestedKinds !== null || query.formats.length + query.authors.length + query.roles.length > 0 || query.scope !== "all" ? () => {
      caret.current = null;
      setDraft("");
      write({ ...emptySearchQuery(), view: query.view });
    } : null,
  };
}
