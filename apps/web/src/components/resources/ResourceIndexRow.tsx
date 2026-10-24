"use client";

import { useCallback, useRef, type ReactNode, type Ref } from "react";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ResourceRow from "@/components/ui/ResourceRow";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ResourceActions from "@/components/resources/ResourceActions";
import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import MediaIdentity from "@/components/media/MediaIdentity";
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
  occurrenceLabel, primaryLinkRef, primaryControl, nestedContent, podcastSubject, afterRemoval,
}: {
  podcastSubject?: PodcastActionSubject;
  afterRemoval?: () => HTMLElement | null;
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
  if (podcastSubject !== undefined && (podcastSubject.target.kind !== "Canonical" || item.ref !== `podcast:${podcastSubject.target.podcast_id}`))
    throw new Error("podcast action subject does not match the live resource ref");
  const body = item.preview.body;
  const metadata = resourceMetadata({ item, matchMethod, occurrenceLabel });
  const summary = body.kind === "media" ? body.media_summary : null;
  const title = useRef<HTMLAnchorElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const setMore = useCallback((node: HTMLButtonElement | null) => { more.current = node; }, []);
  const returnFocus = () => more.current?.isConnected && more.current.getClientRects().length ? more.current : title.current;
  const actionFocus = { get trigger() { return more.current; }, returnFocus, afterRemoval: afterRemoval ?? returnFocus };
  const subject = summary !== null ? { kind: "Media" as const, subject: { kind: "Stored" as const, summary }, knownDescriptor: null }
    : podcastSubject !== undefined ? { kind: "Podcast" as const, subject: podcastSubject } : null;
  const parts = [...metadata.bibliography, ...metadata.parts];
  return <ResourceRow
    media={subject !== null}
    primary={item.activation.href ? { kind: "link", href: item.activation.href, paneLabelHint: item.label, ref: (element) => { title.current = element; if (typeof primaryLinkRef === "function") primaryLinkRef(element); else if (primaryLinkRef) primaryLinkRef.current = element; } } : { kind: "static" }}
    leadingVisual={item.ref.startsWith("podcast:") && body.kind === "named" && !item.missing ? <PodcastRowArtwork title={item.label} imageUrl={body.image_url} /> : undefined}
    title={<ResourceBody body={body} match={match} />}
    supporting={summary ? <>
      <MediaIdentity subject={{ kind: "Stored", summary }} />
      <ResourceMetadata parts={metadata.parts} linkSource={true} />
    </> : <ResourceMetadata parts={parts} linkSource={true} />}
    evidence={match && body.kind !== "passage" && body.kind !== "prose" ? <ResourceMatchEvidence match={match} /> : undefined}
    status={item.missing || item.activation.kind === "none" ? <FeedbackNotice content={{ tone: "Warning", title: "this resource can’t be opened here" }} announcement="None" /> : undefined}
    primaryControl={primaryControl}
    actions={<>{subject ? <ResourceActions subject={subject} density="Row" returnFocus={returnFocus} afterRemoval={actionFocus.afterRemoval} /> : null}<ContextualActionMenu title={item.label} subjectKey={occurrenceKey} sections={[]}
      triggerRef={setMore} actionFocus={actionFocus}
      resourceRef={assumeCanonicalResourceRef(item.action_ref)} displayedActivation={item.activation}
      showSourceSubject={item.action_ref !== item.ref} /></>}
    expanded={nestedContent}
    rootProps={{ "data-resource-ref": item.ref }}
    wrapped
  />;
}
