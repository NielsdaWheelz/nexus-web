import type { ActivityRuntimeSnapshot } from "./activityRuntime";

/** The one-word health of capture and delivery; `marked` asks for the user's attention. */
export function activityStatus(snapshot: ActivityRuntimeSnapshot): {
  readonly label: "Recording" | "Idle" | "Paused" | "Waiting to sync" | "Needs attention";
  readonly marked: boolean;
} {
  if (snapshot.capture.kind === "Blocked" || snapshot.sync.kind === "Failed") {
    return { label: "Needs attention", marked: true };
  }
  if (snapshot.sync.kind === "Pending") return { label: "Waiting to sync", marked: true };
  return { label: snapshot.capture.kind, marked: false };
}
