"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { AsyncResource } from "@/lib/api/useResource";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import { resourceIconForScheme, resourceTypeLabel } from "@/lib/resources/resourceKind";
import { searchResourceTargets, type ResourceTarget } from "@/lib/resources/resourceTargets";
import { parseSnippetSegments } from "@/lib/search/searchViewModel";
import {
  targetLabel,
  toLinkTarget,
  type LinkTarget,
} from "@/lib/resourceGraph/links";
import {
  FeedbackNotice,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import styles from "./LinkTargetDialog.module.css";

export interface LinkTargetDialogProps {
  open: boolean;
  sourceLabel: string;
  /** An existing durable Link source, for already-linked dedupe. Omitted for a
   * fresh selection that has no Highlight yet. */
  sourceRef?: string;
  excludeRefs?: readonly string[];
  /** True while the caller's `createLink` is in flight — the dialog goes busy
   * and blocks a second pick. */
  busy?: boolean;
  /** A create failure remains in this open Link surface with exact Retry. */
  failure?: {
    content: FeedbackContent;
    actions: FeedbackActions;
  } | null;
  /**
   * Fires with the picked target's ref, mapped straight onto the `Link`
   * mutation's own `LinkTarget` shape, plus the picked row's display `label`
   * (the confirmation toast names the target the user chose — the server
   * response can't, since a canonically-reordered pair loses which endpoint was
   * the target). This dialog performs zero writes — the caller (a Link
   * composer) owns the actual `createLink` call.
   */
  onPick: (target: LinkTarget, label: string) => void;
  onClose: () => void;
  /** Where focus returns on close, when the opener is gone by then (a menu item). */
  returnFocusTo?: ReturnFocusTarget;
}

/** Stable row identity: the item's own ref for a resource target, its
 * transient candidate ref for a passage target. */
function resourceTargetKey(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.ref : target.candidateRef;
}

function resourceTargetOptionId(listboxId: string, target: ResourceTarget): string {
  return `${listboxId}-option-${resourceTargetKey(target)}`;
}

/** Debounced first page plus cursor continuation for one target query. */
function useResourceTargetSearch(args: {
  query: string;
  sourceRef?: string;
  excludeRefs?: readonly string[];
}) {
  const { query, sourceRef, excludeRefs } = args;
  const trimmed = query.trim();
  const identity = trimmed.length === 0
    ? null
    : JSON.stringify([trimmed, sourceRef ?? null, excludeRefs ?? []]);
  const [retryTick, setRetryTick] = useState(0);
  const retryFirst = useCallback(() => setRetryTick((value) => value + 1), []);
  const first = useDebouncedFetch(
    identity === null ? null : `${identity}:${retryTick}`,
    (signal) => searchResourceTargets({ q: trimmed, sourceRef, excludeRefs }, signal),
    { debounceMs: 200, identity },
  );
  const firstPage = useMemo<AsyncResource<CursorPage<ResourceTarget>>>(() => {
    if (identity === null) return { status: "idle" };
    if (first.dataIdentity === identity && first.data !== null) {
      return { status: "ready", data: {
        items: first.data.targets,
        nextCursor: first.data.nextCursor === null ? absent() : present(first.data.nextCursor),
      } };
    }
    if (first.errorIdentity === identity && first.error !== null) {
      if (!isApiError(first.error) || isSameSystemApiDefect(first.error)) throw first.error;
      return { status: "error", error: first.error, retry: retryFirst };
    }
    return { status: "loading" };
  }, [first.data, first.dataIdentity, first.error, first.errorIdentity, identity, retryFirst]);
  const page = useCursorPagination({
    firstPage,
    initialMoreError: null,
    loadMorePage: async (cursor, signal) => {
      const result = await searchResourceTargets({
        q: trimmed, sourceRef, excludeRefs, cursor,
      }, signal);
      return { items: result.targets, nextCursor: result.nextCursor === null ? absent() : present(result.nextCursor) };
    },
  });
  return {
    targets: page.items,
    loading: identity !== null && page.status === "loading",
    error: page.error,
    hasMore: page.hasMore,
    loadingMore: page.loadingMore,
    loadMore: page.loadMore,
    retry: page.retry,
  };
}

/**
 * The shared modal for choosing a link target: target search and its result
 * listbox in a `useDialogOverlay`-governed overlay (focus trap, body-scroll
 * lock, return focus, Escape). The input is the combobox host; it owns
 * keyboard handling and `aria-activedescendant`.
 */
export default function LinkTargetDialog({
  open,
  sourceLabel,
  sourceRef,
  excludeRefs,
  busy = false,
  failure,
  onPick,
  onClose,
  returnFocusTo,
}: LinkTargetDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listboxId = `link-targets-${useId().replaceAll(":", "")}`;

  const { targets, loading, error, hasMore, loadingMore, loadMore, retry } = useResourceTargetSearch({
    query: open ? query : "",
    sourceRef,
    excludeRefs,
  });

  // Derived during render (never via an effect) so an in-flight Arrow move
  // can't be clobbered by a stale "initialize" effect: an explicit `activeKey`
  // wins while it still names a live target, otherwise the first target is
  // active by default.
  const effectiveActiveKey =
    activeKey && targets.some((target) => resourceTargetKey(target) === activeKey)
      ? activeKey
      : (targets[0] ? resourceTargetKey(targets[0]) : null);

  useDialogOverlay({
    ref: panelRef,
    active: open,
    onDismiss: onClose,
    initialFocus: () => inputRef.current,
    returnFocusTo,
  });

  if (!open) return null;

  function pick(target: ResourceTarget | undefined) {
    if (!target || busy) return;
    onPick(toLinkTarget(target), targetLabel(target));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      if (targets.length === 0) return;
      const current = targets.findIndex((target) => resourceTargetKey(target) === effectiveActiveKey);
      const start = current >= 0 ? current : 0;
      const last = targets.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveKey(resourceTargetKey(targets[next]!));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(targets.find((target) => resourceTargetKey(target) === effectiveActiveKey) ?? targets[0]);
    }
  }

  return createPortal(
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Link ${sourceLabel}`}
        aria-busy={busy || undefined}
        data-busy={busy || undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <span>Link {sourceLabel}</span>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        {busy ? <p role="status">Linking… Closing keeps the submitted request running.</p> : null}
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          disabled={busy}
          aria-activedescendant={
            effectiveActiveKey
              ? resourceTargetOptionId(
                  listboxId,
                  targets.find((target) => resourceTargetKey(target) === effectiveActiveKey)!,
                )
              : undefined
          }
          placeholder="Search items and passages"
          aria-label="Search items and passages"
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
          {loading ? <div className={styles.status}>Searching…</div> : null}
          {!loading && error ? (
            <div className={styles.errorRow}>
              <span className={styles.errorText}>Couldn&rsquo;t load results</span>
            </div>
          ) : null}
          {!loading && !error && targets.length === 0 ? (
            <div className={styles.status}>
              {query.trim().length === 0 ? "Type to search" : "No matches"}
            </div>
          ) : null}
          {targets.map((target) => {
            const key = resourceTargetKey(target);
            const active = key === effectiveActiveKey;
            const scheme = target.kind === "resource" ? target.item.scheme : target.source.scheme;
            const label = target.kind === "resource" ? target.item.label : target.label;
            const Icon = resourceIconForScheme(scheme);
            const segments = target.kind === "passage" ? parseSnippetSegments(target.excerpt) : [];
            return (
              <div
                key={key}
                id={resourceTargetOptionId(listboxId, target)}
                role="option"
                aria-selected={active}
                className={styles.option}
                data-active={active || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (busy) return;
                  setActiveKey(key);
                }}
                onClick={() => pick(target)}
              >
                <Icon size={16} aria-hidden="true" className={styles.icon} />
                <span className={styles.body}>
                  <span className={styles.label} dir="auto">
                    {label}
                  </span>
                  <span className={styles.meta}>{target.kind === "passage" ? "Passage" : resourceTypeLabel(target.item.scheme)}</span>
                  {target.kind === "passage" ? (
                    <span className={styles.meta} dir="auto">
                      <span>{target.source.label}</span>
                      {segments.length > 0 ? " · " : null}
                      <EmphasisSegments segments={segments} />
                    </span>
                  ) : target.item.summary ? (
                    <span className={styles.meta} dir="auto">
                      {target.item.summary}
                    </span>
                  ) : null}
                </span>
                {target.existingLinkId ? <span className={styles.linkedBadge}>Linked</span> : null}
              </div>
            );
          })}
        </div>
        <div role="status" aria-live="polite">
          {loadingMore ? "Loading more results…" : null}
        </div>
        {error ? (
          <Button variant="ghost" size="sm" onClick={retry}>Retry search</Button>
        ) : hasMore ? (
          <Button variant="ghost" size="sm" disabled={busy || loadingMore} onClick={loadMore}>Load more</Button>
        ) : null}
        {failure ? (
          <FeedbackNotice
            content={failure.content}
            announcement="Assertive"
            actions={failure.actions}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
