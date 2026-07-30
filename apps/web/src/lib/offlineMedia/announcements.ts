import type { OfflineMediaInventoryItem } from "./clientStore";

export interface OfflineMediaAnnouncementMilestone {
  readonly key: string;
  readonly message: string;
}

/**
 * Live announcements follow semantic milestones, not transfer samples. The
 * key intentionally excludes byte counts so progress pushes never chatter.
 */
export function projectOfflineMediaAnnouncementMilestone(
  item: OfflineMediaInventoryItem,
): OfflineMediaAnnouncementMilestone {
  const title = item.title;
  switch (item.state.kind) {
    case "Resolving":
      return { key: "Resolving", message: `Preparing ${title} for download` };
    case "Queued":
      switch (item.state.reason) {
        case "Capacity":
          return { key: "Queued.Capacity", message: `${title} download queued` };
        case "WaitingForNetwork":
          return {
            key: "Queued.WaitingForNetwork",
            message: `${title} is waiting for network`,
          };
        case "WaitingForUnmetered":
          return {
            key: "Queued.WaitingForUnmetered",
            message: `${title} is waiting for Wi-Fi`,
          };
        case "SystemLimit":
          return {
            key: "Queued.SystemLimit",
            message: `${title} download paused by Android`,
          };
      }
    case "Downloading":
      return { key: "Downloading", message: `Downloading ${title}` };
    case "Restarting":
      return { key: "Restarting", message: `Restarting ${title} download` };
    case "Ready":
      return {
        key: "Ready",
        message: `${title} downloaded for offline`,
      };
    case "Failed":
      return { key: "Failed", message: `${title} download failed` };
    case "Removing":
      return { key: "Removing", message: `Removing ${title} download` };
  }
}
