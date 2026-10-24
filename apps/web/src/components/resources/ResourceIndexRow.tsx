"use client";

import { useCallback, useRef, type ComponentProps, type ReactNode, type Ref } from "react";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ResourceRow from "@/components/ui/ResourceRow";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import ResourceActions from "@/components/resources/ResourceActions";
import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import MediaIdentity from "@/components/media/MediaIdentity";
import { useResolvedResourceItem } from "@/lib/media/mediaSummary";
import { resourceMetadata } from "@/lib/resources/metadata";
import type { ResourceItem } from "@/lib/resources/items";
import { assertNever } from "@/lib/assertNever";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { ExcerptText, type ResourceMatch } from "./ResourceBody";
import IndexBibliography from "./IndexBibliography";
import ResourceMetadata from "./ResourceMetadata";
import ContextualActionMenu from "./ContextualActionMenu";
import styles from "./ResourceIndexRow.module.css";

type MatchMethod = Parameters<typeof resourceMetadata>[0]["matchMethod"];

/**
 * A flat index preserves exact item activation and source navigation. Titles name
 * the source/kind instead of repeating prose evidence; search owns one literal
 * evidence slot, including its separately supplied exact passage destination.
 */
export default function ResourceIndexRow({
  item: supplied, occurrenceKey, presentation, match = null, matchMethod = null,
  occurrenceLabel, primaryLinkRef, moreTriggerRef, primaryControl, attention: suppliedAttention, podcastSubject, afterRemoval,
}: {
  podcastSubject?: PodcastActionSubject;
  afterRemoval?: () => HTMLElement | null;
  item: ResourceItem;
  occurrenceKey: string;
  presentation: { kind: "Index" } | { kind: "Search"; excerpt: ReactNode };
  match?: ResourceMatch | null;
  matchMethod?: MatchMethod;
  occurrenceLabel?: string;
  primaryLinkRef?: Ref<HTMLAnchorElement>;
  moreTriggerRef?: Ref<HTMLButtonElement>;
  primaryControl?: ReactNode;
  attention?: string;
}) {
  const item = useResolvedResourceItem(supplied);
  if (podcastSubject !== undefined && (podcastSubject.target.kind !== "Canonical" || item.ref !== `podcast:${podcastSubject.target.podcast_id}`))
    throw new Error("podcast action subject does not match the live resource ref");
  const body = item.preview.body;
  const source = item.preview.source;
  const metadata = resourceMetadata({ item, matchMethod, occurrenceLabel });
  const summary = body.kind === "media" ? body.media_summary : null;
  const titleRef = useRef<HTMLAnchorElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const setMore = useCallback((node: HTMLButtonElement | null) => {
    moreRef.current = node;
    if (typeof moreTriggerRef === "function") moreTriggerRef(node);
    else if (moreTriggerRef) moreTriggerRef.current = node;
  }, [moreTriggerRef]);
  const returnFocus = () => moreRef.current?.isConnected && moreRef.current.getClientRects().length ? moreRef.current : titleRef.current;
  const actionFocus = { get trigger() { return moreRef.current; }, returnFocus, afterRemoval: afterRemoval ?? returnFocus };
  const subject = summary !== null ? { kind: "Media" as const, subject: { kind: "Stored" as const, summary }, knownDescriptor: null }
    : podcastSubject !== undefined ? { kind: "Podcast" as const, subject: podcastSubject } : null;
  let title: string;
  switch (body.kind) {
    case "media": title = body.media_summary.title; break;
    case "named": title = body.title || "untitled"; break;
    case "images": title = body.count === 1 ? "image" : `${body.count} images`; break;
    case "passage":
    case "prose": {
      const literal = body.kind === "passage" ? body.exact.text : body.excerpt.text;
      title = source?.title?.trim() || (literal.startsWith(item.label) ? metadata.identity : item.label);
      break;
    }
    case "reference": title = item.label; break;
    default: assertNever(body);
  }
  const needsKind = body.kind !== "media" && body.kind !== "named";
  const parts = needsKind ? [{ kind: "text" as const, key: "identity", text: metadata.identity, href: null, date: null }, ...metadata.parts.filter(part => part.key !== "identity")] : metadata.parts;
  const contributors = source?.contributors ?? (body.kind === "named" ? body.contributors : null) ?? [];
  const unavailable = item.missing || item.activation.kind === "none";
  const attention = suppliedAttention ?? (summary?.processing_status === "failed" ? "processing failed; open metadata for details and recovery" : null);
  const menuLabel = `more actions for ${item.label}${attention ? `: ${attention}` : ""}`;
  const rowMetadata = <span className={styles.metadata}>
    {unavailable ? <span className={styles.reason}>{item.missing ? "resource unavailable" : "can’t open here"}</span> : null}
    {summary ? <MediaIdentity subject={{ kind: "Stored", summary }} returnFocus={returnFocus} /> : <IndexBibliography contributors={contributors} originalPublishedDate={null} returnFocus={returnFocus} />}
    {parts.length ? <span className={styles.context}><ResourceMetadata parts={parts} linkSource={true} /></span> : null}
  </span>;
  let content: ComponentProps<typeof ResourceRow>["content"];
  switch (presentation.kind) {
    case "Index": content = { kind: "Index", metadata: rowMetadata }; break;
    case "Search": content = { kind: "Search", metadata: rowMetadata, excerpt: presentation.excerpt }; break;
    default: assertNever(presentation);
  }
  return <ResourceRow
    primary={item.activation.href ? { kind: "link", href: item.activation.href, paneLabelHint: item.label,
      ref: (node) => { titleRef.current = node; if (typeof primaryLinkRef === "function") primaryLinkRef(node); else if (primaryLinkRef) primaryLinkRef.current = node; },
    } : { kind: "static" }}
    leadingVisual={item.ref.startsWith("podcast:") && body.kind === "named" && !item.missing ? <PodcastRowArtwork title={item.label} imageUrl={body.image_url} /> : undefined}
    title={<>{match?.excerpt.text === title ? <ExcerptText excerpt={match.excerpt} match={match} /> : title}
      {needsKind && source?.title?.trim() ? <span className="sr-only">, {metadata.identity}{source.location_label ? `, ${source.location_label}` : ""}</span> : null}
    </>}
    content={content}
    controls={<>
      {primaryControl ? <span data-row-primary-control="">{primaryControl}</span> : null}
      {subject ? <ResourceActions subject={subject} density="Row" returnFocus={returnFocus} afterRemoval={actionFocus.afterRemoval} /> : null}
      <ContextualActionMenu title={item.label} subjectKey={occurrenceKey} sections={[]}
        triggerRef={setMore} actionFocus={actionFocus} triggerAttributes={{ "data-row-actions-control": "" }}
        resourceRef={assumeCanonicalResourceRef(item.action_ref)} displayedActivation={item.activation}
        showSourceSubject={item.action_ref !== item.ref} label={menuLabel}
        renderTrigger={(props) => <span className={styles.attentionTrigger}>
          <OverflowMenuButton {...props} title={attention ? menuLabel : undefined} />
          {attention ? <span className={styles.attentionMark} aria-hidden="true">!</span> : null}
        </span>}
      />
    </>}
    rootProps={{ "data-resource-ref": item.ref }}
  />;
}
