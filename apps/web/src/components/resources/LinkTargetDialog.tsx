"use client";

import { useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import ResourceBody from "./ResourceBody";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import { useSettled } from "@/lib/api/serverState";
import { usePaneFreeServerList, type ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  resourceIconForScheme,
  parseResourceRef,
  resourceTypeLabel,
} from "@/lib/resourceGraph/resourceRef";
import type { LinkComposer } from "@/lib/resourceGraph/useLinkComposer";
import styles from "./LinkTargetDialog.module.css";

type Target =
  | Schema<"ResourceTargetResourceOut">
  | Schema<"ResourceTargetPassageOut">;

/** A row's identity: the item's ref, or a passage's transient candidate ref. */
const keyOf = (target: Target) =>
  target.kind === "resource" ? target.item.ref : target.candidate_ref;

/** One page of visible items and passage candidates; the source is never offered. */
async function searchTargets(
  q: string,
  sourceRef: string | undefined,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ListPage<Target>> {
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
    next_cursor: data.next_cursor,
  };
}

const NONE: readonly Target[] = [];

/** One query's pages, read once it has held still for 200 ms; shown only for it. */
function useTargetSearch(query: string, sourceRef: string | undefined) {
  const q = query.trim();
  const settled = useSettled(q, 200);
  const list = usePaneFreeServerList<Target>({
    key: settled ? JSON.stringify([settled, sourceRef ?? null]) : null,
    stale: "",
    // The server's page (pickers.py TARGET_PAGE): one read per settled query.
    pageSize: 10,
    drain: false,
    active: true,
    id: keyOf,
    fetchPage: (cursor, _limit, signal) =>
      searchTargets(settled, sourceRef, cursor, signal),
  });
  const live = q !== "" && settled === q;
  const ready = live && list.current;
  const failure = live ? list.failure : null;
  return {
    items: ready ? list.items : NONE,
    loading: q !== "" && !ready && failure === null,
    error: failure?.error ?? null,
    hasMore: ready && !list.complete,
    loadingMore: list.running === "More",
    loadMore: list.more,
    retry: list.retry,
  };
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
        { kind: "passage", candidate_ref: target.candidate_ref },
        target.item.label,
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
          const scheme = parseResourceRef(target.item.ref)!.scheme;
          const Icon = resourceIconForScheme(scheme);
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
              <div className={styles.body}>
                <ResourceBody body={target.item.preview.body} />
                <span className={styles.meta}>{resourceTypeLabel(scheme)}{target.item.preview.source?.title ? ` · ${target.item.preview.source.title}` : ""}</span>
              </div>
              {target.existing_link_id ? (
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
