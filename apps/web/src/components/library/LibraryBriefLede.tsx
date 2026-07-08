"use client";

import MachineText from "@/components/ui/MachineText";
import type { ArtifactStatus } from "@/components/library/dossierTypes";
import {
  dossierStatusLabel,
  dossierStatusRole,
} from "@/components/library/LibraryBriefControls";
import styles from "./LibraryBrief.module.css";

/**
 * The collapsed brief: the dossier's opening abstract set in the machine
 * register (signed DOSSIER), a quiet status cue when the dossier is stale or
 * building, and the disclosure that reveals the full body (`aria-controls`).
 */
export default function LibraryBriefLede({
  lede,
  status,
  progress,
  staleSourceCount,
  expandable,
  expanded,
  fullBodyId,
  onToggle,
}: {
  lede: string;
  status: ArtifactStatus;
  progress: string | null;
  staleSourceCount: number | null;
  expandable: boolean;
  expanded: boolean;
  fullBodyId: string;
  onToggle: () => void;
}) {
  const showCue = status !== "current" && status !== "unavailable";
  return (
    <div className={styles.lede} data-status={status}>
      {!expanded && lede ? (
        <MachineText origin={{ label: "Dossier" }} className={styles.ledeBody}>
          {lede}
        </MachineText>
      ) : null}
      <div className={styles.controlsRow}>
        {showCue ? (
          // The cue is the live region only while collapsed; expanded, the
          // LibraryBriefControls status line owns it, so gating the role here
          // avoids a duplicate announcement (§7.1 binding b).
          <span
            className={styles.statusCue}
            data-status={status}
            role={expanded ? undefined : dossierStatusRole(status)}
          >
            {dossierStatusLabel(status, progress, staleSourceCount)}
          </span>
        ) : null}
        {expandable ? (
          <button
            type="button"
            className={styles.expander}
            aria-expanded={expanded}
            aria-controls={fullBodyId}
            onClick={onToggle}
          >
            {expanded ? "Hide the full dossier" : "Read the full dossier"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
