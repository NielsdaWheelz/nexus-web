"use client";

import { ArrowLeft, RotateCcw, X } from "lucide-react";
import type { ManageTabsOrigin } from "@/lib/nexus/model";
import { retainedNexusTargetLabel } from "@/lib/nexus/model";
import type {
  NexusManagedClosedPane,
  NexusManagedPane,
} from "./useNexusController";
import styles from "./Nexus.module.css";

export default function ManageTabsPage({
  origin,
  panes,
  recentlyClosed,
  onBack,
  onOpen,
  onClose,
  onRestore,
  onRetryRetained,
  onCancelRetained,
}: {
  readonly origin: ManageTabsOrigin;
  readonly panes: readonly NexusManagedPane[];
  readonly recentlyClosed: readonly NexusManagedClosedPane[];
  readonly onBack: () => void;
  readonly onOpen: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly onRestore: (paneId: string) => void;
  readonly onRetryRetained: () => void;
  readonly onCancelRetained: () => void;
}) {
  return (
    <section className={styles.workflowPage}>
      <header className={styles.workflowHeader}>
        <button type="button" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <h2 tabIndex={-1} data-switchboard-heading data-switchboard-open-heading>
            Manage tabs
          </h2>
          <p>Open, close, or restore a workspace tab.</p>
        </div>
      </header>

      {origin.kind === "Recovery" ? (
        <div className={styles.recoveryNotice}>
          <p>
            Make room, then open {retainedNexusTargetLabel(origin.retained.target)}.
          </p>
          <div>
            <button type="button" onClick={onRetryRetained}>Retry open</button>
            <button type="button" onClick={onCancelRetained}>Cancel</button>
          </div>
        </div>
      ) : null}

      <section className={styles.tabSection} aria-labelledby="nexus-open-tabs">
        <h3 id="nexus-open-tabs">Open</h3>
        <ul>
          {panes.map((pane) => (
            <li key={pane.id} data-current={pane.current || undefined}>
              <button type="button" onClick={() => onOpen(pane.id)}>
                <span>{pane.label}</span>
                <small>
                  {pane.current
                    ? "Current tab"
                    : pane.visibility === "minimized"
                      ? "Minimized tab"
                      : "Open tab"}
                </small>
              </button>
              <button
                type="button"
                aria-label={`Close ${pane.label}`}
                onClick={() => onClose(pane.id)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      {recentlyClosed.length > 0 ? (
        <section className={styles.tabSection} aria-labelledby="nexus-closed-tabs">
          <h3 id="nexus-closed-tabs">Recently closed</h3>
          <ul>
            {recentlyClosed.map((pane) => (
              <li key={pane.id}>
                <button type="button" onClick={() => onRestore(pane.id)}>
                  <RotateCcw size={18} aria-hidden="true" />
                  <span>{pane.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
