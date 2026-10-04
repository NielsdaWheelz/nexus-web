"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { activityRuntime, useActivityRuntimeSnapshot } from "@/lib/consumption/activityRuntime";
import { activityStatus } from "@/lib/consumption/activityStatus";
import styles from "./StatsPaneBody.module.css";

const DISCARD = "Discard failed activity? This permanently removes only the failed local rows.";

export default function ActivityHealth() {
  const snapshot = useActivityRuntimeSnapshot();
  const { capture, sync } = snapshot;
  const [busy, setBusy] = useState(false);
  const [defect, setDefect] = useState<unknown>(null);
  if (defect !== null) throw defect;
  const runtime = activityRuntime();
  const run = (operation: () => Promise<void>) => {
    setBusy(true);
    void operation()
      .catch(setDefect)
      .finally(() => setBusy(false));
  };
  const blocked =
    capture.kind === "Blocked" &&
    (capture.reason === "StorageUnavailable"
      ? "Local storage is unavailable."
      : "The local activity queue is full.");

  return (
    <section className={styles.health} aria-labelledby="activity-health-title">
      <div>
        <h2 id="activity-health-title">Activity</h2>
        <strong role="status">{activityStatus(snapshot).label}</strong>
        {blocked ? <span>{blocked}</span> : null}
        {sync.kind === "Pending" ? (
          <span>
            {sync.count} pending · oldest {new Date(sync.oldestAt).toLocaleString()}
          </span>
        ) : null}
        {sync.kind === "Failed" ? <span>{sync.count} failed</span> : null}
      </div>
      <div className={styles.healthActions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || capture.kind === "Blocked"}
          onClick={() => run(() => runtime.setPaused(capture.kind !== "Paused"))}
        >
          {capture.kind === "Paused" ? "Resume" : "Pause"}
        </Button>
        {sync.kind === "Failed" ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => run(runtime.retryFailed)}
            >
              Retry now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => window.confirm(DISCARD) && run(runtime.discardFailed)}
            >
              Discard failed
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
