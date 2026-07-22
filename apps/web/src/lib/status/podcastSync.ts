import { expectOneOf } from "@/lib/validation";

const PODCAST_SYNC_STATUSES = [
  "pending",
  "running",
  "partial",
  "complete",
  "source_limited",
  "failed",
] as const;

export type PodcastSyncStatus = (typeof PODCAST_SYNC_STATUSES)[number];

export function decodePodcastSyncStatus(
  raw: unknown,
  name: string,
): PodcastSyncStatus {
  return expectOneOf(raw, PODCAST_SYNC_STATUSES, name);
}
