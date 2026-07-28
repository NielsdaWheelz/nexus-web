"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Loader2, Lock, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import LibraryColorDot from "@/components/LibraryColorDot";
import styles from "./LibraryChooser.module.css";

export type LibraryChooserItemInteraction =
  | { kind: "Enabled" }
  | { kind: "Pending" }
  | { kind: "ReadOnly"; reason: string };

export interface LibraryChooserItem {
  id: string;
  name: string;
  color: string | null;
  selected: boolean;
  interaction: LibraryChooserItemInteraction;
}

export interface LibraryChooserGroup {
  label: string;
  items: readonly LibraryChooserItem[];
}

export interface LibraryChooserProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;
  searchLabel: string;
  listLabel: string;

  selectedGroup: LibraryChooserGroup;
  otherGroup: LibraryChooserGroup;

  onToggle: (id: string) => void;

  /** A mutation (create) or placement command/reconcile is in flight: disable every toggle. */
  busy: boolean;
  /** A read (search / Load More / reconcile GET) is in flight: mark the listbox busy without disabling toggles. */
  loading: boolean;
  status: string;
  emptyState: string | null;
  error: { message: string; onRetry: (() => void) | null } | null;
  create: { name: string; pending: boolean; onCreate: () => void } | null;
  loadMore: { pending: boolean; onLoadMore: () => void } | null;
}

type Actionable =
  | { kind: "Library"; optionId: string; item: LibraryChooserItem }
  | { kind: "Create"; optionId: string }
  | { kind: "LoadMore"; optionId: string };

const READ_ONLY_SHORT = "Read only";
const LOAD_MORE_IDLE = "Load more libraries";
const LOAD_MORE_LOADING = "Loading more libraries…";
const RETRY_LABEL = "Retry";

export default function LibraryChooser({
  query,
  onQueryChange,
  searchPlaceholder,
  searchLabel,
  listLabel,
  selectedGroup,
  otherGroup,
  onToggle,
  busy,
  loading,
  status,
  emptyState,
  error,
  create,
  loadMore,
}: LibraryChooserProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const statusId = `${baseId}-status`;
  const selectedHeaderId = `${baseId}-selected-header`;
  const otherHeaderId = `${baseId}-other-header`;
  const optionDomId = (rowId: string) => `${baseId}-option-${rowId}`;
  const composingRef = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const hasCreate = create !== null;
  const hasLoadMore = loadMore !== null;
  const actionables = useMemo<Actionable[]>(() => {
    const list: Actionable[] = [];
    for (const item of selectedGroup.items) {
      list.push({ kind: "Library", optionId: `${baseId}-option-${item.id}`, item });
    }
    for (const item of otherGroup.items) {
      list.push({ kind: "Library", optionId: `${baseId}-option-${item.id}`, item });
    }
    if (hasCreate) list.push({ kind: "Create", optionId: `${baseId}-option-create` });
    if (hasLoadMore) {
      list.push({ kind: "LoadMore", optionId: `${baseId}-option-load-more` });
    }
    return list;
  }, [baseId, selectedGroup.items, otherGroup.items, hasCreate, hasLoadMore]);

  useEffect(() => {
    if (actionables.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId === null || !actionables.some((a) => a.optionId === activeId)) {
      setActiveId(actionables[0]!.optionId);
    }
  }, [actionables, activeId]);

  const activeDescendant =
    activeId !== null && actionables.some((a) => a.optionId === activeId)
      ? activeId
      : undefined;

  function activate(optionId: string) {
    const target = actionables.find((a) => a.optionId === optionId);
    if (!target) return;
    switch (target.kind) {
      case "Library": {
        if (busy || target.item.interaction.kind !== "Enabled") return;
        onToggle(target.item.id);
        return;
      }
      case "Create": {
        if (create === null || busy || create.pending) return;
        create.onCreate();
        return;
      }
      case "LoadMore": {
        if (loadMore === null || busy || loadMore.pending) return;
        loadMore.onLoadMore();
        return;
      }
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;
    // Escape stays browser-/surface-owned: do not preventDefault or stopPropagation.
    if (event.key === "Escape") return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (actionables.length === 0) return;
      const current = actionables.findIndex((a) => a.optionId === activeId);
      const start = current >= 0 ? current : 0;
      const last = actionables.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveId(actionables[next]!.optionId);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const optionId = activeId ?? actionables[0]?.optionId ?? null;
      if (optionId !== null) activate(optionId);
    }
    // Every other key stays browser-owned.
  }

  function renderTrailing(item: LibraryChooserItem) {
    if (item.interaction.kind === "Pending") {
      return (
        <span className={styles.spinner}>
          <Loader2 size={16} aria-hidden="true" />
        </span>
      );
    }
    if (item.interaction.kind === "ReadOnly") {
      return (
        <span className={styles.readOnly}>
          <Lock size={16} aria-hidden="true" />
          <span>{READ_ONLY_SHORT}</span>
          <span className={styles.srOnly}>{item.interaction.reason}</span>
        </span>
      );
    }
    if (item.selected) {
      return (
        <span className={styles.check}>
          <Check size={16} aria-hidden="true" />
        </span>
      );
    }
    return null;
  }

  function renderOption(item: LibraryChooserItem) {
    const optionId = optionDomId(item.id);
    const readOnly = item.interaction.kind === "ReadOnly";
    const pending = item.interaction.kind === "Pending";
    return (
      <div
        key={item.id}
        id={optionId}
        role="option"
        aria-selected={item.selected}
        aria-disabled={readOnly || undefined}
        aria-busy={pending || undefined}
        className={styles.option}
        data-active={optionId === activeId || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActiveId(optionId)}
        onClick={() => activate(optionId)}
      >
        <span className={styles.dotSlot}>
          <LibraryColorDot color={item.color} size="sm" />
        </span>
        <span className={styles.optionName}>{item.name}</span>
        {renderTrailing(item)}
      </div>
    );
  }

  function renderGroup(group: LibraryChooserGroup, headerId: string) {
    if (group.items.length === 0) return null;
    return (
      <div role="group" aria-labelledby={headerId} className={styles.group}>
        <div id={headerId} className={styles.groupHeader}>
          {group.label}
        </div>
        {group.items.map(renderOption)}
      </div>
    );
  }

  const showEmptyState =
    emptyState !== null &&
    error === null &&
    create === null &&
    selectedGroup.items.length === 0 &&
    otherGroup.items.length === 0;

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          variant="bare"
          className={styles.search}
          role="combobox"
          aria-label={searchLabel}
          aria-controls={listboxId}
          aria-expanded={true}
          aria-activedescendant={activeDescendant}
          aria-describedby={statusId}
          aria-autocomplete="list"
          value={query}
          placeholder={searchPlaceholder}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onQueryChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={statusId} role="status" className={styles.srOnly}>
        {status}
      </div>
      {error !== null ? (
        <div role="alert" className={styles.errorRow}>
          <span className={styles.errorText}>{error.message}</span>
          {error.onRetry !== null ? (
            <Button variant="secondary" size="sm" onClick={error.onRetry}>
              {RETRY_LABEL}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        id={listboxId}
        role="listbox"
        aria-label={listLabel}
        aria-multiselectable="true"
        aria-busy={busy || loading || undefined}
        className={styles.list}
      >
        {renderGroup(selectedGroup, selectedHeaderId)}
        {renderGroup(otherGroup, otherHeaderId)}
        {create !== null ? (
          <div
            id={optionDomId("create")}
            role="option"
            aria-selected={false}
            aria-busy={create.pending || undefined}
            className={`${styles.actionRow} ${styles.createRow}`}
            data-active={optionDomId("create") === activeId || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActiveId(optionDomId("create"))}
            onClick={() => activate(optionDomId("create"))}
          >
            {create.pending ? (
              <span className={styles.spinner}>
                <Loader2 size={16} aria-hidden="true" />
              </span>
            ) : (
              <Plus size={16} aria-hidden="true" />
            )}
            <span className={styles.optionName}>Create “{create.name}”</span>
          </div>
        ) : null}
        {loadMore !== null ? (
          <div
            id={optionDomId("load-more")}
            role="option"
            aria-selected={false}
            aria-busy={loadMore.pending || undefined}
            className={`${styles.actionRow} ${styles.loadMoreRow}`}
            data-active={optionDomId("load-more") === activeId || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActiveId(optionDomId("load-more"))}
            onClick={() => activate(optionDomId("load-more"))}
          >
            {loadMore.pending ? (
              <span className={styles.spinner}>
                <Loader2 size={16} aria-hidden="true" />
              </span>
            ) : (
              <Plus size={16} aria-hidden="true" />
            )}
            <span className={styles.optionName}>
              {loadMore.pending ? LOAD_MORE_LOADING : LOAD_MORE_IDLE}
            </span>
          </div>
        ) : null}
        {showEmptyState ? (
          <div className={styles.empty}>{emptyState}</div>
        ) : null}
      </div>
    </div>
  );
}
