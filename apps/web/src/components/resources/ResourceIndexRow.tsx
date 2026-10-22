"use client";

import type { ReactNode, Ref } from "react";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ResourceRow from "@/components/ui/ResourceRow";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { collectionActivityText, collectionConsumptionText } from "@/components/collections/collectionRowFormatting";
import { useResolvedResourceItem } from "@/lib/media/mediaSummary";
import { resourceMetadata } from "@/lib/resources/metadata";
import type { ResourceItem } from "@/lib/resources/items";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import ResourceBody, { ResourceMatchEvidence, type ResourceMatch } from "./ResourceBody";
import ResourceMetadata from "./ResourceMetadata";
import ContextualActionMenu from "./ContextualActionMenu";

type MatchMethod = Parameters<typeof resourceMetadata>[0]["matchMethod"];

/** Read-only item adapter: exact navigation, canonical facts and one resource menu. */
export default function ResourceIndexRow({ item: supplied, occurrenceKey, match = null, matchMethod = null,
  occurrenceLabel, primaryLinkRef, primaryControl, nestedContent,
}: {
  item: ResourceItem;
  occurrenceKey: string;
  match?: ResourceMatch | null;
  matchMethod?: MatchMethod;
  occurrenceLabel?: string;
  primaryLinkRef?: Ref<HTMLAnchorElement>;
  primaryControl?: ReactNode;
  nestedContent?: ReactNode;
}) {
  const item = useResolvedResourceItem(supplied);
  const body = item.preview.body;
  const metadata = resourceMetadata({ item, matchMethod, occurrenceLabel });
  const summary = body.kind === "media" ? body.media_summary : null;
  const remaining = summary && summary.consumption.state !== "Finished" ? summary.duration?.estimate.remaining_minutes : null;
  const time = remaining != null && summary?.duration ? collectionActivityText({ kind: "RemainingTime", minutes: remaining, modality: summary.duration.modality }) : null;
  const parts = [...metadata.bibliography, ...metadata.parts];
  return <ResourceRow
    primary={item.activation.href ? { kind: "link", href: item.activation.href, paneLabelHint: item.label, ref: primaryLinkRef } : { kind: "static" }}
    leadingVisual={item.ref.startsWith("podcast:") && body.kind === "named" && !item.missing ? <PodcastRowArtwork title={item.label} imageUrl={body.image_url} /> : undefined}
    title={<ResourceBody body={body} match={match} />}
    supporting={<>
      <ResourceMetadata parts={parts} linkSource={true} />
      {summary ? <>{parts.length ? " · " : null}{collectionConsumptionText(summary.consumption)}{time ? <> · <span aria-label={time.accessible}>{time.visible}</span></> : null}</> : null}
    </>}
    evidence={match && body.kind !== "passage" && body.kind !== "prose" ? <ResourceMatchEvidence match={match} /> : undefined}
    status={item.missing || item.activation.kind === "none" ? <FeedbackNotice content={{ tone: "Warning", title: "this resource can’t be opened here" }} announcement="None" /> : summary?.processing_status === "failed" ? "processing failed" : undefined}
    primaryControl={primaryControl}
    actions={<ContextualActionMenu title={item.label} subjectKey={occurrenceKey} sections={[]}
      resourceRef={assumeCanonicalResourceRef(item.action_ref)} displayedActivation={item.activation}
      showSourceSubject={item.action_ref !== item.ref} />}
    expanded={nestedContent}
    rootProps={{ "data-resource-ref": item.ref }}
    wrapped
  />;
}
