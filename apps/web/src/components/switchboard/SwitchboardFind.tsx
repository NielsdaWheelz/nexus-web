"use client";

import { ArrowLeft, CopyPlus, RotateCw } from "lucide-react";
import { useLayoutEffect } from "react";
import type {
  SwitchboardFindScope,
  SwitchboardItem,
  SwitchboardRowModel,
} from "@/lib/switchboard/model";
import { SWITCHBOARD_FIND_SCOPES } from "@/lib/switchboard/model";
import type { LauncherAction } from "@/lib/launcher/model";
import {
  beginSwitchboardPerformance,
  completeSwitchboardPerformance,
  NEXUS_LOCAL_FIND_PERFORMANCE,
} from "@/lib/switchboard/performance";
import SwitchboardRow from "./SwitchboardRow";
import styles from "./switchboard.module.css";

export default function SwitchboardFind({
  query,
  scope,
  rows,
  activeId,
  busy,
  openablesFailed,
  deepFailed,
  onBack,
  onQuery,
  onScope,
  onActive,
  onSelect,
  onFork,
  actionsFor,
  onAction,
  onRetryOpenables,
  onRetryDeep,
}: {
  query: string;
  scope: SwitchboardFindScope;
  rows: readonly SwitchboardRowModel[];
  activeId: string | null;
  busy: boolean;
  openablesFailed: boolean;
  deepFailed: boolean;
  onBack: () => void;
  onQuery: (query: string) => void;
  onScope: (scope: SwitchboardFindScope) => void;
  onActive: (id: string) => void;
  onSelect: (row: SwitchboardRowModel) => void;
  onFork: (row: SwitchboardRowModel) => void;
  actionsFor: (item: SwitchboardItem) => readonly LauncherAction[];
  onAction: (action: LauncherAction) => void;
  onRetryOpenables: () => void;
  onRetryDeep: () => void;
}) {
  const blank = query.trim().length === 0;
  useLayoutEffect(() => {
    completeSwitchboardPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
  }, [query, rows]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className={styles.srOnly}>Back</span>
        </button>
        <h2 tabIndex={-1} data-switchboard-heading>
          Find
        </h2>
      </header>

      <label className={styles.findInput}>
        <span className={styles.srOnly}>Find anything</span>
        <input
          type="search"
          value={query}
          placeholder="Find anything…"
          onChange={(event) => {
            beginSwitchboardPerformance(NEXUS_LOCAL_FIND_PERFORMANCE);
            onQuery(event.currentTarget.value);
          }}
        />
      </label>

      {!blank ? (
        <div className={styles.scopes} aria-label="Find scope">
          {SWITCHBOARD_FIND_SCOPES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === scope}
              onClick={() => onScope(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.sourceStatus}>
        {openablesFailed ? (
          <p>
            Couldn’t search your resources.{" "}
            <button type="button" onClick={onRetryOpenables}>
              <RotateCw size={14} aria-hidden="true" /> Retry
            </button>
          </p>
        ) : null}
        {deepFailed ? (
          <p>
            Couldn’t search inside content.{" "}
            <button type="button" onClick={onRetryDeep}>
              <RotateCw size={14} aria-hidden="true" /> Retry
            </button>
          </p>
        ) : null}
      </div>

      {!blank && rows.length === 0 && !busy ? (
        <p className={styles.empty}>No results for “{query.trim()}”</p>
      ) : null}
      <ul className={styles.rows} aria-label="Find results">
        {rows.map((row) => (
          <SwitchboardRow
            key={row.id}
            id={row.id}
            label={row.label}
            metadata={row.metadata}
            nested={Boolean(row.parentId)}
            current={row.id === activeId}
            performanceTargetId={
              row.item?.kind === "OpenPane" ||
              row.item?.kind === "Resource"
                ? row.item.activationRouteId
                : undefined
            }
            onFocus={row.item ? () => onActive(row.id) : undefined}
            onSelect={row.item ? () => onSelect(row) : undefined}
            actions={row.item
              ? [
                  ...actionsFor(row.item).map((action) => {
                    const Icon = action.icon;
                    return {
                      kind: "command" as const,
                      id: action.id,
                      label: action.label,
                      icon: <Icon size={16} aria-hidden="true" />,
                      onSelect: () => onAction(action),
                    };
                  }),
                  {
                    kind: "command",
                    id: `fork-${row.id}`,
                    label: "Open another tab",
                    icon: <CopyPlus size={16} aria-hidden="true" />,
                    onSelect: () => onFork(row),
                  },
                ]
              : []}
          />
        ))}
      </ul>
      <div className={styles.liveRegion} aria-live="polite">
        {busy
          ? "Searching…"
          : openablesFailed || deepFailed
            ? `Search finished with ${
                openablesFailed && deepFailed ? "2 source failures" : "1 source failure"
              }. ${rows.length} ${rows.length === 1 ? "result" : "results"}.`
            : !blank
              ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
              : ""}
      </div>
    </div>
  );
}
