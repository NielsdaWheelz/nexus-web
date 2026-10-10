"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import {
  useCursorPagination,
  type CursorPage,
} from "@/lib/api/useCursorPagination";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { AsyncResource } from "@/lib/api/useResource";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  resourceIconForScheme,
  resourceTypeLabel,
} from "@/lib/resourceGraph/resourceRef";
import type { LinkComposer } from "@/lib/resourceGraph/useLinkComposer";
import { parseSnippetSegments } from "@/lib/search/searchViewModel";
import styles from "./LinkTargetDialog.module.css";

type Target =
  | Schema<"ResourceTargetResourceOut">
  | Schema<"ResourceTargetPassageOut">;

/** A row's identity: the item's ref, or a passage's transient candidate ref. */
const keyOf = (target: Target) =>
  target.kind === "resource" ? target.item.ref : target.candidateRef;

/** One page of visible items and passage candidates; the source is never offered. */
async function searchTargets(
  q: string,
  sourceRef: string | undefined,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<CursorPage<Target>> {
  const { data } = await apiFetch<
    ApiJson<"/resource-items/targets/search", "post">
  >("/api/resource-items/targets/search", {
    method: "POST",
    signal,
    body: JSON.stringify({
      q,
      source_ref: sourceRef,
      exclude_refs: sourceRef ? [sourceRef] : [],
      cursor,
    }),
  });
  return {
    items: data.targets,
    nextCursor: data.nextCursor === null ? absent() : present(data.nextCursor),
  };
}

/** Debounced first page plus cursor continuation for one query. */
function useTargetSearch(query: string, sourceRef: string | undefined) {
  const q = query.trim();
  const identity = q ? JSON.stringify([q, sourceRef ?? null]) : null;
  const [tick, setTick] = useState(0);
  const retryFirst = useCallback(() => setTick((n) => n + 1), []);
  const { data, dataIdentity, error, errorIdentity } = useDebouncedFetch(
    identity === null ? null : `${identity}:${tick}`,
    (signal) => searchTargets(q, sourceRef, undefined, signal),
    { debounceMs: 200, identity },
  );
  const firstPage = useMemo<AsyncResource<CursorPage<Target>>>(() => {
    if (identity === null) return { status: "idle" };
    if (dataIdentity === identity && data !== null) {
      return { status: "ready", data };
    }
    if (errorIdentity !== identity || error === null) {
      return { status: "loading" };
    }
    if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
    return { status: "error", error, retry: retryFirst };
  }, [data, dataIdentity, error, errorIdentity, identity, retryFirst]);
  const more = useCursorPagination({
    firstPage,
    initialMoreError: null,
    loadMorePage: (cursor, signal) =>
      searchTargets(q, sourceRef, cursor, signal),
  });
  return { ...more, loading: identity !== null && more.status === "loading" };
}

/**
 * The link picker: a combobox over target search results, in the shared Dialog. It
 * writes nothing; the composer owns the pick, the in-flight save and its failure.
 */
export default function LinkTargetDialog({
  composer,
}: {
  composer: LinkComposer;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listboxId = `link-targets-${useId().replaceAll(":", "")}`;
  const busy = composer.committing;
  const search = useTargetSearch(query, composer.sourceRef);
  const targets = search.items;
  // Derived in render: an explicit choice wins while it names a live row, else the first.
  const active = targets.find((t) => keyOf(t) === activeKey) ?? targets[0];
  const optionId = (target: Target) => `${listboxId}-option-${keyOf(target)}`;

  function pick(target: Target | undefined) {
    if (!target || busy) return;
    if (target.kind === "resource") {
      void composer.confirm(
        { kind: "resource", ref: target.item.ref },
        target.item.label,
      );
    } else {
      void composer.confirm(
        { kind: "passage", candidate_ref: target.candidateRef },
        target.label,
      );
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const index = active ? targets.indexOf(active) : 0;
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: targets.length - 1,
    };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(targets.length - 1, moves[event.key]));
      if (targets[next]) setActiveKey(keyOf(targets[next]));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(active);
    }
  }

  return (
    <Dialog
      open={composer.open}
      onClose={composer.close}
      title={`Link ${composer.sourceLabel}`}
      initialFocus={() => inputRef.current}
    >
      {busy ? (
        <p role="status">
          Linking… Closing keeps the submitted request running.
        </p>
      ) : null}
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        role="combobox"
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        aria-label="Search items and passages"
        placeholder="Search items and passages"
        disabled={busy}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div
        id={listboxId}
        role="listbox"
        aria-label="Link targets"
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
        className={styles.list}
      >
        {search.loading ? (
          <div className={styles.status}>Searching…</div>
        ) : null}
        {!search.loading && search.error ? (
          <div className={styles.status}>Couldn&rsquo;t load results</div>
        ) : null}
        {!search.loading && !search.error && targets.length === 0 ? (
          <div className={styles.status}>
            {query.trim() ? "No matches" : "Type to search"}
          </div>
        ) : null}
        {targets.map((target) => {
          const key = keyOf(target);
          const Icon = resourceIconForScheme(
            target.kind === "resource"
              ? target.item.scheme
              : target.source.scheme,
          );
          const segments =
            target.kind === "passage"
              ? parseSnippetSegments(target.excerpt)
              : [];
          return (
            <div
              key={key}
              id={optionId(target)}
              role="option"
              aria-selected={target === active}
              data-active={target === active || undefined}
              className={styles.option}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (!busy) setActiveKey(key);
              }}
              onClick={() => pick(target)}
            >
              <Icon size={16} aria-hidden="true" className={styles.icon} />
              {target.kind === "resource" ? (
                <span className={styles.body}>
                  <span className={styles.label} dir="auto">
                    {target.item.label}
                  </span>
                  <span className={styles.meta}>
                    {resourceTypeLabel(target.item.scheme)}
                  </span>
                  {target.item.summary ? (
                    <span className={styles.meta} dir="auto">
                      {target.item.summary}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className={styles.body}>
                  <span className={styles.label} dir="auto">
                    {target.label}
                  </span>
                  <span className={styles.meta}>Passage</span>
                  <span className={styles.meta} dir="auto">
                    {target.source.label}
                    {segments.length > 0 ? " · " : null}
                    <EmphasisSegments segments={segments} />
                  </span>
                </span>
              )}
              {target.existingLinkId ? (
                <span className={styles.linkedBadge}>Linked</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div role="status" aria-live="polite">
        {search.loadingMore ? "Loading more results…" : null}
      </div>
      {search.error ? (
        <Button variant="ghost" size="sm" onClick={search.retry}>
          Retry search
        </Button>
      ) : (
        <LoadMoreFooter
          hasMore={search.hasMore}
          loading={search.loadingMore}
          disabled={busy}
          onLoadMore={search.loadMore}
        />
      )}
      {composer.failure ? (
        <FeedbackNotice
          content={composer.failure.content}
          announcement="Assertive"
          actions={composer.failure.actions}
        />
      ) : null}
    </Dialog>
  );
}
