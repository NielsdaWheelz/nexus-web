"use client";

import { MoreHorizontal } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  beginSwitchboardPerformance,
  completeSwitchboardPerformanceAfterPaint,
  NEXUS_PANE_ACTIVATE_PERFORMANCE,
} from "@/lib/switchboard/performance";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import styles from "./switchboard.module.css";

export default function SwitchboardRow({
  id,
  label,
  metadata,
  current = false,
  nested = false,
  actions = [],
  performanceTargetId,
  onFocus,
  onSelect,
}: {
  id: string;
  label: string;
  metadata?: string;
  current?: boolean;
  nested?: boolean;
  actions?: readonly ActionDescriptor[];
  performanceTargetId?: string;
  onFocus?: () => void;
  onSelect?: () => void;
}) {
  const content = (
    <>
      <span className={styles.rowLabel}>{label}</span>
      {metadata ? <span className={styles.rowMeta}>{metadata}</span> : null}
    </>
  );
  return (
    <li
      className={styles.row}
      data-current={current || undefined}
      data-nested={nested || undefined}
    >
      {onSelect ? (
        <button
          type="button"
          className={styles.rowMain}
          onFocus={onFocus}
          onPointerEnter={onFocus}
          onClick={() => {
            if (!performanceTargetId) {
              onSelect();
              return;
            }
            const run = beginSwitchboardPerformance(
              NEXUS_PANE_ACTIVATE_PERFORMANCE,
              { targetId: performanceTargetId },
            );
            onSelect();
            if (current) {
              completeSwitchboardPerformanceAfterPaint(
                NEXUS_PANE_ACTIVATE_PERFORMANCE,
                run,
                performanceTargetId,
              );
            }
          }}
          aria-current={current ? "page" : undefined}
          data-switchboard-row-id={id}
        >
          {content}
        </button>
      ) : (
        <div className={styles.rowMain} data-switchboard-group-id={id}>
          {content}
        </div>
      )}
      {actions.length > 0 ? (
        <ActionMenu
          options={actions}
          label={`Actions for ${label}`}
          align="end"
          renderTrigger={(trigger) => (
            <button
              {...trigger}
              type="button"
              className={styles.rowMenu}
              aria-label={`Actions for ${label}`}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
          )}
        />
      ) : null}
    </li>
  );
}
