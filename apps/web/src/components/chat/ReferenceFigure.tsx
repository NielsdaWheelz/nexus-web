"use client";

import type { ComponentPropsWithRef, ReactNode } from "react";
import { parseBody } from "@nexus/authored/body";
import { excerptView, selectedExcerpt } from "@nexus/authored/excerpt";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { MediaTitle } from "@/components/media/MediaIdentity";
import NoteBodyPreview from "@/components/notes/NoteBodyPreview";
import ReaderExcerpt from "@/components/resources/ReaderExcerpt";
import ResourceBody from "@/components/resources/ResourceBody";
import ResourceMetadata from "@/components/resources/ResourceMetadata";
import { ResourceTypeIcon } from "@/components/resources/ResourceType";
import Button from "@/components/ui/Button";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ReaderQuote } from "@/lib/chat/readerIntent";
import { refusal } from "@/lib/chat/wire";
import { formatClock } from "@/lib/formatClock";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { mediaBibliographyMetadata, resourceMetadata } from "@/lib/resources/metadata";
import { itemMediaKind, resourceType } from "@/lib/resources/type";
import { cx } from "@/lib/ui/cx";
import * as Icon from "@/lib/ui/icons";
import { suppressSelectionActivation } from "@/lib/ui/targetActivation";
import { referenceStatus, useLiveReferenceLink } from "./LiveReference";
import styles from "./ReferenceFigure.module.css";

type ResolvedReference = Schema<"AttachmentOut"> | Schema<"ChatCitationOut">;

/** One resolved occurrence. Its host owns placement, density, correspondence and focus. */
export default function ReferenceFigure({ value, className, tabIndex = -1, onClickCapture, ...attributes }: {
  value: ResolvedReference;
} & Omit<ComponentPropsWithRef<"figure">, "children">) {
  const target = "reference" in value ? { kind: "resource", reference: value.reference } as const : value.target;
  return <figure {...attributes} tabIndex={tabIndex} className={cx(styles.figure, className)} onClickCapture={event => {
    if (event.target instanceof Element && event.target.closest("a[href]")) suppressSelectionActivation(event);
    onClickCapture?.(event);
  }}>
    {"ordinal" in value ? <div className={styles.ordinal} aria-label={`reference ${value.ordinal}`}>{value.ordinal}</div> : null}
    {target.kind === "url" ? <>
      <a className={styles.primary} href={target.url} data-reference-control="source" onClick={suppressSelectionActivation}>
        <span data-resource-primary>{target.url}</span>
      </a>
      <figcaption className={styles.attribution}><Icon.Web aria-hidden="true" />{new URL(target.url).hostname}</figcaption>
    </> : <ResourceReferenceContent value={value} reference={target.reference} />}
  </figure>;
}

function ResourceReferenceContent({ value, reference }: { value: ResolvedReference; reference: Schema<"AttachmentOut">["reference"] }) {
  const { item } = value;
  const link = useLiveReferenceLink({ reference, item });
  const status = referenceStatus({ reference, item, locationAvailable: value.location_available });
  const quote = reference.quote ? <ReaderExcerpt excerpt={excerptView(reference.quote.excerpt, "compact", { kind: "capture" })} color={null} /> : null;
  if (item === null || item.missing) return <>
    {quote ? <div data-resource-primary className={styles.primary}>{quote}</div> : null}
    <div data-resource-primary={quote ? undefined : true} className={styles.status}>{status}</div>
  </>;
  const body = item.preview.body;
  const metadata = resourceMetadata({ item });
  const summary = body.kind === "media" ? body.media_summary : value.source;
  const title = summary ? <MediaTitle subject={{ kind: "Stored", summary }} />
    : body.kind === "named" ? body.title || metadata.identity : item.preview.source?.title || metadata.identity;
  const bibliography = value.source ? [...metadata.bibliography.filter(part => part.key === "attribution"), ...mediaBibliographyMetadata(value.source)] : metadata.bibliography;
  const locator = reference.locator;
  const invalidLocator = locator !== null && !value.location_available;
  const annotationPrimary = reference.field === "annotation" && quote === null && !invalidLocator;
  const coarseLocation = locator?.kind === "PdfPage" ? `page ${locator.page_number}`
    : locator?.kind === "PdfPageGeometry" ? `${quote ? "" : "selected region · "}page ${locator.page_number}`
      : locator?.kind === "TimeRange" ? `${formatClock(locator.start_ms / 1000)}–${formatClock(locator.end_ms / 1000)}` : null;
  const identityPrimary = quote === null && (invalidLocator || coarseLocation !== null || (!annotationPrimary && (body.kind === "media" || body.kind === "named")));
  let primary: ReactNode;
  if (quote !== null) primary = quote;
  else if (invalidLocator || coarseLocation !== null) primary = title;
  else if (annotationPrimary) {
    // justify-defect: readable whole-annotation projections always carry their body.
    if (value.annotation === null) throw new Error("readable annotation reference has no annotation");
    primary = <div className={styles.annotation}><Icon.Note aria-hidden="true" /><NoteBodyPreview body={parseBody(value.annotation.body_pm_json)} /></div>;
  } else if (body.kind === "passage") primary = <ReaderExcerpt excerpt={selectedExcerpt(body.excerpt)} color={body.color} full />;
  else primary = <ResourceBody body={body} full />;
  const parts = metadata.parts.filter(part => part.key !== "source" && (coarseLocation === null || part.key !== "location"));
  const attribution = [...bibliography, ...parts];
  const parsed = parseResourceRef(item.ref);
  return <>
    <div className={styles.primary} data-resource-primary>
      {link && !annotationPrimary ? <a {...link} data-reference-control="source" draggable={false}>{primary}</a> : primary}
    </div>
    {!identityPrimary || attribution.length > 0 || coarseLocation !== null ? <figcaption className={styles.attribution}>
      {!identityPrimary ? <>
        {parsed ? <ResourceTypeIcon type={resourceType(parsed.scheme, itemMediaKind(item))} /> : null}
        {annotationPrimary && link ? <a {...link} data-reference-control="source">{title}</a> : title}
      </> : null}
      {!identityPrimary && attribution.length > 0 ? <span aria-hidden="true"> · </span> : null}
      <ResourceMetadata parts={attribution} linkSource />
      {coarseLocation !== null ? <>{!identityPrimary || attribution.length > 0 ? <span aria-hidden="true"> · </span> : null}{coarseLocation}</> : null}
    </figcaption> : null}
    {status ? <div className={styles.status}>{status}</div> : null}
    {!annotationPrimary && value.annotation !== null ? <div className={styles.annotation}>
      <Icon.Note aria-hidden="true" /><NoteBodyPreview body={parseBody(value.annotation.body_pm_json)} />
    </div> : null}
  </>;
}

/** Draft reads wait for committed writing, then use the same server projection as sent references. */
export function DraftReferenceFigure({ quote, onRemove }: { quote: ReaderQuote; onRemove(): void }) {
  const writing = useWritingRuntime();
  const stale = useChangeStamp("Metadata", "Notes", "NoteBodies", "Chats");
  const read = usePaneFreeServerValue({
    key: `draft-reference:${quote.id}`,
    stale,
    load: async signal => {
      await writing.whenUploaded(await writing.committedPrefix(), signal);
      const response = await apiFetch<ApiJson<"/librarian/attachments/resolve", "post">>("/api/librarian/attachments/resolve", {
        method: "POST", body: JSON.stringify({ attachments: [quote.attachment] }), signal,
      });
      // justify-defect: ordered resolution returns one result per submitted reference.
      if (response.data.length !== 1) throw new Error("draft reference resolution returned the wrong count");
      return response.data[0]!;
    },
  });
  let content: ReactNode = <Ruling />;
  if (read.status === "ready") content = <ReferenceFigure value={read.data} />;
  else if (read.status === "failed") {
    if (read.error.code === "E_INVALID_REQUEST") throw read.error;
    const failed = refusal("couldn’t load this quote.", read.error);
    content = failed.error === null ? <Fact line={failed.line} />
      : <Failed error={read.error} noun="this quote" retry={{ run: read.refetch, busy: read.retrying }} />;
  }
  return <div className={styles.draft} data-type-role="margin" role="group" aria-label="attached quote">
    <div className={styles.draftContent}>
      {content}
    </div>
    <Button iconOnly icon={<Icon.Dismiss />} aria-label="remove quote" onClick={onRemove} />
  </div>;
}
