/**
 * Collection view-model. Per-kind presenters (`presenters/*`) own the decision of
 * what earns weight for one kind of item and return a `CollectionRowView`;
 * `CollectionRow` renders it. Presenters are pure data — no React, no fetch.
 */

import type { LucideIcon } from "lucide-react";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { PillTone } from "@/components/ui/Pill";
import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";
import type { EdgeKind } from "@/lib/resourceGraph/edges";

export type CollectionItemKind =
  | "media"
  | "podcast"
  | "podcast_episode"
  | "library"
  | "contributor"
  | "note"
  | "conversation"
  | "search_result"
  | "browse_result"
  | "settings_row";

/** Cover-or-icon lead. Covers travel as proxied remote URLs; `icon` is the fallback tile. */
export interface ResourceThumbSpec {
  icon: LucideIcon;
  remoteUrl?: string;
}

/** A headline split for emphasis (search `<mark>`); mirrors search snippet segments. */
export interface EmphasisSegment {
  text: string;
  emphasized: boolean;
}

/** A dimmed signal fact in the meta row, e.g. `{ value: "2021" }` or `{ label: "by", value: "…" }`. */
export interface SignalFact {
  label?: string;
  value: string;
}

export type ReadStatus = "unread" | "in_progress" | "finished";

export interface SwipeAction {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: "default" | "danger";
  onActivate: () => void;
}

export interface CollectionRowView {
  id: string;
  kind: CollectionItemKind;
  primary: ResourceRowPrimary;
  lead: ResourceThumbSpec;
  headline: { text: string; segments?: EmphasisSegment[] };
  signals: SignalFact[];
  /** Derived read/listen state (S3). */
  consumption?: { status: ReadStatus; fraction?: number };
  /** Non-read domain status (processing/sync); distinct from `consumption`. */
  status?: { tone: PillTone; label: string };
  /** Deterministic provenance summary (S4); peers carry label + href. */
  connections?: { total: number; dominantKind?: EdgeKind; topPeers: ConnectionEndpointOut[] };
  /** Similarity + shared-author peers (S5). */
  related?: ConnectionEndpointOut[];
  /** Media id for related-item lookup. Omit for the media-row default; null opts out. */
  relatedMediaId?: string | null;
  contributors?: { credits: ContributorCredit[]; maxVisible: number; showRole?: boolean };
  recency?: { at: string };
  actions?: ActionMenuOption[];
  swipeActions?: SwipeAction[];
  selected?: boolean;
}
