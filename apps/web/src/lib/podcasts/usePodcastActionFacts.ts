"use client";

// One containing view owns the complete loaded target set. Local reads are
// sequential batches; only their complete result can authorize a new command.
// Retained facts survive a same-key refresh solely for disabled presentation.
// Re-admission retires old facts before the reconnect reread begins.

import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type ServerValue, type Visit } from "@/lib/api/serverState";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { LIVE_SOURCE } from "@/lib/catalog/types";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import { usePaneIsActive, usePaneIsVisible } from "@/lib/panes/paneRuntime";
import {
  podcastTargetKey,
  resolvePodcastActionFacts,
  type PodcastActionResolution,
  type PodcastActionResult,
  type PodcastTarget,
} from "@/lib/podcasts/api";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";

type ActionFacts = ReadonlyMap<string, PodcastActionResult>;
interface Snapshot {
  stale: string;
  items: ActionFacts;
}
const EMPTY: ActionFacts = new Map();

export function usePodcastActionFacts(input: {
  scope: string;
  targets: readonly PodcastTarget[];
  refresh: string;
}): ServerValue<ActionFacts> {
  const { accountId } = useAuthenticatedAccount();
  const stamp = useChangeStamp("Podcasts", "Libraries");
  const admissionGeneration = useRemoteGeneration();
  const active = usePaneIsActive();
  const visible = usePaneIsVisible();
  const foreground = useRefreshStamp(active && visible, 0);
  const stale = JSON.stringify([stamp, input.refresh, foreground, admissionGeneration]);
  const targets = [...new Map(input.targets.map(target => [podcastTargetKey(target), target])).entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  const read = useServerValue<Snapshot>({
    key: targets.length === 0 ? null : JSON.stringify(["Podcast.ActionFacts", accountId, input.scope, targets.map(([key]) => key)]),
    stale,
    visit: definePaneVisitDataKey<Visit<Snapshot>>(`Podcast.ActionFacts:${input.scope}`),
    load: async signal => {
      const items: PodcastActionResult[] = [];
      const canonical = new Map<string, Extract<PodcastActionResolution, { kind: "Canonical" }>>();
      for (let offset = 0; offset < targets.length; offset += 100) {
        signal.throwIfAborted();
        const chunk = await resolvePodcastActionFacts(targets.slice(offset, offset + 100).map(([, target]) => target), signal);
        items.push(...chunk);
        for (const item of chunk) {
          if (item.resolution.kind === "Canonical") canonical.set(item.resolution.podcast_id, item.resolution);
        }
      }
      return {
        stale,
        items: new Map(items.map(item => {
          if (item.resolution.kind !== "Canonical") return [podcastTargetKey(item.target), item];
          // justify-type-assertion: every canonical item above records its id; the last batch wins for all aliases.
          const resolution = canonical.get(item.resolution.podcast_id)!;
          return [podcastTargetKey(item.target), { ...item, resolution }];
        })),
      };
    },
  });
  if (targets.length === 0) return { status: "ready", data: EMPTY, source: LIVE_SOURCE, generation: 0, error: null, refreshing: false, refetch: read.refetch };
  if (read.status !== "ready") return read;
  return { ...read, data: read.data.items, refreshing: read.refreshing || read.data.stale !== stale };
}
