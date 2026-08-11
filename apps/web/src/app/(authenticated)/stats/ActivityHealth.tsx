"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import {
  activityRuntime,
  useActivityRuntimeSnapshot,
} from "@/lib/consumption/activityRuntime";
import { activityStatus } from "@/lib/consumption/activityStatus";
import styles from "./StatsPaneBody.module.css";

export default function ActivityHealth() {
  const snapshot = useActivityRuntimeSnapshot();
  const [busy, setBusy] = useState(false);
  const [asyncDefect, setAsyncDefect] = useState<unknown>(null);
  const run = (operation: () => Promise<void>) => {
    setBusy(true);
    void operation().catch(setAsyncDefect).finally(() => setBusy(false));
  };
  if (asyncDefect !== null) throw asyncDefect;

  const status = activityStatus(snapshot);
  return (
    <section className={styles.activityHealth} aria-labelledby="activity-health-title">
      <div>
        <h2 id="activity-health-title">Activity</h2>
        <strong role="status">{status.label}</strong>
        {snapshot.capture.kind === "Blocked" ? (
          <span>
            {snapshot.capture.reason === "StorageUnavailable"
              ? "Local storage is unavailable."
              : "The local activity queue is full."}
          </span>
        ) : null}
        {snapshot.sync.kind === "Pending" ? (
          <span>
            {snapshot.sync.count} pending · oldest{" "}
            {new Date(snapshot.sync.oldestAt).toLocaleString()}
          </span>
        ) : null}
        {snapshot.sync.kind === "Failed" ? (
          <span>{snapshot.sync.count} failed</span>
        ) : null}
      </div>
      <div className={styles.activityHealthActions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || snapshot.capture.kind === "Blocked"}
          onClick={() =>
            run(() =>
              activityRuntime().setPaused(snapshot.capture.kind !== "Paused"),
            )
          }
        >
          {snapshot.capture.kind === "Paused" ? "Resume" : "Pause"}
        </Button>
        {snapshot.sync.kind === "Failed" ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => run(() => activityRuntime().retryFailed())}
            >
              Retry now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Discard failed activity? This permanently removes only the failed local rows.",
                  )
                ) {
                  run(() => activityRuntime().discardFailed());
                }
              }}
            >
              Discard failed
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
