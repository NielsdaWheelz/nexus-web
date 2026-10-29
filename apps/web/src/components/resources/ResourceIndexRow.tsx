"use client";
import { excerptTextParts } from "@nexus/authored/excerpt";

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
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { ExcerptText, ResourceIndexBody, type ResourceMatch } from "./ResourceBody";
import { FullResourceBody } from "./ExcerptDisclosure";
import IndexBibliography from "./IndexBibliography";
import ResourceMetadata from "./ResourceMetadata";
import ContextualActionMenu from "./ContextualActionMenu";
import { ResourceIndexTitle } from "./ResourceType";
import styles from "./ResourceIndexRow.module.css";

type MatchMethod = Parameters<typeof resourceMetadata>[0]["matchMethod"];

/**
 * Context shows literal content and provenance; search retains its source-oriented
 * title and separate evidence. Both preserve native item and source navigation.
 */
export default function ResourceIndexRow({
  item: supplied, occurrenceKey, presentation, match = null, matchMethod = null,
  occurrenceLabel, primaryLinkRef, moreTriggerRef, primaryControl, attention: suppliedAttention, podcastSubject, afterRemoval,
}: {
  podcastSubject?: PodcastActionSubject;
  afterRemoval?: () => HTMLElement | null;
  item: ResourceItem;
  occurrenceKey: string;
  presentation: { kind: "Context"; primary: { kind: "Item" } | { kind: "Status"; label: string }; supportingContent: ReactNode } | { kind: "Search"; excerpt: ReactNode };
  match?: ResourceMatch | null;
  matchMethod?: MatchMethod;
  occurrenceLabel?: string;
  primaryLinkRef?: Ref<HTMLAnchorElement>;
  moreTriggerRef?: Ref<HTMLButtonElement>;
  primaryControl?: ReactNode;
  attention?: string;
}) {
  const status = presentation.kind === "Context" && presentation.primary.kind === "Status" ? presentation.primary.label : null;
  const item = useResolvedResourceItem(supplied);
  const parsed = parseResourceRef(item.ref);
  // justify-defect: canonical row identity must satisfy the resource-ref grammar.
  if (parsed === null) throw new Error(`Invalid canonical resource index ref: ${item.ref}`);
  if (podcastSubject !== undefined && (podcastSubject.target.kind !== "Canonical" || item.ref !== `podcast:${podcastSubject.target.podcast_id}` || item.preview.body.kind !== "named" || item.missing))
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
  const typeLabel = resourceTypeLabel(parsed.scheme).toLowerCase();
  let title = "";
  let titleProvidesType = false;
  let titleLocation: string | null = null;
  let titleMatch: ResourceMatch | null = null;
  let titleLabel = "";
  let parts = metadata.parts;
  if (presentation.kind === "Search") {
    switch (body.kind) {
      case "media": title = body.media_summary.title; break;
      case "named": title = body.title || "untitled"; break;
      case "images": title = body.count === 1 ? "image" : `${body.count} images`; break;
      case "passage":
      case "prose": {
        const literal = body.kind === "passage" ? (body.excerpt.kind === "content" ? excerptTextParts(body.excerpt.body).exact : "table excerpt") : body.excerpt.text;
        if (source?.title?.trim()) title = source.title.trim();
        else if (literal.startsWith(item.label)) {
          title = typeLabel;
          titleProvidesType = true;
        } else {
          title = item.label;
          // The API supplies a type-only label for an empty prose note.
          titleProvidesType = body.kind === "prose" && !literal && parsed.scheme === "note_block";
        }
        break;
      }
      case "reference": title = item.label; break;
      default: assertNever(body);
    }
    const needsKind = body.kind !== "media" && body.kind !== "named";
    titleLocation = needsKind && source?.title?.trim() ? source.location_label : null;
    titleMatch = match?.excerpt.text === title ? match : null;
    const accessibleTitle = [titleMatch?.excerpt.truncated_before ? "earlier text omitted" : null,
      title, titleMatch?.excerpt.truncated_after ? "later text omitted" : null].filter(Boolean).join(" ");
    titleLabel = `${titleProvidesType ? "" : `${typeLabel}: `}${accessibleTitle}${titleLocation ? `, ${titleLocation}` : ""}`;
    parts = parsed.scheme !== "note_block" ? metadata.parts.filter(part => part.key !== "identity")
      : needsKind ? [{ kind: "text", key: "identity", text: metadata.identity, href: null, date: null }, ...metadata.parts.filter(part => part.key !== "identity")] : metadata.parts;
  }
  const artwork = status === null && parsed.scheme === "podcast" && body.kind === "named" && !item.missing
    ? <PodcastRowArtwork title={item.label} imageUrl={body.image_url} /> : undefined;
  const contributors = source?.contributors ?? (body.kind === "named" ? body.contributors : null) ?? [];
  const unavailable = item.missing || item.activation.kind === "none";
  const attention = suppliedAttention ?? (status === null && summary?.processing_status === "failed" ? "processing failed; open metadata for details and recovery" : null);
  const currentLabel = status ?? item.label;
  const menuLabel = `more actions for ${currentLabel}${attention ? `: ${attention}` : ""}`;
  const rowMetadata = presentation.kind === "Search" ? <span className={styles.metadata}>
    {unavailable ? <span className={styles.reason}>{item.missing ? "resource unavailable" : "can’t open here"}</span> : null}
    {summary ? <MediaIdentity subject={{ kind: "Stored", summary }} returnFocus={returnFocus} /> : <IndexBibliography contributors={contributors} originalPublishedDate={null} returnFocus={returnFocus} />}
    {parts.length ? <span className={styles.context}><ResourceMetadata parts={parts} linkSource={true} /></span> : null}
  </span> : null;
  const contextParts = metadata.parts.filter(part => part.key === "source" || (status === null && part.key === "role"));
  const locationParts = status === null ? metadata.parts.filter(part => part.key === "location") : [];
  if (parsed.scheme === "note_block" || (status === null && body.kind === "reference")) contextParts.unshift({ kind: "text", key: "identity", text: typeLabel, href: null, date: null });
  const contextContributors = status !== null ? source?.contributors ?? [] : summary?.contributors ?? contributors;
  const contextReason = item.missing ? "resource unavailable" : item.activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable"
    : item.activation.unavailable_reason === "source_unavailable" ? "source unavailable" : item.activation.kind === "none" ? "can’t open here" : null;
  const contextMetadata = <span className={`${styles.metadata} ${styles.contextMetadata}`}>
    {status === null && contextReason ? <span className={styles.reason}>{contextReason}</span> : null}
    {contextParts.length ? <span className={styles.context}><ResourceMetadata parts={contextParts} linkSource={true} /></span> : null}
    <IndexBibliography contributors={contextContributors} originalPublishedDate={status === null ? summary?.original_published_date ?? null : null} returnFocus={returnFocus} />
    {locationParts.length ? <span className={styles.context}><ResourceMetadata parts={locationParts} linkSource={true} /></span> : null}
    {status === null && summary?.part_source ? <span className={styles.context}>from {summary.part_source.title}</span> : null}
  </span>;
  let content: ComponentProps<typeof ResourceRow>["content"];
  switch (presentation.kind) {
    case "Context": content = { kind: "Index", metadata: contextMetadata, supportingContent: <>{body.kind === "passage" && status === null ? <FullResourceBody item={item} /> : null}{presentation.supportingContent}</> }; break;
    case "Search": content = { kind: "Search", metadata: rowMetadata, excerpt: presentation.excerpt }; break;
    default: assertNever(presentation);
  }
  return <ResourceRow
    primary={status === null && item.activation.href ? { kind: "link", href: item.activation.href, label: presentation.kind === "Context" ? undefined : titleLabel, paneLabelHint: item.label,
      ref: (node) => { titleRef.current = node; if (typeof primaryLinkRef === "function") primaryLinkRef(node); else if (primaryLinkRef) primaryLinkRef.current = node; },
    } : { kind: "static" }}
    leadingVisual={artwork}
    title={<ResourceIndexTitle scheme={parsed.scheme} hasArtwork={artwork !== undefined}>
      {status === null && (presentation.kind === "Context" || !item.activation.href && !titleProvidesType) ? <span className={`sr-only ${styles.accessibleContext}`} dir="ltr">{typeLabel}: </span> : null}
      {status !== null ? status : presentation.kind === "Context" ? <ResourceIndexBody body={body} /> : titleMatch !== null ? <ExcerptText excerpt={titleMatch.excerpt} match={titleMatch} /> : title}
      {status === null && presentation.kind === "Search" && !item.activation.href && titleLocation ? <span className={`sr-only ${styles.accessibleContext}`}>{`, ${titleLocation}`}</span> : null}
    </ResourceIndexTitle>}
    content={content}
    controls={<>
      {primaryControl ? <span data-row-primary-control="" data-row-compact-primary-control={presentation.kind === "Context" ? "" : undefined}>{primaryControl}</span> : null}
      {presentation.kind === "Search" && subject ? <ResourceActions subject={subject} density="Row" returnFocus={returnFocus} afterRemoval={actionFocus.afterRemoval} /> : null}
      <ContextualActionMenu title={currentLabel} subjectKey={occurrenceKey} sections={[]}
        triggerRef={setMore} actionFocus={actionFocus} triggerAttributes={{ "data-row-actions-control": "" }}
        resourceRef={assumeCanonicalResourceRef(item.action_ref)} displayedActivation={status === null ? item.activation : undefined}
        showSourceSubject={item.action_ref !== item.ref} label={menuLabel}
        renderTrigger={(props) => <>
          <OverflowMenuButton {...props} title={attention ? menuLabel : undefined} />
          {attention ? <span className={styles.attentionMark} aria-hidden="true">!</span> : null}
        </>}
      />
    </>}
    rootProps={{ "data-resource-ref": item.ref }}
  />;
}
