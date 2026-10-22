"use client";

import { useMediaSummaries } from "./MediaSummaryProvider";
import type { ResourceItem } from "@/lib/resources/items";
import type { Schema } from "@/lib/api/wire";

export type MediaDuration = Schema<"MediaDurationOut">;
export type MediaSummary = Schema<"MediaSummaryOut">;

/** A supplied live body joins the existing batched owner; frozen evidence stays captured. */
export function useResolvedResourceItem(item: ResourceItem, historical = false): ResourceItem {
  const body = item.preview.body;
  const seed = !historical && body.kind === "media" ? body.media_summary : null;
  const summaries = useMediaSummaries(seed ? [seed] : []);
  if (seed === null) return item;
  const summary = summaries.resolve(seed);
  return summary === null ? {
    ...item, missing: true, label: "Resource unavailable",
    activation: { ...item.activation, kind: "none", href: null, unavailable_reason: "source_unavailable" },
    preview: { ...item.preview, source: null, body: { kind: "named", title: "Resource unavailable", media_kind: null, contributors: null, image_url: null } },
  } : { ...item, label: summary.title, preview: { ...item.preview, body: { kind: "media", media_summary: summary } } };
}
