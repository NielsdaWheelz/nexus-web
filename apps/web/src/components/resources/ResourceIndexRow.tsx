"use client";

import { useRef, type ReactNode, type Ref } from "react";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ResourceRow from "@/components/ui/ResourceRow";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import MediaActions from "@/components/media/MediaActions";
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
  const title = useRef<HTMLAnchorElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const returnFocus = () => more.current?.isConnected && more.current.getClientRects().length ? more.current : title.current;
  const parts = [...metadata.bibliography, ...metadata.parts];
  return <ResourceRow
    media={summary !== null}
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
    actions={<>{summary ? <MediaActions subject={{ kind: "Stored", summary }} knownDescriptor={null} density="Row" returnFocus={returnFocus} /> : null}<ContextualActionMenu title={item.label} subjectKey={occurrenceKey} sections={[]}
      triggerRef={node => { more.current = node; }}
      resourceRef={assumeCanonicalResourceRef(item.action_ref)} displayedActivation={item.activation}
      showSourceSubject={item.action_ref !== item.ref} /></>}
    expanded={nestedContent}
    rootProps={{ "data-resource-ref": item.ref }}
    wrapped
  />;
}
