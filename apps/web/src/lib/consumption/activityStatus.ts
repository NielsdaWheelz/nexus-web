import type { ActivityRuntimeSnapshot } from "./activityRuntime";

export type ActivityStatusLabel =
  | "Recording"
  | "Idle"
  | "Paused"
  | "Waiting to sync"
  | "Needs attention";

export function activityStatus(snapshot: ActivityRuntimeSnapshot): {
  readonly label: ActivityStatusLabel;
  readonly marked: boolean;
} {
  if (snapshot.capture.kind === "Blocked" || snapshot.sync.kind === "Failed") {
    return { label: "Needs attention", marked: true };
  }
  if (snapshot.sync.kind === "Pending") {
    return { label: "Waiting to sync", marked: true };
  }
  return {
    label: snapshot.capture.kind,
    marked: false,
  };
}
