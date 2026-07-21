/**
 * Media presenter — the template the other presenters follow. Pure data: it owns
 * the decision of what earns weight for a document/media row. No React, no fetch.
 *
 * `ctx` carries everything `mediaResourceOptions` needs except the subject itself
 * (the pane supplies callbacks + capability flags + busy state).
 */

import { CheckCircle2, Circle } from "lucide-react";
import { mediaResourceOptions } from "@/lib/actions/resourceActions";
import { readConsumption, type ReadStateFields } from "@/lib/collections/readState";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import { mediaProcessingStatusPill, type MediaProcessingStatus } from "@/lib/status/mediaProcessing";

export interface MediaPresenterItem extends ReadStateFields {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: MediaProcessingStatus;
  published_date?: string | null;
  publisher?: string | null;
  contributors?: ContributorCredit[];
  capabilities?: unknown;
}

export type MediaPresenterContext = Omit<
  Parameters<typeof mediaResourceOptions>[0],
  "media" | "readState"
> & {
  connectionSummary?: ConnectionSummaryOut;
};

export function presentMedia(item: MediaPresenterItem, ctx: MediaPresenterContext): CollectionRowView {
  const { connectionSummary, ...actionCtx } = ctx;
  const status = mediaProcessingStatusPill(item.processing_status);
  const actions = mediaResourceOptions({
    media: item,
    readState: item.read_state ?? undefined,
    ...actionCtx,
  });
  // The read-state override verb is the primary swipe (D-11): mark-finished on
  // unread/in-progress rows, mark-unread on finished rows. Delete stays in the
  // action menu only.
  const markAction = actions.find(
    (action) =>
      (action.id === "mark-finished" || action.id === "mark-unread") &&
      !action.disabled &&
      action.onSelect,
  );

  const signals: SignalFact[] = [];
  if (item.publisher) signals.push({ value: item.publisher });
  if (item.published_date) signals.push({ value: item.published_date });

  return {
    id: item.id,
    kind: "media",
    primary: {
      kind: "link",
      href: `/media/${item.id}`,
      paneTitleHint: item.title,
      viewTransition: "media-reader",
    },
    lead: { icon: mediaKindIcon(item.kind) },
    headline: { text: item.title },
    signals,
    consumption: readConsumption(item),
    status: status ?? undefined,
    connections: connectionsFromSummary(connectionSummary),
    recency: item.last_engaged_at ? { at: item.last_engaged_at } : undefined,
    contributors:
      item.contributors && item.contributors.length > 0
        ? { credits: item.contributors, maxVisible: 3 }
        : undefined,
    actions,
    swipeActions: markAction
      ? [
          {
            id: markAction.id,
            label: markAction.label,
            icon: markAction.id === "mark-finished" ? CheckCircle2 : Circle,
            onActivate: () => markAction.onSelect?.({ triggerEl: null }),
          },
        ]
      : undefined,
  };
}
