"use client";

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  nexusEntryKeyValue,
  type NexusAction,
  type NexusEntry,
  type NexusEntryKey,
  type NexusGroup,
  type NexusProjection,
  type NexusTargetActivation,
} from "@/lib/nexus/model";
import {
  beginNexusPerformance,
  completeNexusPerformance,
  completeNexusPerformanceAfterPaint,
  NEXUS_LOCAL_FIND_PERFORMANCE,
  NEXUS_OPEN_PERFORMANCE,
  NEXUS_OPENABLES_PERFORMANCE,
} from "@/lib/nexus/performance";
import SwitchboardRow from "./SwitchboardRow";
import styles from "./switchboard.module.css";

export type MobileNexusFailureSource = "Openables" | "Owned";

export interface MobileNexusActionsRequest {
  readonly requestId: number;
  readonly entry: NexusEntry;
}

function failureCopy(source: MobileNexusFailureSource): string {
  switch (source) {
    case "Openables":
      return "Couldn’t search your resources.";
    case "Owned":
      return "Couldn’t search inside your library.";
    default: {
      const exhaustive: never = source;
      throw new Error(
        `Unhandled mobile Nexus failure source: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function groupClassName(group: NexusGroup): string {
  switch (group.layout) {
    case "Flow":
      return styles.rows;
    case "CompactRail":
    case "PinnedBelowInput":
      return styles.compactRail;
    default: {
      const exhaustive: never = group.layout;
      throw new Error(
        `Unhandled mobile Nexus group layout: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export default function SwitchboardSearch({
  active,
  focusKey,
  query,
  projection,
  accountMenu,
  failures,
  busy,
  pending,
  announcement,
  actionsRequest,
  onDone,
  onQuery,
  onActive,
  onActivate,
  onEntryActions,
  onEscapeRoot,
  onUnavailable,
  onRetry,
}: {
  active: boolean;
  focusKey: unknown;
  query: string;
  projection: NexusProjection;
  accountMenu: ReactNode;
  failures: ReadonlySet<MobileNexusFailureSource>;
  busy: boolean;
  pending: boolean;
  announcement: string;
  actionsRequest: MobileNexusActionsRequest | null;
  onDone(): void;
  onQuery(query: string): void;
  onActive(key: NexusEntryKey): void;
  onActivate(
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement,
    entry: NexusEntry,
  ): void;
  onEntryActions(entry: MobileNexusActionsRequest["entry"]): void;
  onEscapeRoot(): void;
  onUnavailable(reason: string): void;
  onRetry(source: MobileNexusFailureSource): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const handledActionsRequestRef = useRef<number | null>(null);
  const pinnedGroups = projection.groups.filter(
    (group) => group.layout === "PinnedBelowInput",
  );
  const scrollingGroups = projection.groups.filter(
    (group) => group.layout !== "PinnedBelowInput",
  );
  const visibleResultCount = scrollingGroups.reduce(
    (count, group) => count + group.entries.length,
    0,
  );
  const typed = query.trim().length > 0;
  const orderedEntries = projection.groups.flatMap((group) => group.entries);
  const activeKeyValue =
    projection.activeKey === null
      ? null
      : nexusEntryKeyValue(projection.activeKey);
  const activeIndex =
    activeKeyValue === null
      ? -1
      : orderedEntries.findIndex(
          (entry) => nexusEntryKeyValue(entry.key) === activeKeyValue,
        );
  const activeEntry = activeIndex < 0 ? null : orderedEntries[activeIndex] ?? null;

  useLayoutEffect(() => {
    if (!active) return;
    inputRef.current?.focus({ preventScroll: true });
    completeNexusPerformanceAfterPaint(NEXUS_OPEN_PERFORMANCE);
  }, [active, focusKey]);

  useLayoutEffect(() => {
    completeNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
    completeNexusPerformance(NEXUS_OPENABLES_PERFORMANCE);
  }, [projection.groups, query]);

  useLayoutEffect(() => {
    if (
      !active ||
      actionsRequest === null ||
      handledActionsRequestRef.current === actionsRequest.requestId
    ) {
      return;
    }
    handledActionsRequestRef.current = actionsRequest.requestId;
    onEntryActions(actionsRequest.entry);
  }, [actionsRequest, active, onEntryActions]);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.key === "Process"
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscapeRoot();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (orderedEntries.length === 0) return;
      event.preventDefault();
      const nextIndex =
        event.key === "ArrowDown"
          ? activeIndex < 0
            ? 0
            : (activeIndex + 1) % orderedEntries.length
          : activeIndex < 0
            ? orderedEntries.length - 1
            : (activeIndex - 1 + orderedEntries.length) %
              orderedEntries.length;
      onActive(orderedEntries[nextIndex]!.key);
      return;
    }
    if (event.key !== "Enter" || activeIndex < 0) return;
    const entry = orderedEntries[activeIndex];
    if (!entry) return;
    event.preventDefault();
    if (entry.primaryAction.availability.kind === "Unavailable") {
      onUnavailable(entry.primaryAction.availability.reason);
      return;
    }
    onActivate(
      entry.primaryAction,
      {
        disposition: { kind: event.shiftKey ? "Fork" : "Follow" },
        modality: "Keyboard",
      },
      event.currentTarget,
      entry,
    );
  };

  const renderGroup = (group: NexusGroup) => (
    <section
      key={group.id}
      className={
        group.layout === "PinnedBelowInput"
          ? styles.pinnedGroup
          : styles.section
      }
      aria-labelledby={`mobile-nexus-group-${group.id}`}
    >
      <h3 id={`mobile-nexus-group-${group.id}`}>{group.label}</h3>
      <ul className={groupClassName(group)}>
        {group.entries.map((entry) => {
          const entryKey = nexusEntryKeyValue(entry.key);
          return (
            <SwitchboardRow
              key={entryKey}
              entry={entry}
              active={
                projection.activeKey !== null &&
                nexusEntryKeyValue(projection.activeKey) === entryKey
              }
              compact={group.layout !== "Flow"}
              onActive={() => onActive(entry.key)}
              onActivate={onActivate}
              onUnavailable={onUnavailable}
            />
          );
        })}
      </ul>
    </section>
  );

  return (
    <div
      className={`${styles.page} ${styles.searchPage}`}
      data-switchboard-ready="Root"
    >
      <header className={styles.header}>
        <h2 tabIndex={-1} data-switchboard-heading>
          Nexus
        </h2>
        <div className={styles.headerActions}>
          {accountMenu}
          <button type="button" className={styles.textButton} onClick={onDone}>
            Done
          </button>
        </div>
      </header>

      <label className={styles.searchInput}>
        <span className={styles.srOnly}>Find anything…</span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Find anything…"
          autoComplete="off"
          enterKeyHint="search"
          data-mobile-nexus-search
          onChange={(event) => {
            beginNexusPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
            onQuery(event.currentTarget.value);
          }}
          onKeyDown={onSearchKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
      </label>

      {pinnedGroups.map(renderGroup)}

      <div
        className={styles.searchScroll}
        data-testid="switchboard-search-scroll"
        aria-busy={busy || undefined}
      >
        {failures.size > 0 ? (
          <div className={styles.sourceStatus} aria-live="polite">
            {Array.from(failures).map((source) => (
              <p key={source}>
                {failureCopy(source)}{" "}
                <button type="button" onClick={() => onRetry(source)}>
                  Retry
                </button>
              </p>
            ))}
          </div>
        ) : null}

        {scrollingGroups.map(renderGroup)}

        {typed && visibleResultCount === 0 && !pending ? (
          <p className={styles.empty}>No results for “{query.trim()}”</p>
        ) : null}
      </div>

      <div
        className={styles.liveRegion}
        role="status"
        aria-label="Nexus status"
      aria-live="polite"
      >
        {announcement ||
          [
            activeEntry
              ? `${activeEntry.label}. ${activeIndex + 1} of ${orderedEntries.length}.`
              : null,
            busy
              ? "Searching…"
              : typed
                ? `${visibleResultCount} ${visibleResultCount === 1 ? "result" : "results"}`
                : null,
          ]
            .filter(Boolean)
            .join(" ")}
      </div>
    </div>
  );
}
